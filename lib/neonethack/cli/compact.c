#define _POSIX_C_SOURCE 200809L
#include "compact.h"
#include "minjson.h"
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

/* Walk a validated object without interpreting any game facts. */
static char *take(mj_Buf *b)
{
    if (!b->ok) { mj_free(b); return NULL; }
    return mj_take(b);
}

static int next(const char **p, char **key, mj_val *value)
{
    size_t n;
    while (isspace((unsigned char)**p) || **p == '{' || **p == ',') ++*p;
    if (**p != '"') return 0;
    *key = mj_str((mj_val){*p});
    ++*p;
    while (**p && **p != '"') { if (**p == '\\') ++*p; ++*p; }
    if (**p) ++*p;
    while (isspace((unsigned char)**p) || **p == ':') ++*p;
    value->p = *p; mj_raw(*value, &n); *p += n;
    return *key != NULL;
}
static void raw(mj_Buf *b, mj_val v)
{
    size_t n; const char *p = mj_raw(v, &n);
    char *s = strndup(p, n);
    if (!s) { b->ok = 0; return; }
    mj_rawv(b, s); free(s);
}
static int equal(mj_val a, mj_val b)
{
    size_t an, bn;
    if (!a.p || !b.p) return a.p == b.p;
    mj_raw(a, &an); mj_raw(b, &bn);
    return an == bn && !memcmp(a.p, b.p, an);
}
static mj_val field(const char *s, const char *key)
{
    mj_val v = {NULL}; if (s) mj_find(s, key, &v); return v;
}
static int same_cell(mj_val a, mj_val b)
{
    return equal(field(a.p,"x"),field(b.p,"x")) && equal(field(a.p,"y"),field(b.p,"y"));
}
static mj_val lookup(mj_val array, mj_val cell)
{
    mj_arr_it it = {NULL, 1}; mj_val v;
    if (array.p) while (mj_arr_next(array.p, &it, &v)) if (same_cell(v,cell)) return v;
    return (mj_val){NULL};
}
char *compact_project(compact_state *state, const char *response, const char *method)
{
    mj_val obs = field(response,"observation"), oldobs = field(state->previous,"observation");
    mj_val rev = field(response,"revision"), oldrev = field(state->previous,"revision");
    long long r = 0, oldr = 0;
    int snapshot, full = !strcmp(method,"session.observe");
    mj_Buf b, projected, removed, world_removed, changes;
    const char *p; char *key; mj_val v;
    char *baseline = NULL, *observation = NULL, *remove_json = NULL, *world_json = NULL;
    mj_init(&b); mj_obj(&b);
    p = response;
    while (next(&p,&key,&v)) {
        if (strcmp(key,"observation") && strcmp(key,"catalog")) { mj_key(&b,key); raw(&b,v); }
        free(key);
    }
    if (!obs.p) { mj_endobj(&b); return take(&b); }
    mj_int(rev,&r); if (oldrev.p) mj_int(oldrev,&oldr);
    snapshot = !oldobs.p || !strcmp(method,"session.observe") || !strcmp(method,"session.resume") || r < oldr ||
        !equal(field(response,"sessionId"),field(state->previous,"sessionId")) ||
        !equal(field(field(obs.p,"location").p,"id"),field(field(oldobs.p,"location").p,"id"));
    baseline = strdup(response);
    mj_init(&projected); mj_obj(&projected);
    mj_init(&removed); mj_arr(&removed);
    mj_init(&world_removed); mj_arr(&world_removed);
    p = obs.p;
    while (next(&p,&key,&v)) {
        if (!full && !strcmp(key,"neighborhood")) { free(key); continue; }
        if (snapshot) { mj_key(&projected,key); raw(&projected,v); }
        else if (!strcmp(key,"world")) {
            mj_val previous = field(oldobs.p,"world"), cell;
            mj_arr_it it = {NULL, 1}; int count = 0;
            mj_init(&changes); mj_arr(&changes);
            while (mj_arr_next(v.p,&it,&cell)) {
                if (!equal(cell,lookup(previous,cell))) { raw(&changes,cell); ++count; }
            }
            mj_endarr(&changes);
            if (count) { mj_key(&projected,"world"); mj_rawv(&projected,changes.buf); }
            mj_free(&changes);
            it = (mj_arr_it){NULL, 1};
            while (previous.p && mj_arr_next(previous.p,&it,&cell)) if (!lookup(v,cell).p) {
                mj_arr(&world_removed); raw(&world_removed,field(cell.p,"x")); raw(&world_removed,field(cell.p,"y")); mj_endarr(&world_removed);
            }
        } else if (!equal(v,field(oldobs.p,key))) { mj_key(&projected,key); raw(&projected,v); }
        free(key);
    }
    if (!snapshot) {
        p = oldobs.p;
        while (next(&p,&key,&v)) {
            if (!strcmp(key,"neighborhood")) {
                if (state->neighborhood && (!full || !field(obs.p,key).p)) mj_strv(&removed,key);
            } else if (!field(obs.p,key).p) mj_strv(&removed,key);
            free(key);
        }
    }
    mj_endobj(&projected); observation = take(&projected);
    mj_endarr(&removed); remove_json = take(&removed);
    mj_endarr(&world_removed); world_json = take(&world_removed);
    if (!baseline || !observation || !remove_json || !world_json) { mj_free(&b); b.ok = 0; goto done; }
    mj_key(&b,"observation"); mj_rawv(&b,observation);
    mj_key(&b,"update"); mj_obj(&b);
    mj_key(&b,"kind"); mj_strv(&b,snapshot ? "snapshot" : "delta");
    mj_key(&b,"id"); mj_intv(&b,state->sequence + 1);
    if (!snapshot) {
        mj_key(&b,"base"); mj_intv(&b,state->sequence);
        if (strcmp(remove_json,"[]")) { mj_key(&b,"remove"); mj_rawv(&b,remove_json); }
        if (strcmp(world_json,"[]")) { mj_key(&b,"worldRemoved"); mj_rawv(&b,world_json); }
    }
    mj_endobj(&b); mj_endobj(&b);
    if (b.ok) { free(state->previous); state->previous = baseline; baseline = NULL; state->neighborhood = full && field(obs.p,"neighborhood").p != NULL; ++state->sequence; }
done:
    free(baseline); free(observation); free(remove_json); free(world_json);
    return take(&b);
}
