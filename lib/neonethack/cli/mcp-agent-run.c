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
    char *request = mcp_agent_request(method,args,mutation || query_guard ? seen : -1,mutation ? operation : NULL);
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
static const char *route_hint(const char *why)
{
    if (!why) return NULL;
    if (!strcmp(why,"targetOccupied")) return "Attack the occupant if adjacent; go does not fight.";
    if (!strcmp(why,"targetUnknown")) return "Inspect or step adjacent; knownWalking does not guess unmapped tiles.";
    if (!strcmp(why,"closedDoor")) return "Open the door, or explore toward it. go does not open doors.";
    return "No knownWalking path. Search, open a door, or pick another remembered square.";
}
static char *navigation_result(mcp_agent_state *s, const char *reason, int actions, long long turns, const char *failure, const char *why)
{
    mj_Buf b; mj_init(&b); mj_obj(&b);
    const char *cursor = s->snapshot; char *key; mj_val value;
    extern int nnh_object_next(const char **, char **, mj_val *);
    int next;
    while ((next = nnh_object_next(&cursor,&key,&value)) > 0) {
        /* A free planning stop is not a replay of the previous input receipt. */
        if ((!actions && (!strcmp(key,"outcome") || !strcmp(key,"events"))) ||
            ((!actions || failure) && !strcmp(key,"requestId")) ||
            !strcmp(key,"error") || !strcmp(key,"summary")) { free(key); continue; }
        mj_key(&b,key); mcp_raw(&b,value); free(key);
    }
    if (next < 0) b.ok = 0;
    if (!actions) {
        mj_key(&b,"events"); mj_arr(&b); mj_endarr(&b);
        mj_key(&b,"outcome"); mj_obj(&b);
        mj_key(&b,"action"); mj_strv(&b,"navigation");
        mj_key(&b,"status"); mj_strv(&b,"completed");
        mj_key(&b,"turnsElapsed"); mj_intv(&b,0);
        mj_key(&b,"positionChanged"); mj_boolv(&b,0);
        mj_key(&b,"effects"); mj_arr(&b); mj_endarr(&b); mj_endobj(&b);
    }
    if (failure) {
        mj_val error = mcp_field(failure,"error");
        char *message = mcp_string(mcp_field(error.p,"message")), *scoped = NULL;
        if (asprintf(&scoped,"Navigation stopped after %d actions and %lld turns. Substep error: %s",actions,turns,message ? message : "Unknown failure.") < 0) scoped = NULL;
        mj_key(&b,"error"); mj_obj(&b);
        mj_key(&b,"code"); mcp_raw(&b,mcp_field(error.p,"code"));
        mj_key(&b,"message"); mj_strv(&b,scoped ? scoped : "Navigation stopped; inspect confirmed progress and the retained input.");
        mj_endobj(&b); free(message); free(scoped);
        if (s->pending) {
            mj_key(&b,"requestId"); mcp_raw(&b,mcp_field(mcp_field(s->pending,"params").p,"requestId"));
        }
    }
    mj_key(&b,"navigation"); mj_obj(&b);
    mj_key(&b,"reason"); mj_strv(&b,reason);
    mj_key(&b,"actionsTaken"); mj_intv(&b,actions);
    mj_key(&b,"turnsElapsed"); mj_intv(&b,turns);
    if (why && !strcmp(reason,"noRoute")) {
        mj_key(&b,"why"); mj_strv(&b,why);
        mj_key(&b,"hint"); mj_strv(&b,route_hint(why));
    }
    if (failure) {
        mj_key(&b,"observation"); mj_strv(&b,s->pending || mcp_agent_uncertain(failure) ? "lastConfirmed" : "current");
    }
    if (failure || (actions > 0 && strcmp(reason,"arrived") && strcmp(reason,"ended"))) {
        if (s->last) {
            mj_key(&b,"lastOperationId"); mcp_raw(&b,mcp_field(mcp_field(s->last,"params").p,"requestId"));
        }
        mj_key(&b,"recover"); mj_strv(&b,"Call recover; do not resubmit this navigation leg.");
    }
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
int mcp_agent_new_creature(const char *before, const char *after)
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
            mj_val previous_appearance = mcp_field(other.p,"appearance");
            if (same(mcp_field(other.p,"kind"),"creature") &&
                (appearance ? same(previous_appearance,appearance) : !previous_appearance.p || mj_is_null(previous_appearance))) found = 1;
        }
        free(appearance); if (!found) return 1;
    }
    return 0;
}
static int cell_at(mj_val world, int x, int y, mj_val *out)
{
    mj_val cell; mj_arr_it it = {NULL,1};
    while (mj_arr_next(world.p,&it,&cell)) if (number(cell.p,"x",-1)==x && number(cell.p,"y",-1)==y) { *out = cell; return 1; }
    return 0;
}
static int unknown_cardinal(mcp_agent_state *s, int x, int y, int *ox, int *oy)
{
    static const int dx[] = {0,1,0,-1}, dy[] = {-1,0,1,0};
    mj_val world = mcp_field(mcp_field(s->snapshot,"observation").p,"world"), cell;
    for (int i = 0; i < 4; i++) {
        int nx = x+dx[i], ny = y+dy[i];
        if (nx < 1 || nx > 79 || ny < 0 || ny > 20) continue;
        if (!cell_at(world,nx,ny,&cell)) { *ox = nx; *oy = ny; return 1; }
        char *type = mcp_string(mcp_field(mcp_field(cell.p,"terrain").p,"type"));
        int unk = type && (!strcmp(type,"unknown") || !strcmp(type,"dark"));
        free(type);
        if (unk) { *ox = nx; *oy = ny; return 1; }
    }
    return 0;
}
int mcp_agent_vitals_changed(const char *before, const char *after)
{
    mj_val a=mcp_field(mcp_field(before,"observation").p,"vitals");
    mj_val b=mcp_field(mcp_field(after,"observation").p,"vitals");
    const char *keys[]={"condition","hunger"};
    for (size_t i=0;i<sizeof keys/sizeof *keys;i++) {
        mj_val previous=mcp_field(a.p,keys[i]),current=mcp_field(b.p,keys[i]);
        if (!previous.p && !current.p) continue;
        if (!previous.p || !current.p) return 1;
        char *old=mj_canonical(previous),*now=mj_canonical(current);
        int changed=!old || !now || strcmp(old,now);
        free(old);free(now);if(changed)return 1;
    }
    return 0;
}
static char *navigate(nnh_context *ctx, mcp_agent_state *s, const char *method, mj_val args, const char *operation)
{
    char *sid = mcp_string(mcp_field(args.p,"sessionId")), *to = NULL, *door = NULL, *initial_level = level(s), *response = NULL, *block = NULL;
    const char *reason = gate(s); int actions = 0, force = 0, edge = 0;
    long long turns = 0, limit = number(args.p,"maxActions",1659);
    long long frontiers = 0, frontier_limit = number(args.p,"maxFrontiers",1);
    int descend = !strcmp(method,"agent.descend"), explore = !strcmp(method,"agent.explore");
    mj_val force_value = mcp_field(args.p,"force");
    if (force_value.p) mj_bool(force_value,&force);
    if (reason) goto finish;
    if (limit < 1 || limit > 1659 || frontier_limit < 1 || frontier_limit > 1659 || !operation) { response = mcp_agent_error("invalidParams","A bounded leg requires maxActions and maxFrontiers from 1 to 1659 and an adapter operation ID."); goto done; }
select_destination:
    if (explore) { force = 0; edge = 0; }
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
        if (!to && explore) {
            mj_val you = mcp_field(mcp_field(s->snapshot,"observation").p,"you");
            int x = (int)number(you.p,"x",-1), y = (int)number(you.p,"y",-1), nx, ny;
            if (x >= 1 && unknown_cardinal(s,x,y,&nx,&ny)) {
                mj_Buf b; mj_init(&b); mj_obj(&b); mj_key(&b,"x"); mj_intv(&b,nx); mj_key(&b,"y"); mj_intv(&b,ny); mj_endobj(&b);
                to = mcp_take(&b); force = 1;
            } else if (x >= 1) {
                mj_val world = mcp_field(mcp_field(s->snapshot,"observation").p,"world"), cell; mj_arr_it it = {NULL,1};
                int best_x = 0, best_y = 0, found = 0; long long best = 9007199254740991LL, revision = number(s->snapshot,"revision",-1);
                while (mj_arr_next(world.p,&it,&cell)) {
                    int cx = (int)number(cell.p,"x",-1), cy = (int)number(cell.p,"y",-1);
                    if (!unknown_cardinal(s,cx,cy,&nx,&ny)) continue;
                    mj_Buf dest; mj_init(&dest); mj_obj(&dest); mj_key(&dest,"x"); mj_intv(&dest,cx); mj_key(&dest,"y"); mj_intv(&dest,cy); mj_endobj(&dest);
                    char *json = mcp_take(&dest), *p = params(sid,"to",(mj_val){json}); free(json);
                    char *plan = step(ctx,s,"session.route",(mj_val){p},revision,NULL); free(p);
                    if (!failed(plan)) {
                        long long distance = number(plan,"distance",-1);
                        if (distance >= 0 && distance < best) { best = distance; best_x = cx; best_y = cy; found = 1; }
                    }
                    free(plan);
                }
                if (found) {
                    mj_Buf b; mj_init(&b); mj_obj(&b); mj_key(&b,"x"); mj_intv(&b,best_x); mj_key(&b,"y"); mj_intv(&b,best_y); mj_endobj(&b);
                    to = mcp_take(&b); edge = 1;
                }
            }
        }
        if (!to) { reason = "noRoute"; block = strdup("disconnected"); goto finish; }
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
            if (distance < 0) {
                reason = "noRoute";
                block = mcp_string(mcp_field(response,"why"));
                if (!block) block = strdup("disconnected");
                goto finish;
            }
            if (!distance && !door && !descend) {
                if (explore && edge) {
                    mj_val you = mcp_field(mcp_field(s->snapshot,"observation").p,"you");
                    int x = (int)number(you.p,"x",-1), y = (int)number(you.p,"y",-1), nx, ny;
                    if (x >= 1 && unknown_cardinal(s,x,y,&nx,&ny)) {
                        free(to); mj_Buf b; mj_init(&b); mj_obj(&b); mj_key(&b,"x"); mj_intv(&b,nx); mj_key(&b,"y"); mj_intv(&b,ny); mj_endobj(&b);
                        to = mcp_take(&b); force = 1; edge = 0; free(response); response = NULL; continue;
                    }
                }
                reason = "arrived"; goto arrived;
            }
            if (actions >= limit) { reason = "stepLimit"; goto finish; }
            if (distance) {
                mj_val item; mj_arr_it it = {NULL,1};
                if (mj_arr_next(mcp_field(response,"steps").p,&it,&item)) dir = mcp_string(mcp_field(item.p,"direction"));
            } else dir = strdup(door ? door : "down");
            free(response); response = NULL;
            if (!dir) { response = mcp_agent_error("agentError","Known route has no next action."); goto done; }
        }
        char *p;
        if (!distance && door) {
            mj_Buf target; mj_init(&target); mj_obj(&target);
            mj_key(&target,"direction"); mj_strv(&target,dir); mj_endobj(&target);
            char *json = mcp_take(&target); p = params(sid,"target",(mj_val){json}); free(json);
        } else p = string_params(sid,"direction",dir);
        free(dir);
        char operation_id[160]; snprintf(operation_id,sizeof operation_id,"%s-%d",operation,actions+1);
        char *before = s->snapshot ? strdup(s->snapshot) : NULL;
        if (!before) { free(p); response = mcp_agent_error("agentError","Cannot retain perceived navigation state; no input submitted."); goto done; }
        response = step(ctx,s,distance ? "game.move" : door ? "game.open" : "game.climb",(mj_val){p},revision,operation_id); free(p);
        if (failed(response)) {
            /* A durability error may follow real engine input. Include any
             * elapsed time the returned frame confirms, even on failure. */
            long long previous = number(mcp_field(before,"observation").p,"turn",-1);
            long long current = number(mcp_field(response,"observation").p,"turn",-1);
            if (previous >= 0 && current > previous) { actions++; turns += current - previous; }
            free(before); goto done;
        }
        actions++; turns += number(mcp_field(response,"outcome").p,"turnsElapsed",0);
        reason = gate(s);
        if (!reason && !same(mcp_field(mcp_field(response,"outcome").p,"status"),"completed")) reason = "interrupted";
        if (!reason && !force && health_lost(before,response)) reason = "changed";
        if (!reason && !force && mcp_agent_vitals_changed(before,response)) reason = "changed";
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
                if (failed(view)) { free(response); response = view; free(before); goto done; }
                reason = same(mcp_field(mcp_field(mcp_field(view,"cell").p,"terrain").p,"type"),"openDoor") ? "arrived" : "interrupted";
                free(view);
            }
        }
        int moved = 0; mj_bool(mcp_field(mcp_field(response,"outcome").p,"positionChanged"),&moved);
        if (!reason && changed_level) reason = "changed";
        if (!reason && !moved) reason = "interrupted";
        if (!reason && mcp_agent_new_creature(before,response)) reason = "changed";
        if (!reason && actions >= limit) {
            mj_val you = mcp_field(mcp_field(response,"observation").p,"you");
            reason = !door && !descend && number(you.p,"x",-1)==number(to,"x",-2) && number(you.p,"y",-1)==number(to,"y",-2) ? "arrived" : "stepLimit";
        }
        free(before);
        if (reason) {
            if (!strcmp(reason,"arrived")) goto arrived;
            goto finish;
        }
        free(response); response = NULL;
    }
arrived:
    /* Only ordinary frontier arrivals may select another target. A door is
     * always one explicit attempt, even when more frontier work was requested. */
    if (explore && !door && ++frontiers < frontier_limit) {
        if (actions >= limit) { reason = "stepLimit"; goto finish; }
        free(response); response = NULL; free(to); to = NULL;
        goto select_destination;
    }
finish:
    free(response); response = navigation_result(s,reason,actions,turns,NULL,block);
done:
    if (failed(response) && s->snapshot) {
        char *failure = response;
        response = navigation_result(s,"error",actions,turns,failure,NULL); free(failure);
    }
    free(sid); free(to); free(door); free(initial_level); free(block); return response;
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
    mj_key(&b,"decisionId"); mcp_raw(&b,mcp_field(args.p,"decisionId"));
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
        char *request = mcp_agent_request("session.receipt",(mj_val){p},-1,op);
        char *response = dispatch(ctx,s,request,0,1);
        free(sid); free(op); free(p); free(request); return response;
    }
    int safe = !strcmp(method,"session.create") || !strcmp(method,"session.resume") || !strcmp(method,"session.observe");
    if (!safe) {
        if (!s->snapshot) return mcp_agent_error("agentError","Observe or resume this run first.");
        if (s->pending) return mcp_agent_error("uncertainExecution","An input is uncertain. Use recover for the retained exact operation; do not submit new input.");
        if (number(s->snapshot,"revision",-1) != seen) return mcp_agent_error("staleRevision","State changed while this call was queued. Observe before acting.");
    }
    if (!strcmp(method,"agent.attack")) return attack(ctx,s,args,seen,operation);
    if (!strncmp(method,"decision.",9)) {
        char *id = mcp_string(mcp_field(args.p,"decisionId"));
        int matches = id && same(mcp_field(mcp_field(s->snapshot,"decision").p,"id"),id);
        free(id);
        if (!matches) return mcp_agent_error("staleDecision","The decision changed. Observe and answer the exact returned decisionId; no input submitted.");
    }
    if (!strcmp(method,"decision.answer")) {
        char *normalized=mcp_agent_arguments(args,mcp_field(mcp_field(s->snapshot,"decision").p,"kind"));
        if(!normalized)return mcp_agent_error("invalidParams","Value does not match the standing question’s reply.valueSchema; no input submitted.");
        char *response=answer_choice(ctx,s,(mj_val){normalized},seen,operation);free(normalized);return response;
    }
    if (!strcmp(method,"agent.go") || !strcmp(method,"agent.explore") || !strcmp(method,"agent.descend")) return navigate(ctx,s,method,args,operation);
    char *normalized=mcp_agent_arguments(args,(mj_val){NULL});
    if(!normalized)return mcp_agent_error("invalidParams","Cannot decode arguments; no input submitted.");
    char *response = step(ctx,s,method,(mj_val){normalized},seen,operation);free(normalized);
    if (!strcmp(method,"session.close") && !failed(response)) { free(s->snapshot); s->snapshot = NULL; }
    return response;
}
