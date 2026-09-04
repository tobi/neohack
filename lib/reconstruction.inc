/* Private operator-only reconstruction. Included by explorer.c so every
 * observation uses the same decoder as live play. The web worker runs this
 * command in a separate OS sandbox; never on the live bridge queue.
 * Input histories are trusted local artifacts, not executable uploads. */
#define RECON_MAX_INPUT (32L * 1024 * 1024)
#define RECON_MAX_ANSWERS 50000
#define RECON_MAX_OUTPUT (256LL * 1024 * 1024)

static int
recon_copy(const char *source, const char *destination, long limit,
           int executable, char fingerprint[32])
{
    int in = -1, out = -1, result = -1;
    struct stat st;
    unsigned char buf[65536];
    ssize_t n;
    uint64_t hash = UINT64_C(14695981039346656037);
    long long total = 0;
    in = open(source, O_RDONLY | O_NOFOLLOW);
    if (in < 0 || fstat(in, &st) || !S_ISREG(st.st_mode) || st.st_size > limit)
        goto done;
    out = open(destination, O_WRONLY | O_CREAT | O_EXCL, executable ? 0700 : 0600);
    if (out < 0) goto done;
    while ((n = read(in, buf, sizeof buf)) > 0) {
        ssize_t off = 0, i;
        total += n;
        if (total > limit) goto done;
        for (i = 0; i < n; i++) { hash ^= buf[i]; hash *= UINT64_C(1099511628211); }
        while (off < n) {
            ssize_t written = write(out, buf + off, (size_t) (n - off));
            if (written <= 0) goto done;
            off += written;
        }
    }
    if (n < 0 || fsync(out)) goto done;
    if (fingerprint) snprintf(fingerprint, 32, "fnv1a64:%016llx", (unsigned long long) hash);
    result = 0;
done:
    if (in >= 0) close(in);
    if (out >= 0) close(out);
    return result;
}

static int
recon_empty_directory(const char *path)
{
    DIR *d = opendir(path);
    struct dirent *entry;
    int empty = 1;
    if (!d) return 0;
    while ((entry = readdir(d)) != NULL)
        if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) { empty = 0; break; }
    closedir(d);
    return empty;
}

/* Validate framing and request shape before starting an engine. IDs are
 * checked again against the pinned engine's actual input boundary at replay. */
static const char *
recon_validate(char **lines, size_t count)
{
    size_t i;
    if (count < 2 || count > RECON_MAX_ANSWERS + 2) return "source answer count is unsupported";
    for (i = 0; i < count; i++) {
        mj_val v, params;
        long long id;
        char *canonical, *method = NULL;
        if (strlen(lines[i]) > 65536 || !mj_valid(lines[i])) return "source contains malformed or oversized JSON";
        canonical = mj_canonical((mj_val) { lines[i] });
        if (!canonical) return "source contains duplicate keys or unsupported JSON nesting";
        free(canonical);
        if (!mj_find(lines[i], "id", &v) || !mj_int(v, &id) || id < 0) return "source has a non-integer input id";
        if (mj_find(lines[i], "method", &v)) method = mj_str(v);
        if (i < 2) {
            const char *want = i ? "new_game" : "initialize";
            if (!method || strcmp(method, want) || id != (long long) i + 1) { free(method); return "source must begin with initialize then new_game"; }
            if (!mj_find(lines[i], "params", &params) || *params.p != '{') { free(method); return "source initialization lacks parameters"; }
            if (i == 1) {
                size_t n;
                const char *raw = mj_raw(params, &n);
                char *object = strndup(raw, n);
                long long seed;
                int seeded = object && mj_find(object, "seed", &v) && mj_int(v, &seed);
                free(object);
                if (!seeded) { free(method); return "source has no explicit seed; historical entropy cannot be reconstructed"; }
            }
        } else {
            if (method) { free(method); return "source contains a method after initialization"; }
            if (!mj_find(lines[i], "result", &v) || *v.p != '{') return "source contains a non-response input";
        }
        free(method);
    }
    return NULL;
}

static int
recon_unsafe_answer(game_t *g, const char *line)
{
    mj_val v, value;
    size_t n;
    const char *raw;
    char *result;
    long long key = -1;
    int unsafe = 0;
    if (!mj_find(line, "result", &v)) return 1;
    raw = mj_raw(v, &n); result = strndup(raw, n);
    if (!result) return 1;
    if ((!strcmp(g->pending.kind, "key") || !strcmp(g->pending.kind, "poskey")) &&
        mj_find(result, "key", &value) && mj_int(value, &key) &&
        (key == '!' || key == 26)) unsafe = 1; /* shell / suspend */
    if (!strcmp(g->pending.kind, "extcmd") && mj_find(result, "index", &value) && mj_int(value, &key) &&
        key >= 0 && (size_t) key < g->pending.ncommands) {
        const char *name = g->pending.commands[key];
        if (!strcmp(name, "shell") || !strcmp(name, "suspend") || !strncmp(name, "wiz", 3)) unsafe = 1;
    }
    free(result);
    return unsafe;
}

static void
recon_show_question(game_t *g)
{
    mj_Buf b;
    size_t i;
    menu_t *m = !strcmp(g->pending.kind, "menu") ? menu_for(g, g->pending.window, 0) : NULL;
    if ((!g->pending.prompt || !*g->pending.prompt) && !m) return;
    mj_init(&b); mj_obj(&b);
    mj_key(&b, "type"); mj_strv(&b, "shown");
    mj_key(&b, "about"); mj_strv(&b, "Historical prompt (read-only)");
    mj_key(&b, "items"); mj_arr(&b);
    if (g->pending.prompt && *g->pending.prompt) mj_strv(&b, g->pending.prompt);
    if (m) {
        if (m->prompt && *m->prompt) mj_strv(&b, m->prompt);
        for (i = 0; i < m->nitems; i++) if (m->items[i].text) mj_strv(&b, m->items[i].text);
    }
    mj_endarr(&b); mj_endobj(&b);
    if (b.ok) push_event(g, b.buf);
    mj_free(&b);
}

static char *
run_reconstruct(nhx_t *x, const char *args)
{
    mj_val v;
    char *id = NULL, *output = NULL, *archive = NULL, *answer = NULL;
    char source_dir[PATH_MAX], source_log[PATH_MAX], source_engine[PATH_MAX];
    char real_source[PATH_MAX], real_root[PATH_MAX], real_output[PATH_MAX];
    char from[PATH_MAX], to[PATH_MAX], copied_engine[PATH_MAX];
    char **lines = NULL;
    size_t nlog = 0, i, expected_lines = 0;
    game_t *source = NULL, *g = NULL;
    nhx_t *work = NULL;
    struct stat before, after;
    const char *code = "invalidReconstruction", *message = "invalid source or output parameters";
    long long event_start = 0, bytes = 0;
    int previous_turn = 0, previous_x = -1, previous_y = -1;
    if (mj_find(args, "sessionId", &v)) id = mj_str(v);
    if (mj_find(args, "outputRoot", &v)) output = mj_str(v);
    if (mj_find(args, "archiveId", &v)) archive = mj_str(v);
    if (!valid_id(id) || !valid_id(archive) || !output || !strcmp(id, archive)) goto cleanup;
    if (!realpath(x->sessions_dir, real_root) ||
        snprintf(source_dir, sizeof source_dir, "%s/%s", real_root, id) >= (int) sizeof source_dir ||
        !realpath(source_dir, real_source) || strcmp(real_source, source_dir) ||
        !realpath(output, real_output)) goto cleanup;
    if (strlen(real_source) > PATH_MAX - 256 || strlen(real_output) > PATH_MAX - 256) {
        message = "source or output path exceeds supported length"; goto cleanup;
    }
    if (!strcmp(real_output, real_root) ||
        (!strncmp(real_output, real_source, strlen(real_source)) &&
         (!real_output[strlen(real_source)] || real_output[strlen(real_source)] == '/')) ||
        !recon_empty_directory(real_output)) {
        message = "output must be a separate, dedicated empty directory"; goto cleanup;
    }
    source = calloc(1, sizeof *source);
    if (!source) { code = "outOfMemory"; goto cleanup; }
    source->lease_fd = -1;
    snprintf(source->id, sizeof source->id, "%s", id);
    snprintf(source->dir, sizeof source->dir, "%s", source_dir);
    if (lease_acquire(source) < 0) {
        answer = lease_error(source, NULL); goto cleanup;
    }
    if (snprintf(source_log, sizeof source_log, "%s/input.log.jsonl", source_dir) >= (int) sizeof source_log ||
        lstat(source_log, &before) || !S_ISREG(before.st_mode) || before.st_size <= 0 || before.st_size > RECON_MAX_INPUT) {
        message = "source input log is missing, non-regular, empty, or over 32 MB"; goto cleanup;
    }
    snprintf(source_engine, sizeof source_engine, "%s/engine", source_dir);
    if (lstat(source_engine, &after) && errno == ENOENT)
        snprintf(source_engine, sizeof source_engine, "%s/playground/nethack", source_dir);
    if (lstat(source_engine, &after) || !S_ISREG(after.st_mode) || access(source_engine, X_OK)) {
        code = "missingEngine"; message = "source has no pinned engine; the current engine is not a substitute"; goto cleanup;
    }
    snprintf(from, sizeof from, "%s/playground", source_dir);
    work = nhx_open(source_engine, from, real_output);
    if (!work || !(g = game_get(work, archive, 1))) { code = "storageError"; message = "cannot create isolated output"; goto cleanup; }
    if (lease_acquire(g) < 0) { code = "storageError"; message = "cannot own isolated output"; goto cleanup; }
    g->recording_only = 1;
    snprintf(g->reconstruction_source, sizeof g->reconstruction_source, "%s", id);
    snprintf(to, sizeof to, "%s/input.log.jsonl", g->dir);
    if (recon_copy(source_log, to, RECON_MAX_INPUT, 0, g->reconstruction_input_hash)) { code = "storageError"; message = "could not freeze input log"; goto cleanup; }
    if (stat(source_log, &after) || before.st_size != after.st_size ||
        before.st_mtim.tv_sec != after.st_mtim.tv_sec || before.st_mtim.tv_nsec != after.st_mtim.tv_nsec) {
        code = "sourceChanged"; message = "source changed during capture; leave its owner before retrying"; goto cleanup;
    }
    /* Reject embedded NULs/torn final lines before log_read normalizes framing. */
    {
        FILE *f = fopen(to, "rb");
        int c, last = '\n', invalid = 0, has_bytes = 0;
        if (!f) { code = "storageError"; goto cleanup; }
        while ((c = fgetc(f)) != EOF) {
            if (!c) invalid = 1;
            if (c == '\n') { if (has_bytes) expected_lines++; has_bytes = 0; }
            else if (c != '\r') has_bytes = 1;
            last = c;
        }
        if (ferror(f) || last != '\n') invalid = 1;
        fclose(f);
        if (invalid) { message = "source contains NUL bytes or an incomplete final line"; goto cleanup; }
    }
    lines = log_read(g, &nlog);
    message = lines && nlog == expected_lines ? recon_validate(lines, nlog) : "source log could not be read completely";
    if (message) goto cleanup;
    g->reconstruction_total = (long long) nlog - 2;
    if (mkdir_p(g->playground)) { code = "storageError"; message = "cannot create scratch playground"; goto cleanup; }
    {
        static const char *const assets[] = { "nhdat", "sysconf", "symbols", "license", NULL };
        for (i = 0; assets[i]; i++) {
            snprintf(from, sizeof from, "%s/playground/%s", source_dir, assets[i]);
            snprintf(to, sizeof to, "%s/%s", g->playground, assets[i]);
            if (recon_copy(from, to, 128L * 1024 * 1024, 0, i == 0 ? g->reconstruction_data_hash : NULL)) {
                code = "missingData"; message = "source static data is missing; no current-data substitution was made"; goto cleanup;
            }
        }
    }
    {
        static const char *const empty[] = { "perm", "record", "logfile", "livelog", "xlogfile", NULL };
        for (i = 0; empty[i]; i++) {
            int fd;
            snprintf(to, sizeof to, "%s/%s", g->playground, empty[i]);
            fd = open(to, O_WRONLY | O_CREAT | O_EXCL, 0600);
            if (fd < 0) { code = "storageError"; message = "cannot create scratch data"; goto cleanup; }
            close(fd);
        }
        snprintf(to, sizeof to, "%s/save", g->playground);
        if (mkdir_p(to)) { code = "storageError"; goto cleanup; }
    }
    snprintf(copied_engine, sizeof copied_engine, "%s/engine", g->dir);
    if (recon_copy(source_engine, copied_engine, 128L * 1024 * 1024, 1, g->reconstruction_engine_hash)) {
        code = "storageError"; message = "could not freeze source engine"; goto cleanup;
    }
    /* Old save files, bones, lock files, and levels were deliberately not copied. */
    g->eng = nh_session_start_with_lease(copied_engine, g->playground, NULL, g->lease_fd);
    if (!g->eng) { code = "engineError"; message = "source engine could not start"; goto cleanup; }
    g->replaying = 1;
    g->deadline_ms = monotonic_ms() + 180000;
    if (send_raw(g, lines[0]) || send_raw(g, lines[1])) { code = "engineError"; message = "initialization failed"; goto cleanup; }
    for (i = 2; ; i++) {
        int ready = await_prompt(g, 10000);
        if (ready < 0) { code = "reconstructionTimeout"; message = "pinned engine did not reach a bounded input boundary"; goto cleanup; }
        g->revision = (long long) i - 2;
        g->reconstruction_step = (long long) i - 2;
        if (g->have_you && turn_of(g) >= 1) {
            char request[128], *frame;
            int changed = previous_x >= 0 && (previous_x != g->you_x || previous_y != g->you_y);
            recon_show_question(g);
            snprintf(request, sizeof request, "{\"tool\":\"reconstruction\",\"sourceStep\":%zu}", i - 2);
            frame = envelope(g, NULL, "recordedStep", "completed", NULL,
                             previous_turn ? turn_of(g) - previous_turn : 0, changed,
                             NULL, 0, event_start, 0, 0, NULL, NULL);
            if (!frame) { code = "outOfMemory"; message = "cannot encode checkpoint"; goto cleanup; }
            bytes += (long long) strlen(frame);
            if (bytes > RECON_MAX_OUTPUT || record_frame(g, request, frame)) {
                free(frame); code = "recordingLimit"; message = "output exceeded its budget or could not be committed"; goto cleanup;
            }
            free(frame);
            previous_turn = turn_of(g); previous_x = g->you_x; previous_y = g->you_y;
            event_start = g->event_seq;
        }
        if (i == nlog) break;
        if (!ready || g->ended) { code = "replayDiverged"; message = "engine ended before consuming the stored answers"; goto cleanup; }
        {
            long long stored_id;
            if (!mj_find(lines[i], "id", &v) || !mj_int(v, &stored_id) || stored_id != g->pending.id) {
                code = "replayDiverged"; message = "stored answer id does not match the pinned engine's input boundary"; goto cleanup;
            }
        }
        if (recon_unsafe_answer(g, lines[i])) { code = "unsupportedHistoricalCommand"; message = "shell, suspend and debug commands are not reconstructed"; goto cleanup; }
        if (send_raw(g, lines[i])) { code = "engineError"; message = "could not deliver stored answer"; goto cleanup; }
        pending_clear(g);
    }
    if (!g->frame_count) { code = "noPerception"; message = "source never produced a visible world"; goto cleanup; }
    {
        mj_Buf b;
        mj_init(&b); mj_obj(&b);
        mj_key(&b, "archiveId"); mj_strv(&b, g->id);
        mj_key(&b, "frames"); mj_intv(&b, g->frame_count);
        mj_key(&b, "turn"); mj_intv(&b, turn_of(g));
        emit_provenance(g, &b);
        mj_endobj(&b); answer = mj_take(&b);
    }
cleanup:
    if (!answer) answer = fail_envelope(id ? id : "", NULL, code, message ? message : "reconstruction failed");
    for (i = 0; i < nlog; i++) free(lines[i]);
    free(lines);
    if (work) nhx_close(work); /* child exits and drops its output lease before publication */
    if (source) { lease_release(source); free(source); }
    free(id); free(output); free(archive);
    return answer;
}
