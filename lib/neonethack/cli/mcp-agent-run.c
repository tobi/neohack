/* Higher-level orchestration over public semantic requests. The C resolver
 * supplies routes/edges; this adapter owns no terrain or combat rules. */
#define _GNU_SOURCE
#include "mcp.h"
#include "mcp-agent.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int same(mj_val v, const char *s)
{
    char *text = mcp_string(v); int yes = text && !strcmp(text,s); free(text); return yes;
}
static long long number(const char *json, const char *key, long long fallback)
{
    long long n; mj_val value = mcp_field(json,key);
    return value.p && mj_int(value,&n) ? n : fallback;
}
static int failed(const char *json)
{
    mj_val v = mcp_field(json,"error"); return v.p && !mj_is_null(v);
}
void mcp_agent_clear(mcp_agent_state *s)
{
    free(s->snapshot); free(s->pending); free(s->last); memset(s,0,sizeof *s);
}
static void adopt(mcp_agent_state *s, const char *response)
{
    if (mcp_field(response,"observation").p) {
        char *copy = strdup(response);
        /* A missing local frame must stop input; never keep an older revision. */
        free(s->snapshot); s->snapshot = copy;
    }
}
static char *dispatch(nnh_context *ctx, mcp_agent_state *s, const char *request, int mutation, int historical)
{
    if (!request) return mcp_agent_error("agentError","Cannot construct a request; no input submitted.");
    if (mutation) {
        char *copy = strdup(request);
        if (!copy) return mcp_agent_error("agentError","Cannot retain exact request; no input submitted.");
        free(s->pending); s->pending = copy;
        if (s->reserve && !s->reserve(request,s->reserve_context))
            return mcp_agent_error("uncertainExecution","Cannot confirm supervisor retention. No new input submitted; inspect or retry the retained operation.");
    }
    nnh_result *result = NULL;
    nnh_status code = nnh_dispatch(ctx,request,strlen(request),&result);
    char *response = code == NNH_OK && result ? strdup(nnh_result_json(result)) : NULL;
    if (result) nnh_result_free(result);
    if (!response) return mcp_agent_error(mutation ? "uncertainExecution" : "agentError",
        mutation ? "Input reply unavailable. Retry only the retained exact operation." : "Query reply unavailable.");
    if (mutation && !mcp_agent_uncertain(response)) {
        char *id = mcp_string(mcp_field(mcp_field(request,"params").p,"requestId"));
        if (id && same(mcp_field(response,"requestId"),id)) {
            free(s->last); s->last = s->pending; s->pending = NULL;
        } else { free(s->pending); s->pending = NULL; }
        free(id);
    }
    if (!historical) adopt(s,response);
    return response;
}
static char *step(nnh_context *ctx, mcp_agent_state *s, const char *method, mj_val args, long long seen, const char *operation)
{
    int mutation = !strncmp(method,"game.",5) || !strncmp(method,"decision.",9);
    int query_guard = !strcmp(method,"session.actions") || !strcmp(method,"session.route") || !strcmp(method,"session.navigation");
    char *decision = NULL;
    if (!strncmp(method,"decision.",9)) {
        decision = mcp_string(mcp_field(mcp_field(s->snapshot,"decision").p,"id"));
        if (!decision) return mcp_agent_error("agentError","There is no standing decision.");
    }
    char *request = mcp_agent_request(method,args,mutation || query_guard ? seen : -1,mutation ? operation : NULL,decision);
    free(decision);
    char *response = dispatch(ctx,s,request,mutation,0); free(request); return response;
}
static char *params(const char *sid, const char *key, mj_val value)
{
    mj_Buf b; mj_init(&b); mj_obj(&b); mj_key(&b,"sessionId"); mj_strv(&b,sid);
    if (key) { mj_key(&b,key); mcp_raw(&b,value); }
    mj_endobj(&b); return mcp_take(&b);
}
static char *direction(nnh_context *ctx, mcp_agent_state *s, const char *sid, mj_val target, long long revision, char **error)
{
    char *p = params(sid,"target",target);
    char *response = step(ctx,s,"session.actions",(mj_val){p},revision,NULL); free(p);
    if (failed(response)) { *error = response; return NULL; }
    mj_val cell = mcp_field(response,"cell"), actions = mcp_field(cell.p,"actions"), item;
    char *dir = NULL; mj_arr_it it = {NULL,1};
    if (same(mcp_field(mcp_field(cell.p,"movement").p,"relation"),"adjacent"))
        while (mj_arr_next(actions.p,&it,&item)) if (same(mcp_field(item.p,"method"),"game.move")) {
            dir = mcp_string(mcp_field(mcp_field(item.p,"arguments").p,"direction")); break;
        }
    free(response);
    if (!dir) *error = mcp_agent_error("outOfReach","Choose an adjacent square for a direct attempt. Force does not mean force attack.");
    return dir;
}
static char *string_params(const char *sid, const char *key, const char *value)
{
    mj_Buf b; mj_init(&b); mj_strv(&b,value); char *v = mcp_take(&b);
    char *p = v ? params(sid,key,(mj_val){v}) : NULL; free(v); return p;
}
static char *attack(nnh_context *ctx, mcp_agent_state *s, mj_val args, long long seen, const char *operation)
{
    char *sid = mcp_string(mcp_field(args.p,"sessionId"));
    mj_val target = mcp_field(args.p,"target"); char *point = NULL;
    if (target.p && *target.p == '"') {
        char *id = mcp_string(target);
        char *frame = mcp_agent_present(s->snapshot,0);
        mj_val creatures = mcp_field(frame,"creatures"), item; mj_arr_it it = {NULL,1};
        while (mj_arr_next(creatures.p,&it,&item)) if (same(mcp_field(item.p,"id"),id)) {
            point = mj_canonical(mcp_field(item.p,"position")); break;
        }
        free(frame); free(id);
        if (!point) { free(sid); return mcp_agent_error("agentError","Stale or foreign creature reference. Observe and select a current creature or adjacent square."); }
        target.p = point;
    }
    char *error = NULL, *dir = direction(ctx,s,sid,target,seen,&error);
    free(point);
    if (!dir) { free(sid); return error; }
    char *p = string_params(sid,"direction",dir); free(dir); free(sid);
    char *response = step(ctx,s,"game.attack",(mj_val){p},seen,operation); free(p); return response;
}

static const char *gate(mcp_agent_state *s)
{
    int ended = 0; mj_bool(mcp_field(s->snapshot,"ended"),&ended);
    mj_val decision = mcp_field(s->snapshot,"decision");
    return ended ? "ended" : decision.p && !mj_is_null(decision) ? "decision" : NULL;
}
static char *level(mcp_agent_state *s)
{
    return mcp_string(mcp_field(mcp_field(mcp_field(s->snapshot,"observation").p,"location").p,"id"));
}
static char *navigation_result(mcp_agent_state *s, const char *reason, int actions, long long turns)
{
    mj_Buf b; mj_init(&b); mj_obj(&b);
    const char *cursor = s->snapshot; char *key; mj_val value;
    extern int nnh_object_next(const char **, char **, mj_val *);
    int next;
    while ((next = nnh_object_next(&cursor,&key,&value)) > 0) {
        mj_key(&b,key); mcp_raw(&b,value); free(key);
    }
    if (next < 0) b.ok = 0;
    mj_key(&b,"navigation"); mj_obj(&b);
    mj_key(&b,"reason"); mj_strv(&b,reason);
    mj_key(&b,"actionsTaken"); mj_intv(&b,actions);
    mj_key(&b,"turnsElapsed"); mj_intv(&b,turns);
    mj_endobj(&b); mj_endobj(&b); return mcp_take(&b);
}
static mj_val nearest(mj_val list, int doors)
{
    mj_val chosen = {NULL}, item; mj_arr_it it = {NULL,1};
    long long distance = 9007199254740991LL, x = 80, y = 21;
    while (mj_arr_next(list.p,&it,&item)) {
        long long d = number(item.p,"distance",-1), xx = number(item.p,"x",80), yy = number(item.p,"y",21);
        if (d < 0 || (doors && (same(mcp_field(item.p,"lock"),"locked") || !mcp_field(item.p,"approach").p || !mcp_field(item.p,"direction").p))) continue;
        if (d < distance || (d == distance && (yy < y || (yy == y && xx < x)))) {
            chosen = item; distance = d; x = xx; y = yy;
        }
    }
    return chosen;
}
static int health_lost(const char *before, const char *after)
{
    mj_val a=mcp_field(mcp_field(before,"observation").p,"vitals");
    mj_val b=mcp_field(mcp_field(after,"observation").p,"vitals");
    long long previous,current;
    return mj_int(mcp_field(a.p,"health"),&previous) &&
           mj_int(mcp_field(b.p,"health"),&current) && current<previous;
}
static int new_creature(const char *before, const char *after)
{
    mj_val old = mcp_field(mcp_field(before,"observation").p,"world"), world = mcp_field(mcp_field(after,"observation").p,"world"), c;
    mj_arr_it it = {NULL,1};
    while (mj_arr_next(world.p,&it,&c)) {
        mj_val occupant = mcp_field(c.p,"occupant");
        if (!same(mcp_field(occupant.p,"kind"),"creature")) continue;
        mj_val p; mj_arr_it previous = {NULL,1}; int found = 0;
        char *appearance = mcp_string(mcp_field(occupant.p,"appearance"));
        while (mj_arr_next(old.p,&previous,&p)) if (number(p.p,"x",-1)==number(c.p,"x",-2) && number(p.p,"y",-1)==number(c.p,"y",-2)) {
            mj_val other = mcp_field(p.p,"occupant");
            if (same(mcp_field(other.p,"kind"),"creature") && appearance && same(mcp_field(other.p,"appearance"),appearance)) found = 1;
        }
        free(appearance); if (!found) return 1;
    }
    return 0;
}
static char *navigate(nnh_context *ctx, mcp_agent_state *s, const char *method, mj_val args, const char *operation)
{
    char *sid = mcp_string(mcp_field(args.p,"sessionId")), *to = NULL, *door = NULL, *initial_level = level(s), *response = NULL;
    const char *reason = gate(s); int actions = 0, force = 0;
    long long turns = 0, limit = number(args.p,"maxActions",1659);
    int descend = !strcmp(method,"agent.descend"), explore = !strcmp(method,"agent.explore");
    mj_val force_value = mcp_field(args.p,"force");
    if (force_value.p) mj_bool(force_value,&force);
    if (reason) goto finish;
    if (limit < 1 || limit > 1659 || !operation) { response = mcp_agent_error("invalidParams","A bounded leg requires maxActions from 1 to 1659 and an adapter operation ID."); goto done; }
    if (!descend && !explore) to = mj_canonical(mcp_field(args.p,"to"));
    else {
        char *p = params(sid,NULL,(mj_val){NULL});
        response = step(ctx,s,"session.navigation",(mj_val){p},number(s->snapshot,"revision",-1),NULL); free(p);
        if (failed(response)) goto done;
        mj_val chosen = nearest(mcp_field(response,descend ? "waysDown" : "frontiers"),0);
        if (!chosen.p && explore) {
            chosen = nearest(mcp_field(response,"doors"),1);
            if (chosen.p) { to = mj_canonical(mcp_field(chosen.p,"approach")); door = mcp_string(mcp_field(chosen.p,"direction")); }
        } else if (chosen.p) {
            mj_Buf b; mj_init(&b); mj_obj(&b); mj_key(&b,"x"); mcp_raw(&b,mcp_field(chosen.p,"x"));
            mj_key(&b,"y"); mcp_raw(&b,mcp_field(chosen.p,"y")); mj_endobj(&b); to = mcp_take(&b);
        }
        free(response); response = NULL;
        if (!to) { reason = "noRoute"; goto finish; }
    }
    if (!to || !initial_level) { response = mcp_agent_error("agentError","Navigation requires a perceived destination and level."); goto done; }
    while (1) {
        reason = gate(s); if (reason) goto finish;
        long long revision = number(s->snapshot,"revision",-1), distance = 1;
        char *dir = NULL;
        if (force) {
            dir = direction(ctx,s,sid,(mj_val){to},revision,&response);
            if (!dir) goto done;
        } else {
            char *p = params(sid,"to",(mj_val){to});
            response = step(ctx,s,"session.route",(mj_val){p},revision,NULL); free(p);
            if (failed(response)) goto done;
            distance = number(response,"distance",-1);
            if (distance < 0) { reason = "noRoute"; goto finish; }
            if (!distance && !door && !descend) { reason = "arrived"; goto finish; }
            if (actions >= limit) { reason = "stepLimit"; goto finish; }
            if (distance) {
                mj_val item; mj_arr_it it = {NULL,1};
                if (mj_arr_next(mcp_field(response,"steps").p,&it,&item)) dir = mcp_string(mcp_field(item.p,"direction"));
            } else dir = strdup(door ? door : "down");
            free(response); response = NULL;
            if (!dir) { response = mcp_agent_error("agentError","Known route has no next action."); goto done; }
        }
        char *p = string_params(sid,"direction",dir); free(dir);
        char operation_id[160]; snprintf(operation_id,sizeof operation_id,"%s-%d",operation,actions+1);
        char *before = s->snapshot ? strdup(s->snapshot) : NULL;
        if (!before) { free(p); response = mcp_agent_error("agentError","Cannot retain perceived navigation state; no input submitted."); goto done; }
        response = step(ctx,s,distance ? "game.move" : door ? "game.open" : "game.climb",(mj_val){p},revision,operation_id); free(p);
        if (failed(response)) { free(before); goto done; }
        actions++; turns += number(mcp_field(response,"outcome").p,"turnsElapsed",0);
        reason = gate(s);
        if (!reason && !same(mcp_field(mcp_field(response,"outcome").p,"status"),"completed")) reason = "interrupted";
        if (!reason && !force && health_lost(before,response)) reason = "changed";
        char *now_level = level(s); int changed_level = !now_level || strcmp(initial_level,now_level); free(now_level);
        if (!reason && force) {
            mj_val you = mcp_field(mcp_field(response,"observation").p,"you");
            reason = number(you.p,"x",-1)==number(to,"x",-2) && number(you.p,"y",-1)==number(to,"y",-2) ? "arrived" : "attempted";
        }
        if (!reason && !distance) {
            if (!door) reason = changed_level ? "arrived" : "interrupted";
            else {
                mj_Buf b; mj_init(&b); mj_obj(&b); mj_key(&b,"direction"); mj_strv(&b,door); mj_endobj(&b);
                char *target = mcp_take(&b); char *a = params(sid,"target",(mj_val){target}); free(target);
                char *view = step(ctx,s,"session.actions",(mj_val){a},number(s->snapshot,"revision",-1),NULL); free(a);
                reason = same(mcp_field(mcp_field(mcp_field(view,"cell").p,"terrain").p,"type"),"openDoor") ? "arrived" : "interrupted";
                free(view);
            }
        }
        int moved = 0; mj_bool(mcp_field(mcp_field(response,"outcome").p,"positionChanged"),&moved);
        if (!reason && changed_level) reason = "changed";
        if (!reason && !moved) reason = "interrupted";
        if (!reason && new_creature(before,response)) reason = "changed";
        if (!reason && actions >= limit) {
            mj_val you = mcp_field(mcp_field(response,"observation").p,"you");
            reason = !door && !descend && number(you.p,"x",-1)==number(to,"x",-2) && number(you.p,"y",-1)==number(to,"y",-2) ? "arrived" : "stepLimit";
        }
        free(before);
        if (reason) goto finish;
        free(response); response = NULL;
    }
finish:
    free(response); response = navigation_result(s,reason,actions,turns);
done:
    free(sid); free(to); free(door); free(initial_level); return response;
}
/* Resolve aliases only against the current, already perceived question. */
static char *answer_choice(nnh_context *ctx, mcp_agent_state *s, mj_val args, long long seen, const char *operation)
{
    mj_val decision = mcp_field(s->snapshot,"decision"), answer = mcp_field(args.p,"answer");
    if (!same(mcp_field(decision.p,"kind"),"choice") || !same(mcp_field(answer.p,"kind"),"choice"))
        return step(ctx,s,"decision.answer",args,seen,operation);
    mj_val choices = mcp_field(answer.p,"choose"), options = mcp_field(decision.p,"options"), selected;
    mj_Buf resolved; mj_init(&resolved); mj_arr(&resolved);
    mj_arr_it ci = {NULL,1};
    while (mj_arr_next(choices.p,&ci,&selected)) {
        char *name = mcp_string(selected);
        if (!name) { mcp_raw(&resolved,selected); continue; }
        mj_arr_it oi = {NULL,1}; mj_val option, match = {NULL}; int count = 0;
        while (mj_arr_next(options.p,&oi,&option)) if (same(mcp_field(option.p,"name"),name)) { match = option; count++; }
        if (count != 1) {
            mj_endarr(&resolved); free(mcp_take(&resolved));
            mj_Buf b; mj_init(&b); mj_obj(&b);
            mj_key(&b,"version"); mj_intv(&b,1);
            mj_key(&b,"sessionId"); mcp_raw(&b,mcp_field(args.p,"sessionId"));
            mj_key(&b,"revision"); mj_intv(&b,seen);
            mj_key(&b,"summary"); mj_strv(&b,count ? "Several choices have that name. Select one candidate by ID." : "No choice has that name. Select a displayed name or ID.");
            mj_key(&b,"clarification"); mj_obj(&b);
            mj_key(&b,"kind"); mj_strv(&b,"choice");
            mj_key(&b,"reason"); mj_strv(&b,count ? "ambiguousName" : "unknownName");
            mj_key(&b,"name"); mj_strv(&b,name); mj_endobj(&b);
            mj_key(&b,"decision"); mj_obj(&b);
            const char *cursor = decision.p; char *key; mj_val value;
            extern int nnh_object_next(const char **, char **, mj_val *);
            while (nnh_object_next(&cursor,&key,&value) > 0) {
                if (strcmp(key,"options")) { mj_key(&b,key); mcp_raw(&b,value); }
                free(key);
            }
            mj_key(&b,"options"); mj_arr(&b); oi = (mj_arr_it){NULL,1};
            while (mj_arr_next(options.p,&oi,&option))
                if (!count || same(mcp_field(option.p,"name"),name)) mcp_raw(&b,option);
            mj_endarr(&b); mj_endobj(&b); mj_endobj(&b); free(name); return mcp_take(&b);
        }
        mcp_raw(&resolved,mcp_field(match.p,"id")); free(name);
    }
    mj_endarr(&resolved); char *ids = mcp_take(&resolved);
    if (!ids) return mcp_agent_error("agentError","Cannot resolve choices; no input submitted.");
    mj_Buf b; mj_init(&b); mj_obj(&b);
    mj_key(&b,"sessionId"); mcp_raw(&b,mcp_field(args.p,"sessionId"));
    mj_key(&b,"answer"); mj_obj(&b); mj_key(&b,"kind"); mj_strv(&b,"choice");
    mj_key(&b,"choose"); mcp_raw(&b,(mj_val){ids}); mj_endobj(&b); mj_endobj(&b);
    char *p = mcp_take(&b); free(ids);
    char *response = p ? step(ctx,s,"decision.answer",(mj_val){p},seen,operation) : mcp_agent_error("agentError","Cannot resolve choices; no input submitted.");
    free(p); return response;
}
char *mcp_agent_execute(nnh_context *ctx, mcp_agent_state *s, const char *method, mj_val args, long long seen, const char *operation)
{
    if (!strcmp(method,"agent.help")) return mcp_agent_help(args);
    if (!strcmp(method,"agent.retry")) {
        if (!s->pending) {
            if (!s->last) return mcp_agent_error("agentError","No recent input is retained. Inspect a receipt by operationId.");
            mj_val params = mcp_field(s->last,"params");
            mj_Buf b; mj_init(&b); mj_obj(&b);
            mj_key(&b,"sessionId"); mcp_raw(&b,mcp_field(params.p,"sessionId"));
            mj_key(&b,"operationId"); mcp_raw(&b,mcp_field(params.p,"requestId")); mj_endobj(&b);
            char *args_json = mcp_take(&b);
            char *receipt = mcp_agent_execute(ctx,s,"agent.receipt",(mj_val){args_json},seen,NULL); free(args_json);
            if (!receipt) return NULL;
            size_t size = strlen(receipt); char *historical = NULL;
            if (size && asprintf(&historical,"%.*s,\"historical\":true}",(int)size-1,receipt) < 0) historical = NULL;
            free(receipt); return historical;
        }
        char *request = strdup(s->pending);
        char *response = dispatch(ctx,s,request,1,0); free(request); return response;
    }
    if (!strcmp(method,"agent.receipt")) {
        char *sid = mcp_string(mcp_field(args.p,"sessionId"));
        char *op = mcp_string(mcp_field(args.p,"operationId"));
        char *p = params(sid,NULL,(mj_val){NULL});
        char *request = mcp_agent_request("session.receipt",(mj_val){p},-1,op,NULL);
        char *response = dispatch(ctx,s,request,0,1);
        free(sid); free(op); free(p); free(request); return response;
    }
    int safe = !strcmp(method,"session.create") || !strcmp(method,"session.resume") || !strcmp(method,"session.observe");
    if (!safe) {
        if (!s->snapshot) return mcp_agent_error("agentError","Observe or resume this run first.");
        if (s->pending) return mcp_agent_error("uncertainExecution","An input is uncertain. Retry the retained exact operation; do not submit new input.");
        if (number(s->snapshot,"revision",-1) != seen) return mcp_agent_error("staleRevision","State changed while this call was queued. Observe before acting.");
    }
    if (!strcmp(method,"agent.attack")) return attack(ctx,s,args,seen,operation);
    if (!strcmp(method,"decision.answer")) return answer_choice(ctx,s,args,seen,operation);
    if (!strcmp(method,"agent.go") || !strcmp(method,"agent.explore") || !strcmp(method,"agent.descend")) return navigate(ctx,s,method,args,operation);
    char *response = step(ctx,s,method,args,seen,operation);
    if (!strcmp(method,"session.close") && !failed(response)) { free(s->snapshot); s->snapshot = NULL; }
    return response;
}
