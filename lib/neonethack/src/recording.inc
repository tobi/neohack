/* The checkpoint journal is authoritative; its index and run.json are caches.
 * Recovery never rewrites checkpoint or input bytes. A torn/corrupt journal
 * blocks new input and needs explicit operator salvage, not silent truncation. */
#define RECORD_MAX_LINE (8U * 1024U * 1024U)
#define RECORD_MAX_BYTES (8LL * 1024LL * 1024LL * 1024LL)
#define RECORD_MAX_FRAMES 100000

static int
record_error(game_t *g, const char *message)
{
    snprintf(g->recording_error, sizeof g->recording_error, "%s", message);
    g->recording_ready = 0;
    return -1;
}

static int
record_dir_sync(game_t *g)
{
    int fd = open(g->dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC), result;
    if (fd < 0) return -1;
    result = fsync(fd); close(fd); return result;
}

static int
record_regular(const char *path, int flags)
{
    struct stat st;
    int fd = open(path, flags | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0600);
    if (fd < 0) return -1;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_nlink != 1) {
        close(fd); errno = EINVAL; return -1;
    }
    return fd;
}

static int
record_same(const struct stat *a, const struct stat *b)
{
#ifdef __APPLE__
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_size == b->st_size &&
        a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
        a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
#else
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_size == b->st_size &&
        a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
        a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
#endif
}

/* Read a bounded LF-committed record. Partial lines are never receipts. */
static int
record_line(FILE *f, char **line, size_t *length)
{
    size_t n = 0, cap = 4096;
    int c;
    char *text = malloc(cap);
    if (!text) return -1;
    while ((c = fgetc(f)) != EOF) {
        if (!c || n >= RECORD_MAX_LINE) { free(text); return -1; }
        if (n + 2 > cap) {
            char *next = realloc(text, cap * 2);
            if (!next) { free(text); return -1; }
            text = next; cap *= 2;
        }
        text[n++] = (char) c;
        if (c == '\n') { text[n] = 0; *line = text; *length = n; return 1; }
    }
    free(text);
    return n || ferror(f) ? -1 : 0;
}

static int
record_is(mj_val v, const char *expected)
{
    char *s = mj_str(v);
    int same = s && !strcmp(s, expected);
    free(s); return same;
}

static int
record_validate(game_t *g, const char *line, long long sequence,
                long long *turn, long long *revision, long long *through, int *gap)
{
    mj_val v, response, observation;
    long long n;
    char *canonical;
    *through = -1; *gap = 0;
    if (!mj_valid(line)) return 0;
    canonical = mj_canonical((mj_val) { line });
    if (!canonical) return 0; /* Ambiguous keys cannot be authoritative receipts. */
    free(canonical);
    if (
        !mj_find(line, "format", &v) || !record_is(v, "neonethack.perception") ||
        !mj_find(line, "version", &v) || !mj_int(v, &n) || n != 1 ||
        !mj_find(line, "sequence", &v) || !mj_int(v, &n) || n != sequence ||
        !mj_find(line, "recordedAt", &v) || !mj_int(v, &n) || n < 0 ||
        !mj_find(line, "request", &v) || *v.p != '{' ||
        !mj_find(line, "response", &response) || *response.p != '{' ||
        !mj_find(response.p, "sessionId", &v) || !record_is(v, g->id) ||
        !mj_find(response.p, "revision", &v) || !mj_int(v, revision) || *revision < 0 ||
        !mj_find(response.p, "events", &v) || *v.p != '[' ||
        !mj_find(response.p, "observation", &observation) || *observation.p != '{' ||
        !mj_find(observation.p, "turn", &v) || !mj_int(v, turn) || *turn < 0 ||
        !mj_find(observation.p, "world", &v) || *v.p != '[' ||
        !mj_find(observation.p, "inventory", &v) || *v.p != '[') return 0;
    if (mj_find(line, "requestsThrough", &v) && (!mj_int(v, through) || *through < 0)) return 0;
    if (mj_find(line, "gapBefore", &v) && !mj_bool(v, gap)) return 0;
    return 1;
}

/* before_input distinguishes an unrecorded earlier request from the current
 * request which is still being committed by record_frame. */
static int
record_prepare(game_t *g, int before_input)
{
#ifdef __EMSCRIPTEN__
    /* The host has already committed the exact public request before C runs.
     * Its input log replaces observation archives, not input/receipt guards. */
    if (nnh_protocol_journal()) {g->recording_ready=1;return 0;}
#endif
    char data[PATH_MAX], index[PATH_MAX], meta[PATH_MAX], temp[PATH_MAX], *line = NULL;
    struct stat ds, is, after;
    FILE *in = NULL, *out = NULL;
    int fd = -1, tfd = -1, result = -1, read_result, gap, created = 0;
    long long count = 0, bytes = 0, turn = 0, revision = 0, through = -1, gaps = 0;
    size_t length;
    if (g->lease_fd < 0) return record_error(g, "Recording requires exclusive ownership");
    if (before_input && (g->frame_count >= RECORD_MAX_FRAMES || g->recording_bytes > RECORD_MAX_BYTES - RECORD_MAX_LINE))
        return record_error(g, "Recording limit reached; no new deed was sent");
    if (snprintf(data, sizeof data, "%s/perceptions.jsonl", g->dir) >= (int) sizeof data ||
        snprintf(index, sizeof index, "%s/perceptions.index.jsonl", g->dir) >= (int) sizeof index ||
        snprintf(meta, sizeof meta, "%s/run.json", g->dir) >= (int) sizeof meta ||
        snprintf(temp, sizeof temp, "%s/.perception-index-XXXXXX", g->dir) >= (int) sizeof temp)
        return record_error(g, "Recording path exceeds limit");
    fd = record_regular(data, O_RDWR | O_CREAT);
    if (fd < 0) return record_error(g, "Cannot open regular checkpoint journal");
    if (fstat(fd, &ds) || ds.st_size > RECORD_MAX_BYTES) goto done;
    if (lstat(index, &is)) {
        if (errno != ENOENT) goto done;
        memset(&is, 0, sizeof is);
    } else if (!S_ISREG(is.st_mode) || is.st_nlink != 1) goto done;
    {
        struct stat metadata;
        if (lstat(meta, &metadata)) { if (errno != ENOENT) goto done; }
        else if (!S_ISREG(metadata.st_mode) || metadata.st_nlink != 1) goto done;
    }
    if (g->recording_ready && record_same(&ds, &g->recording_data_stat) &&
        record_same(&is, &g->recording_index_stat)) { result = 0; goto done; }
    if (g->recording_ready && ds.st_size < g->recording_bytes) {
        record_error(g, "Checkpoint journal shrank; original bytes must be recovered"); goto done;
    }
    g->recording_ready = 0;
    in = fdopen(fd, "r"); if (!in) goto done; fd = -1;
    tfd = mkstemp(temp); if (tfd < 0) goto done;
    created = 1;
    fcntl(tfd, F_SETFD, FD_CLOEXEC);
    out = fdopen(tfd, "w"); if (!out) goto done; tfd = -1;
    while ((read_result = record_line(in, &line, &length)) == 1) {
        if (count >= RECORD_MAX_FRAMES || !record_validate(g, line, count, &turn, &revision, &through, &gap)) {
            record_error(g, "Corrupt checkpoint journal; no bytes were changed"); goto done;
        }
        if (fprintf(out, "{\"sequence\":%lld,\"offset\":%lld,\"length\":%zu,\"turn\":%lld,\"revision\":%lld,\"gapBefore\":%s}\n",
            count, bytes, length, turn, revision, gap ? "true" : "false") < 0) goto done;
        bytes += (long long) length; count++; gaps += gap;
        free(line); line = NULL;
    }
    if (read_result < 0 || fstat(fileno(in), &after) || !record_same(&ds, &after) || bytes != ds.st_size) {
        record_error(g, "Incomplete or changing checkpoint journal; preserve it for explicit salvage"); goto done;
    }
    if (g->frame_count > count) {
        record_error(g, "Checkpoint journal is shorter than its committed high-water mark"); goto done;
    }
    if (before_input && (count >= RECORD_MAX_FRAMES || bytes > RECORD_MAX_BYTES - RECORD_MAX_LINE)) {
        record_error(g, "Recording limit reached; no new deed was sent"); goto done;
    }
    if (fflush(out) || fsync(fileno(out)) || fsync(fileno(in))) goto done;
    if (fclose(out)) { out = NULL; goto done; } out = NULL;
    if (rename(temp, index) || record_dir_sync(g)) goto done;
    if (count > g->frame_count && through >= (long long) g->nrequests && revision >= g->revision)
        g->recording_gap = 0; /* The previously uncertain append survived whole. */
    g->frame_count = count; g->recording_bytes = bytes; g->recording_gaps = gaps;
    if (before_input && ((count && g->revision > revision) ||
        (through >= 0 && (long long) g->nrequests > through))) g->recording_gap = 1;
    if (revision > g->revision) g->revision = revision;
    if (lstat(data, &g->recording_data_stat) || !record_same(&ds, &g->recording_data_stat) ||
        lstat(index, &g->recording_index_stat)) goto done;
    g->recording_ready = 1; g->recording_error[0] = 0;
    result = 0;
done:
    free(line);
    if (in) fclose(in); else if (fd >= 0) close(fd);
    if (out) fclose(out); else if (tfd >= 0) close(tfd);
    if (created) unlink(temp);
    if (result < 0 && !g->recording_error[0]) record_error(g, "Cannot reconcile recording caches; no new deed was sent");
    return result;
}

static int
record_frame(game_t *g, const char *request, const char *response)
{
#ifdef __EMSCRIPTEN__
    if (nnh_protocol_journal()) {
        mj_val id;
        if(mj_find(request,"requestId",&id)){
            char *rid=mj_str(id);req_entry_t *entry=rid?req_lookup(g,rid):NULL;
            if(entry&&entry->result&&!strcmp(entry->result,response))entry->checkpointed=1;
            free(rid);
        }
        g->frame_count++;g->recording_gap=0;
        return sidecar_save(g);
    }
#endif
    char data[PATH_MAX], index[PATH_MAX], meta[PATH_MAX], temp[PATH_MAX];
    FILE *f = NULL;
    mj_Buf b;
    struct timespec now;
    long long ms, offset, length, sequence;
    int fd, ok;
    if (record_prepare(g, 0)) { g->recording_gap = 1; sidecar_save(g); return -1; }
    clock_gettime(CLOCK_REALTIME, &now);
    ms = (long long) now.tv_sec * 1000 + now.tv_nsec / 1000000;
    offset = g->recording_bytes; sequence = g->frame_count;
    if (snprintf(data, sizeof data, "%s/perceptions.jsonl", g->dir) >= (int) sizeof data ||
        snprintf(index, sizeof index, "%s/perceptions.index.jsonl", g->dir) >= (int) sizeof index ||
        snprintf(meta, sizeof meta, "%s/run.json", g->dir) >= (int) sizeof meta ||
        snprintf(temp, sizeof temp, "%s/.run-meta-XXXXXX", g->dir) >= (int) sizeof temp) goto data_failed;
    fd = record_regular(data, O_WRONLY | O_APPEND);
    if (fd < 0) goto data_failed;
    {
        struct stat current;
        if (fstat(fd, &current) || !record_same(&current, &g->recording_data_stat)) {
            close(fd); goto data_failed;
        }
    }
    f = fdopen(fd, "a"); if (!f) { close(fd); goto data_failed; }
    mj_init(&b); mj_obj(&b);
    mj_key(&b, "format"); mj_strv(&b, "neonethack.perception");
    mj_key(&b, "version"); mj_intv(&b, 1);
    mj_key(&b, "sequence"); mj_intv(&b, sequence);
    mj_key(&b, "recordedAt"); mj_intv(&b, ms);
    mj_key(&b, "requestsThrough"); mj_intv(&b, (long long) g->nrequests);
    if (g->recording_gap) { mj_key(&b, "gapBefore"); mj_boolv(&b, 1); }
    mj_key(&b, "request"); mj_rawv(&b, request);
    mj_key(&b, "response"); mj_rawv(&b, response);
    mj_endobj(&b);
    length = (long long) b.len + 1;
    ok = b.ok && mj_valid(b.buf) && sequence < RECORD_MAX_FRAMES && length <= RECORD_MAX_LINE && offset + length <= RECORD_MAX_BYTES &&
        fputs(b.buf, f) >= 0 && fputc('\n', f) != EOF && fflush(f) == 0 && fsync(fileno(f)) == 0;
    if (fclose(f)) ok = 0;
    f = NULL; mj_free(&b);
    if (!ok) goto data_failed;
    /* Compact only duplicate receipts whose exact bytes just became durable.
     * An uncheckpointed receipt must remain in the sidecar across failures.
     * Reservations stay forever; cold retries use req_saved_result's validated
     * journal lookup when the sidecar no longer contains a hot response. */
    {
        mj_val id;
        if (mj_find(request, "requestId", &id)) {
            char *rid = mj_str(id);
            req_entry_t *entry = rid ? req_lookup(g, rid) : NULL;
            if (entry && entry->result && !strcmp(entry->result, response))
                entry->checkpointed = 1;
            free(rid);
        }
    }
    /* Data committed: never reuse this sequence merely because a cache fails. */
    g->frame_count++; g->recording_bytes += length;
    g->recording_gaps += g->recording_gap; g->recording_gap = 0;
    g->recording_ready = 0;
    if (sidecar_save(g)) goto cache_failed;
    fd = record_regular(index, O_WRONLY | O_APPEND);
    if (fd < 0) goto cache_failed;
    f = fdopen(fd, "a"); if (!f) { close(fd); goto cache_failed; }
    ok = fprintf(f, "{\"sequence\":%lld,\"offset\":%lld,\"length\":%lld,\"turn\":%d,\"revision\":%lld}\n",
                 sequence, offset, length, turn_of(g), g->revision) > 0;
    if (fflush(f) || fsync(fileno(f))) ok = 0;
    if (fclose(f)) ok = 0;
    f = NULL;
    if (!ok) goto cache_failed;
    fd = mkstemp(temp); if (fd < 0) goto cache_failed;
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    f = fdopen(fd, "w"); if (!f) { close(fd); unlink(temp); goto cache_failed; }
    mj_init(&b); mj_obj(&b);
    mj_key(&b, "format"); mj_strv(&b, "neonethack.perception");
    mj_key(&b, "version"); mj_intv(&b, 1);
    mj_key(&b, "sessionId"); mj_strv(&b, g->id);
    mj_key(&b, "title"); mj_strv(&b, g->status[0] ? g->status[0] : "Explorer");
    mj_key(&b, "turn"); mj_intv(&b, turn_of(g));
    mj_key(&b, "revision"); mj_intv(&b, g->revision);
    mj_key(&b, "frames"); mj_intv(&b, g->frame_count);
    mj_key(&b, "bytes"); mj_intv(&b, g->recording_bytes);
    mj_key(&b, "gaps"); mj_intv(&b, g->recording_gaps);
    mj_key(&b, "updatedAt"); mj_intv(&b, ms);
    mj_key(&b, "depth"); mj_strv(&b, g->status[20] ? g->status[20] : "unknown");
    mj_key(&b, "ended"); mj_boolv(&b, g->ended || g->terminal_kind[0]);
    emit_end(g, &b); emit_provenance(g, &b);
    mj_endobj(&b);
    ok = b.ok && fputs(b.buf, f) >= 0 && fflush(f) == 0 && fsync(fileno(f)) == 0;
    if (fclose(f)) ok = 0;
    f = NULL; mj_free(&b);
    if (!ok || rename(temp, meta)) { unlink(temp); goto cache_failed; }
    if (record_dir_sync(g)) goto cache_failed;
    if (lstat(data, &g->recording_data_stat) || lstat(index, &g->recording_index_stat)) goto cache_failed;
    g->recording_ready = 1; g->recording_error[0] = 0;
    return 0;
data_failed:
    g->recording_gap = 1;
    sidecar_save(g);
    return record_error(g, "Checkpoint was not durably committed; do not repeat the deed with a new request id");
cache_failed:
    return record_error(g, "Checkpoint committed but index/metadata failed; fix storage and resume to reconcile the caches");
}

/* Recording health is live diagnostic metadata, not the immutable deed receipt. */
static char *
record_health(game_t *g, char *response)
{
    mj_Buf b;
    char *out;
    size_t n;
    if (!g || !response || !g->recording_error[0]) return response;
    n = strlen(response);
    if (!n || response[n - 1] != '}') return response;
    mj_init(&b); mj_obj(&b);
    mj_key(&b, "status"); mj_strv(&b, "degraded");
    mj_key(&b, "message"); mj_strv(&b, g->recording_error);
    mj_key(&b, "requiresResume"); mj_boolv(&b, 1);
    mj_endobj(&b);
    out = b.ok ? malloc(n + b.len + 16) : NULL;
    if (out) {
        memcpy(out, response, n - 1);
        snprintf(out + n - 1, b.len + 17, ",\"recording\":%s}", b.buf);
        free(response); response = out;
    }
    mj_free(&b); return response;
}
