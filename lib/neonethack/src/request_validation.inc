/* Public request shapes, checked before dispatch/reservation/operation changes.
 * Engine prompt semantics remain in run_reply/drive_loop. Historical raw input
 * replay is intentionally not routed through this public request validator. */
static const char *
request_ws(const char *p)
{
    while (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t') p++;
    return p;
}

/* Literal protocol field names only. Reject unknown/duplicate/escaped keys,
 * including nested selector objects, rather than choosing one interpretation. */
static int
request_fields(const char *json, const char *const *allowed)
{
    const char *p = request_ws(json), *end;
    unsigned seen = 0;
    if (*p++ != '{') return 0;
    for (;;) {
        size_t i, n, length;
        mj_val v;
        p = request_ws(p);
        if (*p == '}') return 1;
        if (*p++ != '"' || !(end = strchr(p, '"'))) return 0;
        n = (size_t) (end - p);
        for (i = 0; allowed[i]; i++)
            if (strlen(allowed[i]) == n && !memcmp(p, allowed[i], n)) break;
        if (!allowed[i] || i >= 32 || (seen & (1U << i))) return 0;
        seen |= 1U << i;
        p = request_ws(end + 1);
        if (*p++ != ':') return 0;
        v.p = request_ws(p);
        mj_raw(v, &length);
        p = request_ws(v.p + length);
        if (*p == '}') return 1;
        if (*p++ != ',') return 0;
    }
}

static int
request_string(mj_val v, size_t min, size_t max, char *copy)
{
    char *s = mj_str(v);
    size_t i, n;
    if (!s) return 0;
    n = strlen(s);
    if (n < min || n > max || (min && strspn(s, " ") == n)) { free(s); return 0; }
    for (i = 0; i < n; i++)
        if ((unsigned char) s[i] < 32 || (unsigned char) s[i] == 127) {
            free(s); return 0;
        }
    if (copy) memcpy(copy, s, n + 1);
    free(s);
    return 1;
}

static int
request_integer(mj_val v, long long min, long long max)
{
    long long n;
    return mj_int(v, &n) && n >= min && n <= max;
}

static int
request_item(mj_val v)
{
    static const char *const fields[] = { "id", NULL };
    mj_val id;
    if (*v.p == '"') return request_string(v, 1, 127, NULL);
    return request_fields(v.p, fields) && mj_find(v.p, "id", &id) &&
        request_string(id, 1, 64, NULL);
}

/* Returns compass/vertical code, 46=self, 0=here, -1=invalid. */
static int
request_target(mj_val v)
{
    static const char *const fields[] = { "direction", NULL };
    char text[32];
    mj_val direction;
    if (*v.p == '"') {
        if (!request_string(v, 1, 31, text)) return -1;
        return !strcmp(text, "self") ? 46 : !strcmp(text, "here") ? 0 : -1;
    }
    if (!request_fields(v.p, fields) || !mj_find(v.p, "direction", &direction) ||
        !request_string(direction, 1, 31, text)) return -1;
    return move_code(text);
}

static int
request_choices(mj_val v)
{
    long long values[64], value;
    size_t n = 0, i;
    mj_arr_it it = { 0 };
    mj_val element;
    if (*v.p != '[') return request_integer(v, 0, 2147483647);
    it.first = 1;
    while (mj_arr_next(v.p, &it, &element)) {
        if (n == 64 || !mj_int(element, &value) || value < 0 || value > 2147483647) return 0;
        for (i = 0; i < n; i++) if (values[i] == value) return 0;
        values[n++] = value;
    }
    return n > 0;
}

#define REQUEST_BAD(code, message) do { *why = message; return code; } while (0)
static const char *
validate_request(const char *args, const char *tool, const char **why)
{
    static const char *const actions[] = { "tool", "sessionId", "expectedRevision", "target", NULL };
    static const char *const common[] = { "tool", "sessionId", "requestId", NULL };
    static const char *const create[] = { "tool", "sessionId", "requestId", "seed", "name", "role", "race", "gender", "align", NULL };
    static const char *const act[] = { "tool", "sessionId", "requestId", "expectedRevision", "action", "direction", "target", "item", "replyTo", "confirm", "choose", "text", "position", "cancel", NULL };
    static const char *const answer[] = { "item", "target", "confirm", "choose", "text", "position", "cancel", NULL };
    const char *const *fields;
    mj_val v;
    char action[32] = "", direction[32];
    int is_act, is_create, has_action, has_reply, target = -1;
    size_t i;
    if (!tool || !*tool) REQUEST_BAD("badTool", "request needs a named tool");
    is_act = !strcmp(tool, "act"); is_create = !strcmp(tool, "new_game");
    if (!is_act && !is_create && strcmp(tool, "get_state") && strcmp(tool, "resume") && strcmp(tool, "end_session") && strcmp(tool, "actions"))
        REQUEST_BAD("badTool", "unknown tool");
    if (strlen(args) >= 1023) REQUEST_BAD("invalidArgument", "request exceeds the 1022-byte public request limit");
    fields = is_act ? act : is_create ? create : !strcmp(tool, "actions") ? actions : common;
    if (!request_fields(args, fields)) REQUEST_BAD("invalidArgument", "unknown, duplicate or escaped field name");
    if (mj_find(args, "sessionId", &v) && !request_string(v, 1, 64, NULL))
        REQUEST_BAD("badSessionId", "sessionId must be a nonempty string of at most 64 bytes");
    if (mj_find(args, "requestId", &v) && !request_string(v, 1, 128, NULL))
        REQUEST_BAD("invalidArgument", "requestId must be a nonempty string of at most 128 bytes");
    if (is_create) {
        static const char *const identity[] = { "name", "role", "race", "gender", "align", NULL };
        for (i = 0; identity[i]; i++)
            if (mj_find(args, identity[i], &v) && !request_string(v, 1, 31, NULL))
                REQUEST_BAD("badIdentity", "identity fields must be named strings of 1..31 bytes without control characters");
        if (mj_find(args, "seed", &v) && !request_integer(v, -9007199254740991LL, 9007199254740991LL))
            REQUEST_BAD("badIdentity", "seed must be a safe integer, not null or a coerced string");
        return NULL;
    }
    if (!strcmp(tool, "actions")) {
        if (!mj_find(args, "sessionId", &v) || !request_string(v, 1, 64, NULL) ||
            !mj_find(args, "expectedRevision", &v) || !request_integer(v, 0, 9007199254740991LL) ||
            !mj_find(args, "target", &v) || (target = request_target(v)) < 0 || target == 46 || target == 60 || target == 62)
            REQUEST_BAD("invalidArgument", "actions requires sessionId, expectedRevision and here or a compass target");
        return NULL;
    }
    if (!is_act) return NULL;
    if (mj_find(args, "expectedRevision", &v) && !request_integer(v, 0, 9007199254740991LL))
        REQUEST_BAD("invalidArgument", "expectedRevision must be a nonnegative safe integer");
    has_action = mj_find(args, "action", &v);
    if (has_action && !request_string(v, 1, 31, action)) REQUEST_BAD("badAction", "action must be a named string");
    has_reply = mj_find(args, "replyTo", &v);
    if (has_reply && !request_string(v, 1, 64, NULL)) REQUEST_BAD("invalidAnswer", "replyTo must name the standing decision");
    if (has_action == has_reply) REQUEST_BAD("invalidAnswer", "provide exactly one of action or replyTo");
    if (mj_find(args, "item", &v) && !request_item(v)) REQUEST_BAD("badItem", "item must be a nonempty name or only {id:string}");
    if (mj_find(args, "target", &v) && (target = request_target(v)) < 0) REQUEST_BAD("invalidTarget", "target must be self, here, or only {direction:...}");
    if (has_reply) {
        size_t count = 0;
        int boolean;
        if (mj_find(args, "direction", &v)) REQUEST_BAD("invalidAnswer", "direction answers belong in target");
        for (i = 0; answer[i]; i++) if (mj_find(args, answer[i], &v)) count++;
        if (count != 1) REQUEST_BAD("invalidAnswer", "supply exactly one answer field");
        if (mj_find(args, "confirm", &v) && !mj_bool(v, &boolean)) REQUEST_BAD("invalidAnswer", "confirm must be boolean");
        if (mj_find(args, "cancel", &v) && (!mj_bool(v, &boolean) || !boolean)) REQUEST_BAD("invalidAnswer", "cancel must be true");
        if (mj_find(args, "text", &v) && !request_string(v, 0, 128, NULL)) REQUEST_BAD("invalidAnswer", "text must be at most 128 bytes without control characters");
        if (mj_find(args, "choose", &v) && !request_choices(v)) REQUEST_BAD("invalidAnswer", "choose must be one integer or 1..64 distinct integer option ids");
        if (mj_find(args, "position", &v)) {
            char command[32]; mj_val x, y;
            static const char *const coordinates[] = {"x", "y", NULL};
            if (request_string(v, 1, 31, command)) {
                int code = move_code(command);
                if (strcmp(command, "finish") && strcmp(command, "help") && (code < 0 || code == 60 || code == 62)) REQUEST_BAD("invalidAnswer", "unknown position command");
            } else if (!request_fields(v.p, coordinates) || !mj_find(v.p, "x", &x) || !request_integer(x, 1, 79) || !mj_find(v.p, "y", &y) || !request_integer(y, 0, 20)) REQUEST_BAD("invalidAnswer", "position requires map coordinates");
        }
        if (target == 0) REQUEST_BAD("invalidTarget", "here is only an inspection target");
        return NULL;
    }
    if (cmdkey_of(action) == -2 && strcmp(action, "move") && strcmp(action, "wait") &&
        strcmp(action, "climb") && strcmp(action, "inspect") && strcmp(action, "inventory"))
        REQUEST_BAD("unsupportedAction", "this action is not bound in this build");
    /* Reject irrelevant parameters instead of quietly doing a different deed. */
    {
        const char *allowed[10] = { "tool", "sessionId", "requestId", "expectedRevision", "action" };
        int n = 5;
        if (!strcmp(action, "move") || !strcmp(action, "climb")) allowed[n++] = "direction";
        if (!strcmp(action, "inspect") || !strcmp(action, "kick") || !strcmp(action, "open") || !strcmp(action, "close") || !strcmp(action, "zap")) allowed[n++] = "target";
        if (action_takes_item(action)) allowed[n++] = "item";
        allowed[n] = NULL;
        if (!request_fields(args, allowed)) REQUEST_BAD("invalidArgument", "field does not apply to this action; answer subsequent typed decisions separately");
    }
    if (!strcmp(action, "move") || !strcmp(action, "climb")) {
        int code;
        if (!mj_find(args, "direction", &v) || !request_string(v, 1, 31, direction) || (code = move_code(direction)) < 0)
            REQUEST_BAD("badAction", "this action requires a direction");
        if ((!strcmp(action, "move") && (code == 60 || code == 62)) ||
            (!strcmp(action, "climb") && code != 60 && code != 62))
            REQUEST_BAD("badAction", "move takes compass directions; climb takes up/down");
    }
    if (target >= 0) {
        if (!strcmp(action, "inspect")) {
            if (target != 0 && target != 46) REQUEST_BAD("invalidTarget", "inspect takes self/here");
        } else if (!strcmp(action, "zap")) {
            if (target == 0) REQUEST_BAD("invalidTarget", "zap does not take here");
        } else if (target == 0 || target == 46 || target == 60 || target == 62)
            REQUEST_BAD("invalidTarget", "this action takes an adjacent compass direction");
    }
    return NULL;
}
#undef REQUEST_BAD
