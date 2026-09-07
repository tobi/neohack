#define _GNU_SOURCE
#include "mcp.h"
#include "mcp-agent.h"
#include "mcp-agent-data.inc"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern int nnh_schema_valid(mj_val, mj_val, int);
extern int nnh_object_next(const char **, char **, mj_val *);
const char *mcp_agent_tools = agent_tools;
const char *mcp_agent_instructions = agent_instructions;

static int text_is(mj_val value, const char *expected)
{
    char *s = mcp_string(value); int equal = s && !strcmp(s,expected);
    free(s); return equal;
}
mj_val mcp_agent_method(const char *name)
{
    mj_val item; mj_arr_it it = {NULL,1};
    while (name && mj_arr_next(agent_methods,&it,&item))
        if (text_is(mcp_field(item.p,"name"),name)) return item;
    return (mj_val){NULL};
}
int mcp_agent_valid(mj_val method, mj_val args)
{
    return method.p && nnh_schema_valid(mcp_field(method.p,"schema"),args.p ? args : (mj_val){"{}"},0);
}
char *mcp_agent_error(const char *code, const char *message)
{
    mj_Buf b; mj_init(&b); mj_obj(&b);
    mj_key(&b,"version"); mj_intv(&b,1);
    mj_key(&b,"summary"); mj_strv(&b,message);
    mj_key(&b,"error"); mj_obj(&b);
    mj_key(&b,"code"); mj_strv(&b,code);
    mj_key(&b,"message"); mj_strv(&b,message);
    mj_endobj(&b); mj_endobj(&b); return mcp_take(&b);
}
char *mcp_agent_help(mj_val args)
{
    char *name = mcp_string(mcp_field(args.p,"name"));
    mj_Buf b; mj_init(&b); mj_obj(&b);
    mj_key(&b,"version"); mj_intv(&b,1);
    mj_key(&b,"summary"); mj_strv(&b,agent_instructions);
    mj_val item, list = mcp_field(agent_tools,"tools"); mj_arr_it it = {NULL,1};
    if (name) {
        int found = 0;
        while (mj_arr_next(list.p,&it,&item)) if (text_is(mcp_field(item.p,"name"),name)) {
            mj_key(&b,"tool"); mcp_raw(&b,item); found = 1; break;
        }
        free(name);
        if (!found) { mj_free(&b); return mcp_agent_error("unknownTool","Unknown tool."); }
    } else {
        mj_key(&b,"tools"); mj_arr(&b);
        while (mj_arr_next(list.p,&it,&item)) {
            mj_obj(&b); mj_key(&b,"name"); mcp_raw(&b,mcp_field(item.p,"name"));
            mj_key(&b,"description"); mcp_raw(&b,mcp_field(item.p,"description")); mj_endobj(&b);
        }
        mj_endarr(&b);
    }
    mj_endobj(&b); return mcp_take(&b);
}
/* Add only adapter-owned guards to already schema-validated arguments. The
 * public input schema rejects caller-supplied guards before this function. */
char *mcp_agent_request(const char *method, mj_val args, long long revision,
                        const char *request_id, const char *decision_id)
{
    mj_Buf b; mj_init(&b); mj_obj(&b);
    mj_key(&b,"version"); mj_intv(&b,1);
    mj_key(&b,"method"); mj_strv(&b,method);
    mj_key(&b,"params"); mj_obj(&b);
    const char *cursor = args.p ? args.p : "{}"; char *key; mj_val value; int next;
    while ((next = nnh_object_next(&cursor,&key,&value)) > 0) {
        if (!strcmp(key,"requestId") || !strcmp(key,"expectedRevision") || !strcmp(key,"decisionId")) b.ok = 0;
        mj_key(&b,key); mcp_raw(&b,value); free(key);
    }
    if (next < 0) b.ok = 0;
    if (revision >= 0) { mj_key(&b,"expectedRevision"); mj_intv(&b,revision); }
    if (request_id) { mj_key(&b,"requestId"); mj_strv(&b,request_id); }
    if (decision_id) { mj_key(&b,"decisionId"); mj_strv(&b,decision_id); }
    mj_endobj(&b); mj_endobj(&b); return mcp_take(&b);
}
int mcp_agent_uncertain(const char *response)
{
    if (text_is(mcp_field(mcp_field(response,"outcome").p,"status"),"unknown")) return 1;
    mj_val code = mcp_field(mcp_field(response,"error").p,"code");
    return text_is(code,"incompleteRequest") || text_is(code,"recoveryRequired") ||
        text_is(code,"metadataUnavailable") || text_is(code,"inputHistoryError");
}
/* Same full perceived frame as the low protocol, with adapter prose and
 * revision-bound creature references. No hidden identity or strategy tables. */
char *mcp_agent_present(const char *response, int historical)
{
    mj_Buf b; mj_init(&b); mj_obj(&b);
    mj_val error = mcp_field(response,"error"), outcome = mcp_field(response,"outcome");
    mj_val observation = mcp_field(response,"observation"), decision = mcp_field(response,"decision");
    char *summary = mcp_string(mcp_field(response,"summary"));
    if (!summary && error.p && !mj_is_null(error)) summary = mcp_string(mcp_field(error.p,"message"));
    else if (!summary && outcome.p) {
        char *action = mcp_string(mcp_field(outcome.p,"action"));
        char *status = mcp_string(mcp_field(outcome.p,"status"));
        char *about = mcp_string(mcp_field(decision.p,"about"));
        long long turns = 0; mj_int(mcp_field(outcome.p,"turnsElapsed"),&turns);
        if (asprintf(&summary,"%s: %s; %lld turns elapsed.%s%s",action ? action : "Action",status ? status : "unknown",turns,about ? " Answer the standing decision: " : "",about ? about : "") < 0) summary = NULL;
        free(action); free(status); free(about);
    }
    if (!summary && text_is(mcp_field(response,"kind"),"lore")) {
        int found=0; mj_bool(mcp_field(response,"found"),&found);
        summary = strdup(found ? "Encyclopedia lore; reference text, not an observation." : "No encyclopedia entry found.");
    }
    mj_val navigation = mcp_field(response,"navigation");
    if (navigation.p) {
        char *reason = mcp_string(mcp_field(navigation.p,"reason")); long long actions = 0, turns = 0;
        mj_int(mcp_field(navigation.p,"actionsTaken"),&actions); mj_int(mcp_field(navigation.p,"turnsElapsed"),&turns);
        free(summary); summary = NULL;
        if (asprintf(&summary,"Navigation: %s; %lld actions, %lld turns elapsed.",reason ? reason : "unknown",actions,turns) < 0) summary = NULL;
        free(reason);
    }
    mj_key(&b,"summary"); mj_strv(&b,summary ? summary : "Perceived information."); free(summary);
    /* Preserve all response members exactly, except the agent-facing ID name. */
    const char *cursor = response; char *key; mj_val value; int next;
    while ((next = nnh_object_next(&cursor,&key,&value)) > 0) {
        if (!strcmp(key,"summary")) { free(key); continue; }
        if (!strcmp(key,"requestId") && mj_is_null(value)) { free(key); continue; }
        mj_key(&b,!strcmp(key,"requestId") ? "operationId" : key); mcp_raw(&b,value); free(key);
    }
    if (next < 0) b.ok = 0;
    if (historical) { mj_key(&b,"historical"); mj_boolv(&b,1); }
    if (observation.p) {
        char *sid = mcp_string(mcp_field(response,"sessionId"));
        long long revision = -1; mj_int(mcp_field(response,"revision"),&revision);
        mj_val world = mcp_field(observation.p,"world"), cell; mj_arr_it it = {NULL,1};
        mj_key(&b,"creatures"); mj_arr(&b);
        while (mj_arr_next(world.p,&it,&cell)) {
            mj_val occupant = mcp_field(cell.p,"occupant");
            if (!occupant.p || mj_is_null(occupant) || text_is(mcp_field(occupant.p,"kind"),"self")) continue;
            long long x, y;
            if (!sid || revision < 0 || !mj_int(mcp_field(cell.p,"x"),&x) || !mj_int(mcp_field(cell.p,"y"),&y)) { b.ok = 0; break; }
            char id[160]; snprintf(id,sizeof id,"c-%s-%lld-%lld-%lld",sid,revision,x,y);
            mj_obj(&b); mj_key(&b,"id"); mj_strv(&b,id);
            mj_key(&b,"position"); mj_obj(&b);
            mj_key(&b,"x"); mj_intv(&b,x); mj_key(&b,"y"); mj_intv(&b,y); mj_endobj(&b);
            cursor = occupant.p;
            while ((next = nnh_object_next(&cursor,&key,&value)) > 0) { mj_key(&b,key); mcp_raw(&b,value); free(key); }
            if (next < 0) b.ok = 0;
            mj_endobj(&b);
        }
        mj_endarr(&b); free(sid);
    }
    mj_endobj(&b); return mcp_take(&b);
}
