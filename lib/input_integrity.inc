/* Bounded committed input journals. Shared by interactive resume and isolated
 * reconstruction. Validation never completes, drops or rewrites stored bytes. */
#define INPUT_MAX_BYTES (128LL * 1024 * 1024)
#define INPUT_MAX_LINES 1000000
#define INPUT_MAX_LINE 65536

static int
stored_string(mj_val v, size_t min, size_t max)
{
    char *s = mj_str(v);
    int ok = s && strlen(s) >= min && strlen(s) <= max;
    free(s); return ok;
}

static int
stored_integer(mj_val v, long long min, long long max)
{
    long long n;
    return mj_int(v, &n) && n >= min && n <= max;
}

static int
input_result_shape(const char *result)
{
    static const char *const fields[] = { "key", "x", "y", "mod", "answer", "line", "index", "picks", "counts", "cancelled", NULL };
    mj_val v;
    size_t i;
    if (!request_fields(result, fields)) return 0;
    for (i = 0; fields[i]; i++) {
        if (!mj_find(result, fields[i], &v)) continue;
        if (i < 4 && !stored_integer(v, 0, 255)) return 0;
        if (i == 4 && !stored_string(v, 1, 1)) return 0;
        if (i == 5 && !stored_string(v, 0, 255)) return 0;
        if (i == 6 && !stored_integer(v, -1, 4096)) return 0;
        if (i == 7 || i == 8) {
            mj_arr_it it = { 0 }; mj_val item; size_t n = 0;
            if (*v.p != '[') return 0;
            it.first = 1;
            while (mj_arr_next(v.p, &it, &item))
                if (++n > 1024 || !stored_integer(item, i == 7 ? 0 : -1, 2147483647)) return 0;
        }
        if (i == 9) { int flag; if (!mj_bool(v, &flag)) return 0; }
    }
    {
        mj_val key, answer, text, index, picks, counts, cancelled;
        int has_key = mj_find(result, "key", &key), has_answer = mj_find(result, "answer", &answer),
            has_text = mj_find(result, "line", &text), has_index = mj_find(result, "index", &index),
            has_picks = mj_find(result, "picks", &picks), has_counts = mj_find(result, "counts", &counts),
            has_cancel = mj_find(result, "cancelled", &cancelled);
        if (has_key + has_answer + has_text + has_index + !!(has_picks || has_counts || has_cancel) > 1) return 0;
        if (!has_key && (mj_find(result, "x", &v) || mj_find(result, "y", &v) || mj_find(result, "mod", &v))) return 0;
        if (has_counts && !has_picks) return 0;
        if (has_cancel) { int yes = 0; mj_bool(cancelled, &yes); if (!yes && !has_picks) return 0; }
        if (has_picks) {
            mj_arr_it it = { 0 }; mj_val item; size_t n = 0, m = 0, j; long long seen[1024], value;
            it.first = 1;
            while (mj_arr_next(picks.p, &it, &item)) {
                mj_int(item, &value);
                for (j = 0; j < n; j++) if (seen[j] == value) return 0;
                seen[n++] = value;
            }
            if (has_counts) { memset(&it, 0, sizeof it); it.first = 1; while (mj_arr_next(counts.p, &it, &item)) m++; }
            if (m && m != n) return 0;
            if (has_cancel) { int yes = 0; mj_bool(cancelled, &yes); if (yes && n) return 0; }
        }
    }
    return 1;
}

static const char *
input_validate_range(char **lines, size_t count, size_t start)
{
    static const char *const header[] = { "jsonrpc", "id", "method", "params", NULL };
    static const char *const reply[] = { "jsonrpc", "id", "result", NULL };
    static const char *const init[] = { "protocolVersion", NULL };
    static const char *const game[] = { "role", "race", "gender", "align", "name", "seed", NULL };
    size_t i;
    if (count > INPUT_MAX_LINES || start > INPUT_MAX_LINES - count) return "unsupported input count";
    for (i = 0; i < count; i++) {
        size_t at = start + i;
        mj_val v, params; long long id; char *canonical;
        if (strlen(lines[i]) > INPUT_MAX_LINE || !mj_valid(lines[i])) return "malformed or oversized input JSON";
        canonical = mj_canonical((mj_val) { lines[i] });
        if (!canonical) return "duplicate keys or unsupported JSON nesting";
        free(canonical);
        if (!request_fields(lines[i], at < 2 ? header : reply) ||
            !mj_find(lines[i], "id", &v) || !mj_int(v, &id) || id < 0 || id > 9007199254740991LL)
            return "invalid input envelope";
        if (mj_find(lines[i], "jsonrpc", &v) && !record_is(v, "2.0")) return "unsupported JSON-RPC version";
        if (at < 2) {
            if (id != (long long) at + 1 || !mj_find(lines[i], "method", &v) || !record_is(v, at ? "new_game" : "initialize") ||
                !mj_find(lines[i], "params", &params) || *params.p != '{' || !request_fields(params.p, at ? game : init))
                return "history must begin with initialize then new_game";
            if (at == 0) {
                char *protocol;
                int compatible;
                if (!mj_find(params.p, "protocolVersion", &v) || !stored_string(v, 1, 32)) return "invalid protocol initialization";
                protocol = mj_str(v);
                compatible = protocol && protocol[0] == '0' && (!protocol[1] || protocol[1] == '.');
                free(protocol);
                if (!compatible) return "unsupported recorded protocol version";
            } else {
                static const char *const identity[] = { "role", "race", "gender", "align", NULL };
                static const int maximum[] = { 12, 4, 1, 2 };
                size_t k;
                if (!mj_find(params.p, "seed", &v) || !stored_integer(v, -9007199254740991LL, 9007199254740991LL)) return "history requires an explicit safe integer seed";
                if (mj_find(params.p, "name", &v) && !stored_string(v, 0, 255)) return "invalid recorded name";
                for (k = 0; identity[k]; k++)
                    if (mj_find(params.p, identity[k], &v) && !stored_integer(v, -1, maximum[k])) return "invalid recorded identity";
            }
        } else if (!mj_find(lines[i], "result", &v) || *v.p != '{' || !input_result_shape(v.p)) return "invalid input response shape";
    }
    return NULL;
}

static const char *
input_validate(char **lines, size_t count)
{
    if (count < 2) return "history requires both initialization messages";
    return input_validate_range(lines, count, 0);
}

/* Check the shape against the actual waiting input too. Missing fields must
 * never be interpreted by the engine as its default answer (possibly yes). */
static int
input_matches_prompt(game_t *g, const char *line)
{
    static const char *const empty[] = { NULL };
    static const char *const key[] = { "key", "x", "y", "mod", NULL };
    static const char *const answer[] = { "answer", NULL };
    static const char *const text[] = { "line", NULL };
    static const char *const command[] = { "index", NULL };
    static const char *const menu[] = { "picks", "counts", "cancelled", NULL };
    mj_val v, value; long long id;
    if (!mj_find(line, "id", &v) || !mj_int(v, &id) || id != g->pending.id ||
        !mj_find(line, "result", &v) || *v.p != '{') return 0;
    if (!strcmp(g->pending.kind, "ack")) return request_fields(v.p, empty);
    if (!strcmp(g->pending.kind, "msgmenu")) return request_fields(v.p, empty) || (request_fields(v.p, answer) && mj_find(v.p, "answer", &value));
    if (!strcmp(g->pending.kind, "key") || !strcmp(g->pending.kind, "poskey")) return request_fields(v.p, key) && mj_find(v.p, "key", &value);
    if (!strcmp(g->pending.kind, "yn")) {
        char *selected; int offered;
        if (!request_fields(v.p, answer) || !mj_find(v.p, "answer", &value)) return 0;
        selected = mj_str(value);
        offered = selected && selected[0] && (!g->pending.choices || !g->pending.choices[0] ||
            (unsigned char) selected[0] == 27 || strchr(g->pending.choices, selected[0]));
        free(selected); return offered;
    }
    if (!strcmp(g->pending.kind, "getlin")) return request_fields(v.p, text) && mj_find(v.p, "line", &value);
    if (!strcmp(g->pending.kind, "extcmd")) {
        long long index;
        return request_fields(v.p, command) && mj_find(v.p, "index", &value) && mj_int(value, &index) &&
            (index == -1 || (index >= 0 && (size_t) index < g->pending.ncommands));
    }
    if (!strcmp(g->pending.kind, "menu")) {
        mj_arr_it it = { 0 }; mj_val pick; size_t n = 0, i, k; int cancelled = 0;
        if (!request_fields(v.p, menu)) return 0;
        if (mj_find(v.p, "cancelled", &value) && mj_bool(value, &cancelled) && cancelled) return 1;
        if (!mj_find(v.p, "picks", &value)) return 0;
        it.first = 1;
        while (mj_arr_next(value.p, &it, &pick)) {
            long long index; int offered = 0;
            if (!mj_int(pick, &index) || g->pending.how == 0 || (g->pending.how != 2 && ++n > 1)) return 0;
            for (i = 0; i < MAX_MENU_WINDOWS; i++) {
                menu_t *m = &g->menus[i];
                if (!m->used || m->window != g->pending.window) continue;
                for (k = 0; k < m->nitems; k++)
                    if (m->items[k].index == index && m->items[k].accel > 0) offered = 1;
            }
            /* Match the options this core actually offers. Legacy rows lacking
             * a selectable accelerator are not guessed into actionable items. */
            if (!offered) return 0;
        }
        return 1;
    }
    return 0;
}
