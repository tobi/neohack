#include "neonethack.h"
#include "explorer.h"
#include "minjson.h"
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include "catalog.inc"

extern int nnh_schema_valid(mj_val, mj_val, int);
extern int nnh_object_next(const char **, char **, mj_val *);
struct nnh_result { char *json, *error, *session; int64_t revision; };
const char *nnh_version(void) { return "1.0.0-alpha.1"; }
nnh_status nnh_context_open(const nnh_config *c, nnh_context **out)
{
    if (!out) return NNH_INVALID_ARGUMENT;
    *out = NULL;
    if (!c || c->size != sizeof *c || !c->engine_path || !c->data_path || !c->sessions_path) return NNH_INVALID_ARGUMENT;
    *out = nhx_open(c->engine_path, c->data_path, c->sessions_path);
    return *out ? NNH_OK : errno == ENOMEM ? NNH_OUT_OF_MEMORY : NNH_SYSTEM_ERROR;
}
void nnh_context_close(nnh_context *x) { nhx_close(x); }
const char *nnh_result_json(const nnh_result *r) { return r ? r->json : NULL; }
const char *nnh_result_error(const nnh_result *r) { return r ? r->error : NULL; }
const char *nnh_result_session(const nnh_result *r) { return r ? r->session : NULL; }
int64_t nnh_result_revision(const nnh_result *r) { return r ? r->revision : -1; }
void nnh_result_free(nnh_result *r) { if (r) { free(r->json); free(r->error); free(r->session); free(r); } }
static nnh_status result(char *json, nnh_result **out)
{
    nnh_result *r; mj_val v, code; long long revision;
    if (!json) return NNH_OUT_OF_MEMORY;
    r = calloc(1, sizeof *r);
    if (!r) { free(json); return NNH_OUT_OF_MEMORY; }
    r->json = json; r->revision = -1;
    if (mj_find(json, "error", &v) && mj_find(v.p, "code", &code)) {
        r->error = mj_str(code);
        if (!r->error) { nnh_result_free(r); return NNH_OUT_OF_MEMORY; }
    }
    if (mj_find(json, "sessionId", &v)) r->session = mj_str(v);
    if (mj_find(json, "revision", &v) && mj_int(v, &revision)) r->revision = revision;
    *out = r; return NNH_OK;
}
static nnh_status failure(const char *code, const char *message, nnh_result **out)
{
    mj_Buf b; mj_init(&b); mj_obj(&b);
    mj_key(&b, "version"); mj_intv(&b, 1);
    mj_key(&b, "error"); mj_obj(&b);
    mj_key(&b, "code"); mj_strv(&b, code);
    mj_key(&b, "message"); mj_strv(&b, message);
    mj_endobj(&b); mj_endobj(&b);
    return result(mj_take(&b), out);
}
static void copy_value(mj_Buf *b, const char *key, mj_val v)
{
    char *s = mj_canonical(v);
    if (!s) { b->ok = 0; return; }
    mj_key(b, key); mj_rawv(b, s); free(s);
}
static char *wrap_response(char *response)
{
    mj_Buf b; const char *p; char *key; mj_val v; int r;
    if (!response) return NULL;
    mj_init(&b); mj_obj(&b); mj_key(&b, "version"); mj_intv(&b, 1);
    p = response;
    while ((r = nnh_object_next(&p, &key, &v)) > 0) { copy_value(&b, key, v); free(key); }
    if (r < 0) b.ok = 0;
    if (mj_find(response, "observation", &v) && !mj_find(response, "end", &v)) { mj_key(&b, "end"); mj_nullv(&b); }
    mj_endobj(&b); free(response); return mj_take(&b);
}

nnh_status nnh_dispatch(nnh_context *x, const char *json, size_t length, nnh_result **out)
{
    /* Validate framing separately, since params is method-dependent. */
    char *input, *method = NULL, *tool = NULL, *action = NULL, *key;
    mj_val v, params, methods, entry, schema, answer, kind, field;
    mj_arr_it it = {0}; mj_Buf b;
    const char *p; int r, seen = 0, found = 0;
    nnh_status status;
    if (!out) return NNH_INVALID_ARGUMENT;
    *out = NULL;
    if (!x || !json) return NNH_INVALID_ARGUMENT;
    if (length > NNH_MAX_REQUEST_BYTES || memchr(json, 0, length)) return failure("invalidJson", "request is oversized or contains an embedded NUL", out);
    input = malloc(length + 1);
    if (!input) return NNH_OUT_OF_MEMORY;
    memcpy(input, json, length); input[length] = 0;
    if (!mj_valid(input)) { free(input); return failure("invalidJson", "expected one complete UTF-8 JSON object", out); }
    p = input;
    while ((r = nnh_object_next(&p, &key, &v)) > 0) {
        int bit = !strcmp(key, "version") ? 1 : !strcmp(key, "method") ? 2 : !strcmp(key, "params") ? 4 : 0;
        free(key);
        if (!bit || (seen & bit)) { r = -1; break; }
        seen |= bit;
    }
    if (r < 0 || seen != 7) { status = failure("invalidRequest", "provide exactly version, method and params with literal, unique field names", out); goto done; }
    mj_find(input, "version", &v);
    { long long version; if (!mj_int(v, &version) || version != 1) { status = failure("unsupportedVersion", "this library implements protocol version 1", out); goto done; } }
    mj_find(input, "method", &v); method = mj_str(v);
    if (!method) { status = failure("invalidRequest", "method must be a string", out); goto done; }
    mj_find(input, "params", &params);
    mj_find(nnh_catalog, "methods", &methods); it.first = 1;
    while (mj_arr_next(methods.p, &it, &entry)) {
        char *name;
        mj_find(entry.p, "name", &v); name = mj_str(v);
        found = name && !strcmp(name, method); free(name);
        if (found) break;
    }
    if (!found) { status = failure("unknownMethod", "method is not in protocol.describe", out); goto done; }
    mj_find(entry.p, "schema", &schema);
    if (!nnh_schema_valid(schema, params, 0)) { status = failure("invalidParams", "parameters do not match the method schema; no operation was sent", out); goto done; }
    if (!strcmp(method, "protocol.describe")) {
        mj_init(&b); mj_obj(&b); mj_key(&b, "version"); mj_intv(&b, 1);
        mj_key(&b, "libraryVersion"); mj_strv(&b, nnh_version());
        mj_key(&b, "catalog"); mj_rawv(&b, nnh_public_catalog);
        mj_key(&b, "backend"); mj_strv(&b,
#ifdef __EMSCRIPTEN__
            "wasm"
#else
            "native"
#endif
        );
        mj_key(&b, "capabilities"); mj_obj(&b);
        mj_key(&b, "affordanceVersion"); mj_intv(&b, 1);
        mj_key(&b, "runtimeProfile"); mj_intv(&b, 1);
#ifdef __EMSCRIPTEN__
        {
            extern int nnh_wasm_durable(void);
            int durable = nnh_wasm_durable();
            mj_key(&b, "persistence"); mj_strv(&b, durable ? "indexeddb" : "memory");
            mj_key(&b, "durability"); mj_strv(&b, durable ? "indexeddb-transaction" : "none");
            mj_key(&b, "ownership"); mj_strv(&b, durable ? "origin-web-lock" : "isolated-worker");
            mj_key(&b, "resume"); mj_strv(&b, "same-package");
        }
#else
        mj_key(&b, "persistence"); mj_strv(&b, "filesystem");
        mj_key(&b, "durability"); mj_strv(&b, "fsync");
        mj_key(&b, "ownership"); mj_strv(&b, "process-lease");
        mj_key(&b, "resume"); mj_strv(&b, "pinned-executable");
#endif
        mj_endobj(&b);
        mj_endobj(&b); status = result(mj_take(&b), out); goto done;
    }
    mj_find(entry.p, "tool", &v); tool = mj_str(v);
    if (mj_find(entry.p, "action", &v)) action = mj_str(v);
    mj_init(&b); mj_obj(&b); mj_key(&b, "tool"); mj_strv(&b, tool);
    if (action) { mj_key(&b, "action"); mj_strv(&b, action); }
    p = params.p;
    while ((r = nnh_object_next(&p, &key, &v)) > 0) {
        if (!strcmp(key, "decisionId")) copy_value(&b, "replyTo", v);
        else if (strcmp(key, "answer")) copy_value(&b, key, v);
        free(key);
    }
    if (!strcmp(method, "decision.cancel")) { mj_key(&b, "cancel"); mj_boolv(&b, 1); }
    if (!strcmp(method, "decision.answer")) {
        char *answer_kind;
        mj_find(params.p, "answer", &answer); mj_find(answer.p, "kind", &kind); answer_kind = mj_str(kind);
        key = answer_kind && !strcmp(answer_kind, "confirmation") ? "confirm" : answer_kind && !strcmp(answer_kind, "choice") ? "choose" : answer_kind;
        if (!key || !mj_find(answer.p, key, &field)) b.ok = 0;
        else copy_value(&b, key, field);
        free(answer_kind);
    }
    mj_endobj(&b);
    if (!b.ok) { mj_free(&b); status = NNH_OUT_OF_MEMORY; goto done; }
    /* Existing reservations/recordings retain their format. The v1 envelope
     * is a transport layer, not permission to rewrite historical receipts. */
    status = result(wrap_response(nhx_call(x, b.buf)), out); mj_free(&b);
done:
    free(input); free(method); free(tool); free(action); return status;
}

static void start(mj_Buf *b, const char *method, const char *sid, const nnh_guard *g)
{
    mj_init(b); mj_obj(b); mj_key(b, "version"); mj_intv(b, 1);
    mj_key(b, "method"); mj_strv(b, method); mj_key(b, "params"); mj_obj(b);
    if (sid) { mj_key(b, "sessionId"); mj_strv(b, sid); }
    if (g) { mj_key(b, "requestId"); if (g->request_id) mj_strv(b, g->request_id); else mj_nullv(b); mj_key(b, "expectedRevision"); mj_intv(b, g->expected_revision); }
}
static nnh_status finish(nnh_context *x, mj_Buf *b, nnh_result **out)
{
    nnh_status s;
    if (out) *out = NULL;
    mj_endobj(b); mj_endobj(b);
    s = b->ok ? nnh_dispatch(x, b->buf, b->len, out) : NNH_OUT_OF_MEMORY;
    mj_free(b); return s;
}
static void put_direction(mj_Buf *b, nnh_direction direction)
{
    static const char *names[] = {"north","northeast","east","southeast","south","southwest","west","northwest","up","down"};
    if ((unsigned)direction >= sizeof names / sizeof names[0]) mj_nullv(b);
    else mj_strv(b, names[direction]);
}
static void put_item(mj_Buf *b, const nnh_item *i)
{
    if (!!i->id == !!i->name || (i->name && i->quantity)) { mj_nullv(b); return; }
    if (i->name) mj_strv(b, i->name);
    else { mj_obj(b); mj_key(b, "id"); mj_strv(b, i->id); if (i->quantity) { mj_key(b, "quantity"); mj_intv(b, i->quantity); } mj_endobj(b); }
}
static void put_target(mj_Buf *b, const nnh_target *t)
{
    if (t->kind == NNH_TARGET_SELF) mj_strv(b, "self");
    else if (t->kind == NNH_TARGET_DIRECTION) { mj_obj(b); mj_key(b, "direction"); put_direction(b, t->direction); mj_endobj(b); }
    else mj_nullv(b);
}
static void put_pickup(mj_Buf *b, const nnh_automatic_pickup *p)
{
    size_t i;
    mj_key(b, "automaticPickup"); mj_obj(b);
    mj_key(b, "enabled"); if (p->enabled != 0 && p->enabled != 1) mj_nullv(b); else mj_boolv(b, p->enabled);
    mj_key(b, "arrows"); if (p->arrows != 0 && p->arrows != 1) mj_nullv(b); else mj_boolv(b, p->arrows);
    mj_key(b, "leaveCorpses"); if (p->leave_corpses != 0 && p->leave_corpses != 1) mj_nullv(b); else mj_boolv(b, p->leave_corpses);
    mj_key(b, "leaveKnownCursed"); if (p->leave_known_cursed != 0 && p->leave_known_cursed != 1) mj_nullv(b); else mj_boolv(b, p->leave_known_cursed);
    if (p->review) { mj_key(b, "review"); if (p->review != 1) mj_nullv(b); else mj_boolv(b, 1); }
    mj_key(b, "itemTypes");
    if (p->item_type_count > 15 || (p->item_type_count && !p->item_types)) mj_nullv(b);
    else {
        mj_arr(b);
        for (i = 0; i < p->item_type_count; i++) mj_strv(b, p->item_types[i]);
        mj_endarr(b);
    }
    for (i = 0; i < 2; i++) {
        size_t k, count = i ? p->ignore_pattern_count : p->loot_pattern_count;
        const char *const *patterns = i ? p->ignore_patterns : p->loot_patterns;
        if (!count && !patterns) continue;
        mj_key(b, i ? "ignorePatterns" : "lootPatterns");
        if (count > 16 || (count && !patterns)) mj_nullv(b);
        else { mj_arr(b); for (k = 0; k < count; k++) mj_strv(b, patterns[k]); mj_endarr(b); }
    }
    mj_endobj(b);
}
nnh_status nnh_game_configure_pickup(nnh_context *x, const char *sid, const nnh_guard *g, const nnh_automatic_pickup *p, nnh_result **out)
{
    mj_Buf b;
    if (!p) return NNH_INVALID_ARGUMENT;
    start(&b, "game.configurePickup", sid, g); put_pickup(&b, p);
    return finish(x, &b, out);
}
nnh_status nnh_session_create(nnh_context *x, const nnh_identity *i, nnh_result **out)
{
    mj_Buf b; start(&b, "session.create", NULL, NULL);
    if (i) {
#define ID(name) if (i->name) { mj_key(&b, #name); mj_strv(&b, i->name); }
        ID(name) ID(role) ID(race) ID(gender) ID(align)
#undef ID
        if (i->has_seed) { mj_key(&b, "seed"); mj_intv(&b, i->seed); }
        if (i->automatic_pickup) put_pickup(&b, i->automatic_pickup);
    }
    return finish(x, &b, out);
}
#define SESSION(name) nnh_status nnh_session_##name(nnh_context *x, const char *sid, nnh_result **out) { mj_Buf b; start(&b, "session." #name, sid, NULL); return finish(x, &b, out); }
SESSION(observe) SESSION(resume) SESSION(close)
#define SIMPLE_AS(name, action) nnh_status nnh_game_##name(nnh_context *x, const char *sid, const nnh_guard *g, nnh_result **out) { mj_Buf b; start(&b, "game." #action, sid, g); return finish(x, &b, out); }
#define SIMPLE(name) SIMPLE_AS(name, name)
SIMPLE(cast) SIMPLE(enhance) SIMPLE(swap) SIMPLE_AS(two_weapon, twoWeapon) SIMPLE(pay) SIMPLE(engrave) SIMPLE(loot) SIMPLE(wait) SIMPLE(pray) SIMPLE(quit)
#define DIRECTION_AS(name, action) nnh_status nnh_game_##name(nnh_context *x, const char *sid, const nnh_guard *g, nnh_direction d, nnh_result **out) { mj_Buf b; start(&b, "game." #action, sid, g); mj_key(&b, "direction"); put_direction(&b, d); return finish(x, &b, out); }
#define DIRECTION(name) DIRECTION_AS(name, name)
DIRECTION(attack) DIRECTION_AS(move_without_attack, moveWithoutAttack) DIRECTION(move) DIRECTION(climb)
nnh_status nnh_game_run(nnh_context *x, const char *sid, const nnh_guard *g, nnh_direction d, const nnh_run_options *options, nnh_result **out)
{
    static const char *const modes[] = {"normal", "untilInteresting", "pastBranches"};
    mj_Buf b; start(&b,"game.run",sid,g); mj_key(&b,"direction"); put_direction(&b,d);
    if (options) {
        mj_key(&b,"mode");
        if (options->mode < NNH_RUN_NORMAL || options->mode > NNH_RUN_PAST_BRANCHES) mj_nullv(&b); else mj_strv(&b,modes[options->mode]);
        mj_key(&b,"noPickup");
        if (options->no_pickup != 0 && options->no_pickup != 1) mj_nullv(&b); else mj_boolv(&b,options->no_pickup);
    }
    return finish(x,&b,out);
}
#define COUNTED(name) nnh_status nnh_game_##name(nnh_context *x, const char *sid, const nnh_guard *g, int32_t turns, nnh_result **out) { mj_Buf b; start(&b,"game." #name,sid,g); mj_key(&b,"turns"); mj_intv(&b,turns); return finish(x,&b,out); }
COUNTED(search) COUNTED(rest)
#define TARGET(name) nnh_status nnh_game_##name(nnh_context *x, const char *sid, const nnh_guard *g, const nnh_target *t, nnh_result **out) { mj_Buf b; start(&b, "game." #name, sid, g); if (t) { mj_key(&b, "target"); put_target(&b, t); } return finish(x, &b, out); }
TARGET(fire) TARGET(chat) TARGET(kick) TARGET(open) TARGET(close)
#define ITEM(name) nnh_status nnh_game_##name(nnh_context *x, const char *sid, const nnh_guard *g, const nnh_item *i, nnh_result **out) { mj_Buf b; start(&b, "game." #name, sid, g); if (i) { mj_key(&b, "item"); put_item(&b, i); } return finish(x, &b, out); }
ITEM(dip) ITEM(rub) ITEM(invoke) ITEM(quiver) ITEM(offer) ITEM(pickup) ITEM(eat) ITEM(drink) ITEM(wield) ITEM(equip) ITEM(remove) ITEM(read) ITEM(apply) ITEM(drop)
nnh_status nnh_game_equip_at(nnh_context *x, const char *sid, const nnh_guard *g, const nnh_item *i, const char *slot, nnh_result **out)
{ mj_Buf b; start(&b, "game.equip", sid, g); if (i) { mj_key(&b, "item"); put_item(&b, i); } mj_key(&b, "slot"); if (slot) mj_strv(&b, slot); else mj_nullv(&b); return finish(x, &b, out); }
nnh_status nnh_game_zap(nnh_context *x, const char *sid, const nnh_guard *g, const nnh_item *i, const nnh_target *t, nnh_result **out)
{
    mj_Buf b; start(&b, "game.zap", sid, g);
    if (i) { mj_key(&b, "item"); put_item(&b, i); }
    if (t) { mj_key(&b, "target"); put_target(&b, t); }
    return finish(x, &b, out);
}
nnh_status nnh_game_throw(nnh_context *x, const char *sid, const nnh_guard *g, const nnh_item *i, const nnh_target *t, nnh_result **out)
{
    mj_Buf b; start(&b, "game.throw", sid, g);
    if (i) { mj_key(&b, "item"); put_item(&b, i); }
    if (t) { mj_key(&b, "target"); put_target(&b, t); }
    return finish(x, &b, out);
}
nnh_status nnh_decision_cancel(nnh_context *x, const char *sid, const nnh_guard *g, const char *decision, nnh_result **out)
{
    mj_Buf b; start(&b, "decision.cancel", sid, g); mj_key(&b, "decisionId"); if (decision) mj_strv(&b, decision); else mj_nullv(&b); return finish(x, &b, out);
}
nnh_status nnh_decision_answer(nnh_context *x, const char *sid, const nnh_guard *g, const char *decision, const nnh_answer *a, nnh_result **out)
{
    static const char *kinds[] = {"item", "target", "confirmation", "choice", "text", "position"};
    mj_Buf b; size_t i; start(&b, "decision.answer", sid, g);
    mj_key(&b, "decisionId"); if (decision) mj_strv(&b, decision); else mj_nullv(&b);
    mj_key(&b, "answer"); mj_obj(&b); mj_key(&b, "kind");
    if (!a || (unsigned)a->kind >= 6) mj_nullv(&b);
    else {
        mj_strv(&b, kinds[a->kind]);
        switch (a->kind) {
        case NNH_ANSWER_ITEM: mj_key(&b, "item"); put_item(&b, &a->value.item); break;
        case NNH_ANSWER_TARGET: mj_key(&b, "target"); put_target(&b, &a->value.target); break;
        case NNH_ANSWER_CONFIRMATION: mj_key(&b, "confirm"); if (a->value.confirm != 0 && a->value.confirm != 1) mj_nullv(&b); else mj_boolv(&b, a->value.confirm); break;
        case NNH_ANSWER_CHOICE:
            mj_key(&b, "choose");
            if (a->value.choice.count > 64 || (!a->value.choice.ids && a->value.choice.count)) mj_nullv(&b);
            else { mj_arr(&b); for (i = 0; i < a->value.choice.count; i++) mj_intv(&b, a->value.choice.ids[i]); mj_endarr(&b); }
            break;
        case NNH_ANSWER_POSITION:
            mj_key(&b, "position");
            if (a->value.position.command) mj_strv(&b, a->value.position.command);
            else { mj_obj(&b); mj_key(&b, "x"); mj_intv(&b, a->value.position.x); mj_key(&b, "y"); mj_intv(&b, a->value.position.y); mj_endobj(&b); }
            break;
        case NNH_ANSWER_TEXT: mj_key(&b, "text"); if (a->value.text) mj_strv(&b, a->value.text); else mj_nullv(&b); break;
        }
    }
    mj_endobj(&b); return finish(x, &b, out);
}
