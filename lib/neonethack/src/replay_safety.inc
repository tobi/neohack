/* A persisted input log is never permission to execute shell/suspend/debug
 * commands during resume. The public API has no route to these commands. */
static int
replay_unsafe_answer(game_t *g, const char *line)
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
        (key == '!' || key == 26)) unsafe = 1;
    if (!strcmp(g->pending.kind, "extcmd") && mj_find(result, "index", &value) && mj_int(value, &key) &&
        key >= 0 && (size_t)key < g->pending.ncommands) {
        const char *name = g->pending.commands[key];
        if (!strcmp(name, "shell") || !strcmp(name, "suspend") || !strncmp(name, "wiz", 3)) unsafe = 1;
    }
    free(result);
    return unsafe;
}
