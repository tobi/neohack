/* Semantic metadata is not an optional hint: never recover it by silently
 * substituting defaults. Frame/revision counters are still reconciled from
 * the public journal, but operation/receipt corruption fails closed. */
static void
pending_signature(game_t *g, char out[32])
{
    mj_Buf b; size_t i, k;
    uint64_t hash = UINT64_C(14695981039346656037);
    mj_init(&b); mj_arr(&b);
    mj_strv(&b, g->pending.kind); mj_intv(&b, g->pending.id);
    mj_strv(&b, g->pending.context); mj_intv(&b, g->pending.object_id);
    mj_intv(&b, g->operation.item_object_id); mj_intv(&b, g->operation.item_count);
    mj_strv(&b, g->pending.prompt ? g->pending.prompt : "");
    mj_strv(&b, g->pending.choices ? g->pending.choices : "");
    mj_intv(&b, g->pending.def); mj_intv(&b, g->pending.window); mj_intv(&b, g->pending.how);
    if (g->pending.position_mode) {
        mj_strv(&b, "positionV1"); mj_intv(&b, g->pending.position_mode);
        mj_intv(&b, g->pending.cursor_x); mj_intv(&b, g->pending.cursor_y);
    }
    for (i = 0; i < g->pending.ncommands; i++) mj_strv(&b, g->pending.commands[i]);
    if (g->operation.floor_object_id > 0) {
        mj_strv(&b, "floorBindingV1"); mj_intv(&b, g->operation.floor_object_id);
    }
    if (!strcmp(g->pending.kind, "menu")) for (i = 0; i < MAX_MENU_WINDOWS; i++) {
        menu_t *m = &g->menus[i];
        if (!m->used || m->window != g->pending.window) continue;
        mj_strv(&b, m->prompt ? m->prompt : "");
        mj_intv(&b, m->item_selection); mj_intv(&b, m->counted);
        if (m->container_phase) { mj_strv(&b, "containerV1"); mj_intv(&b, m->container_phase); }
        for (k = 0; k < m->nitems; k++) {
            mj_intv(&b, m->items[k].index); mj_intv(&b, m->items[k].accel); mj_intv(&b, m->items[k].glyph);
            mj_intv(&b, m->items[k].quantity);
            mj_strv(&b, m->items[k].text ? m->items[k].text : "");
            if (m->items[k].transfer) { mj_strv(&b, "transferV1"); mj_intv(&b, m->items[k].transfer); }
            if (m->items[k].selectable >= 0 || m->items[k].object_id > 0) {
                mj_strv(&b, "menuBindingV1");
                mj_intv(&b, m->items[k].selectable); mj_intv(&b, m->items[k].object_id);
            }
        }
    }
    mj_endarr(&b);
    if (b.ok) {
        for (i = 0; i < b.len; i++) { hash ^= (unsigned char) b.buf[i]; hash *= UINT64_C(1099511628211); }
        snprintf(out, 32, "fnv1a64:%016llx", (unsigned long long) hash);
    } else out[0] = 0;
    mj_free(&b);
}

static const char *
sidecar_validate(game_t *g, const char *text)
{
    static const char *const fields[] = { "format", "version", "sessionId", "inputBytes", "boundaryComplete", "rngIntegrityVersion", "revision", "frameCount", "recordingGap", "recordingOnly", "inventoryRev", "nextDecision", "nextRef", "requests", "operation", NULL };
    static const char *const numeric[] = { "revision", "inventoryRev", "nextDecision", "nextRef", NULL };
    static const char *const boolean[] = { "recordingOnly", "recordingGap", "boundaryComplete", NULL };
    mj_val v, item;
    size_t i, count = 0;
    char *ids[64] = { 0 };
    const char *error = NULL;
    int modern = 0;
    mj_arr_it it = { 0 };
    if (!request_fields(text, fields)) return "unknown or escaped metadata field";
    if(mj_find(text,"rngIntegrityVersion",&v)&&!stored_integer(v,1,1))return "invalid private RNG integrity version";
    if (mj_find(text, "format", &v)) {
        modern = 1;
        if (!record_is(v, "neonethack.session") || !mj_find(text, "version", &v) || !stored_integer(v, 1, 1) ||
            !mj_find(text, "sessionId", &v) || !record_is(v, g->id) ||
            !mj_find(text, "inputBytes", &v) || !stored_integer(v, 0, INPUT_MAX_BYTES) ||
            !mj_find(text, "boundaryComplete", &v)) return "invalid metadata identity or version";
    } else if (mj_find(text, "version", &v) || mj_find(text, "sessionId", &v)) return "incomplete metadata identity";
    for (i = 0; numeric[i]; i++) {
        long long minimum = i == 1 ? -1 : i >= 2 ? 1 : 0;
        if (!mj_find(text, numeric[i], &v) || !stored_integer(v, minimum, 9007199254740991LL)) return "missing or invalid metadata counter";
    }
    if (mj_find(text, "frameCount", &v) && !stored_integer(v, 0, 9007199254740991LL)) return "invalid frame counter";
    if (mj_find(text, "inputBytes", &v) && !stored_integer(v, 0, INPUT_MAX_BYTES)) return "invalid input boundary";
    for (i = 0; boolean[i]; i++) {
        int flag;
        if (mj_find(text, boolean[i], &v) && !mj_bool(v, &flag)) return "invalid metadata flag";
    }
    if (!mj_find(text, "requests", &v) || *v.p != '[') return "missing request receipts";
    it.first = 1;
    while (mj_arr_next(v.p, &it, &item)) {
        static const char *const receipt[] = { "rid", "argsKey", "result", NULL };
        mj_val id, key, result, check;
        char *canonical = NULL, *args = NULL;
        if (count == 64 || !request_fields(item.p, receipt) ||
            !mj_find(item.p, "rid", &id) || !stored_string(id, 1, 128) ||
            !mj_find(item.p, "argsKey", &key) || !stored_string(key, 2, 4096) ||
            !mj_find(item.p, "result", &result) || *result.p != '{') { error = "invalid receipt entry"; break; }
        ids[count] = mj_str(id);
        if (!ids[count]) { error = "cannot decode receipt id"; break; }
        for (i = 0; i < count; i++) if (!strcmp(ids[count], ids[i])) error = "duplicate receipt id";
        count++;
        if (error) break;
        if (!mj_find(result.p, "sessionId", &check) || !record_is(check, g->id) ||
            !mj_find(result.p, "requestId", &check) || !record_is(check, ids[count - 1]) ||
            !mj_find(result.p, "revision", &check) || !stored_integer(check, 0, 9007199254740991LL) ||
            !mj_find(result.p, "observation", &check) || *check.p != '{' ||
            !mj_find(result.p, "outcome", &check) || *check.p != '{') { error = "receipt identity or result mismatch"; break; }
        args = mj_str(key);
        if (args && *args == '{' && mj_valid(args)) canonical = mj_canonical((mj_val) { args });
        if (!canonical) error = "invalid receipt fingerprint";
        free(args); free(canonical);
        if (error) break;
    }
    for (i = 0; i < count; i++) free(ids[i]);
    if (error) return error;
    if (!mj_find(text, "operation", &v)) return "missing operation state";
    if (!mj_is_null(v)) {
        static const char *const fields[] = { "action", "args", "phase", "decisionId", "decKind", "promptSignature", "decSynthetic", "keypos", "cmdkey", "dirCode", "itemLetter", "itemCount", "itemObjectId", "floorIndex", "floorObjectId", "selfAllowed", "letterAnswers", NULL };
        static const char *const words[] = { "action", "phase", "decisionId", "decKind", NULL };
        static const size_t max[] = { 31, 31, 39, 15 };
        static const char *const numbers[] = { "keypos", "cmdkey", "dirCode", "itemLetter", "floorIndex", "selfAllowed", "letterAnswers", NULL };
        static const int lo[] = { 0, -2, -1, 0, -1, 0, 0 }, hi[] = { 64, 255, 255, 127, 127, 1, 64 };
        mj_val field; int flag; size_t size;
        char *action;
        long long command = -2;
        if (!request_fields(v.p, fields)) return "invalid operation fields";
        for (i = 0; words[i]; i++)
            if (!mj_find(v.p, words[i], &field) || !stored_string(field, i ? 0 : 1, max[i])) return "invalid operation text";
        for (i = 0; numbers[i]; i++) {
            int present = mj_find(v.p, numbers[i], &field);
            if ((modern && !present) || (present && !stored_integer(field, lo[i], hi[i]))) return "missing or invalid operation counter";
        }
        if (modern && (!mj_find(v.p, "decSynthetic", &field) || !mj_find(v.p, "promptSignature", &field))) return "missing operation boundary fields";
        if (mj_find(v.p, "floorObjectId", &field) && !stored_integer(field, 0, 4294967295LL)) return "invalid floor object binding";
        if (!mj_find(v.p, "itemCount", &field) || !stored_integer(field, 0, 2147483647LL)) return "invalid item count";
        if (!mj_find(v.p, "itemObjectId", &field) || !stored_integer(field, 0, 4294967295LL)) return "invalid carried object binding";
        if (mj_find(v.p, "promptSignature", &field) && !stored_string(field, 0, 31)) return "invalid prompt fingerprint";
        if (mj_find(v.p, "decSynthetic", &field) && !mj_bool(field, &flag)) return "invalid synthetic decision flag";
        if (!mj_find(v.p, "args", &field) || *field.p != '{') return "invalid operation arguments";
        mj_raw(field, &size); if (size >= sizeof g->operation.args_json) return "operation arguments exceed limit";
        mj_find(v.p, "action", &field); action = mj_str(field);
        if (!action) return "invalid operation action";
        if (cmdkey_of(action) < 0 && strcmp(action, "move") && strcmp(action, "wait") && strcmp(action, "climb") && strcmp(action, "inspect") && strcmp(action, "inventory") && strcmp(action, "new_game") && strcmp(action, "configurePickup")) {
            free(action); return "unbound operation action";
        }
        if (mj_find(v.p, "cmdkey", &field)) mj_int(field, &command);
        if (command != -2 && command != cmdkey_of(action) &&
            !( (!strcmp(action, "move") || !strcmp(action, "wait")) && strchr("hjklyubn.", (int) command) && command > 0) &&
            !( !strcmp(action, "climb") && (command == '<' || command == '>')) &&
            !( (!strcmp(action, "equip") || !strcmp(action, "wear")) && command == 'P') &&
            !( (!strcmp(action, "remove") || !strcmp(action, "takeoff")) && command == 'R') &&
            !( !strcmp(action, "new_game") && command == 0)) error = "operation command is not bound to its action";
        free(action); if (error) return error;
        if (!mj_find(v.p, "decKind", &field) ||
            !(record_is(field, "") || record_is(field, "item") || record_is(field, "choice") || record_is(field, "confirmation") || record_is(field, "target") || record_is(field, "text") || record_is(field, "position"))) return "invalid decision kind";
    }
    return NULL;
}

/* Health can change after a receipt was committed; the deed receipt itself
 * remains immutable and may still be retrieved while storage is blocked. */
static char *
sidecar_health(game_t *g, char *response)
{
    const char *message, *code;
    mj_Buf b; size_t n; char *out;
    if (!g || !response) return response;
    if (g->sidecar_error[0]) { code = "metadataUnavailable"; message = g->sidecar_error; }
    else if (g->input_error[0]) { code = "inputHistoryError"; message = g->input_error; }
    else if (g->recovery_required) { code = "recoveryRequired"; message = "replay reached an uncheckpointed semantic boundary; no new answer or deed is permitted"; }
    else return response;
    n = strlen(response); if (!n || response[n - 1] != '}') return response;
    mj_init(&b); mj_obj(&b);
    mj_key(&b, "status"); mj_strv(&b, "degraded");
    mj_key(&b, "code"); mj_strv(&b, code);
    mj_key(&b, "message"); mj_strv(&b, message);
    mj_key(&b, "requiresResume"); mj_boolv(&b, 1);
    mj_endobj(&b);
    out = b.ok ? malloc(n + b.len + 16) : NULL;
    if (out) {
        memcpy(out, response, n - 1);
        snprintf(out + n - 1, b.len + 17, ",\"storage\":%s}", b.buf);
        free(response); response = out;
    }
    mj_free(&b); return response;
}
