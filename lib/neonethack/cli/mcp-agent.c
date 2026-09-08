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
    mj_val schema = mcp_field(method.p,"schema");
    if (!method.p || !nnh_schema_valid(schema,args.p ? args : (mj_val){"{}"},0)) return 0;
    /* The low validator has no dependentRequired keyword; this dependency
     * belongs only to the generated agent argument schema. */
    if (mcp_field(schema.p,"dependentRequired").p && mcp_field(args.p,"quantity").p && !mcp_field(args.p,"itemId").p) return 0;
    return 1;
}
static void item_selector(mj_Buf *b, mj_val args)
{
    mj_obj(b); mj_key(b,"id"); mcp_raw(b,mcp_field(args.p,"itemId"));
    mj_val quantity = mcp_field(args.p,"quantity");
    if (quantity.p) { mj_key(b,"quantity"); mcp_raw(b,quantity); }
    mj_endobj(b);
}
/* Decode presentation arguments only after exact decision binding. Never
 * discover a newer question or pick an answer while doing this translation. */
char *mcp_agent_arguments(mj_val args, mj_val decision_kind)
{
    char *kind = mcp_string(decision_kind);
    mj_val format = kind ? mcp_field(agent_answers,kind) : (mj_val){NULL};
    mj_val value = mcp_field(args.p,"value");
    if (kind && (!format.p || !nnh_schema_valid(mcp_field(format.p,"schema"),value,0))) { free(kind); return NULL; }
    mj_Buf b; mj_init(&b); mj_obj(&b);
    const char *cursor=args.p; char *key; mj_val member; int next;
    while ((next=nnh_object_next(&cursor,&key,&member))>0) {
        if (strcmp(key,"itemId") && strcmp(key,"quantity") && (!kind || strcmp(key,"value"))) { mj_key(&b,key); mcp_raw(&b,member); }
        free(key);
    }
    if(next<0)b.ok=0;
    if(mcp_field(args.p,"itemId").p){mj_key(&b,"item");item_selector(&b,args);}
    if(kind){
        char *field=mcp_string(mcp_field(format.p,"field"));
        mj_key(&b,"answer");mj_obj(&b);mj_key(&b,"kind");mj_strv(&b,kind);mj_key(&b,field);
        if(!strcmp(kind,"item"))item_selector(&b,value);
        else if(!strcmp(kind,"target") && !text_is(value,"self")){mj_obj(&b);mj_key(&b,"direction");mcp_raw(&b,value);mj_endobj(&b);}
        else mcp_raw(&b,value);
        mj_endobj(&b);free(field);
    }
    free(kind);mj_endobj(&b);return mcp_take(&b);
}
static void reply_arguments(mj_Buf *b, mj_val sid, mj_val decision)
{
    mj_obj(b);mj_key(b,"sessionId");mcp_raw(b,sid);
    mj_key(b,"decisionId");mcp_raw(b,mcp_field(decision.p,"id"));mj_endobj(b);
}
static void present_decision(mj_Buf *b, mj_val sid, mj_val decision)
{
    char *kind=mcp_string(mcp_field(decision.p,"kind"));
    mj_val format=kind?mcp_field(agent_answers,kind):(mj_val){NULL};free(kind);
    if(!format.p){mcp_raw(b,decision);return;}
    mcp_raw(b,decision);
    mj_key(b,"reply");mj_obj(b);mj_key(b,"tool");mj_strv(b,"answer");
    mj_key(b,"arguments");reply_arguments(b,sid,decision);
    mj_key(b,"valueSchema");mcp_raw(b,mcp_field(format.p,"schema"));
    mj_key(b,"instruction");mcp_raw(b,mcp_field(format.p,"instruction"));mj_endobj(b);
    int cancellable=0;mj_bool(mcp_field(decision.p,"cancellable"),&cancellable);
    if(cancellable){mj_key(b,"cancel");mj_obj(b);mj_key(b,"tool");mj_strv(b,"cancel");mj_key(b,"arguments");reply_arguments(b,sid,decision);mj_endobj(b);}
}
static void present_attempts(mj_Buf *b, mj_val sid, mj_val cell)
{
    mj_key(b,"attempts");mj_arr(b);
    mj_arr_it it={NULL,1};mj_val offer;
    while(mj_arr_next(mcp_field(cell.p,"actions").p,&it,&offer)){
        mj_val arguments=mcp_field(offer.p,"arguments");if(!arguments.p)continue;
        char *method=mcp_string(mcp_field(offer.p,"method")),*tool=NULL;
        int move=method&&!strcmp(method,"game.move");
        if(move)tool=strdup("go");
        else if(method){mj_arr_it mi={NULL,1};mj_val entry;while(mj_arr_next(agent_methods,&mi,&entry))if(text_is(mcp_field(entry.p,"method"),method)){tool=mcp_string(mcp_field(entry.p,"name"));break;}}
        free(method);if(!tool)continue;
        mj_obj(b);mj_key(b,"tool");mj_strv(b,tool);free(tool);
        mj_key(b,"arguments");mj_obj(b);mj_key(b,"sessionId");mcp_raw(b,sid);
        if(move){mj_key(b,"to");mj_obj(b);mj_key(b,"x");mcp_raw(b,mcp_field(cell.p,"x"));mj_key(b,"y");mcp_raw(b,mcp_field(cell.p,"y"));mj_endobj(b);mj_key(b,"force");mj_boolv(b,1);}
        else{const char *cursor=arguments.p;char *key;mj_val value;while(nnh_object_next(&cursor,&key,&value)>0){mj_key(b,key);mcp_raw(b,value);free(key);}}
        mj_endobj(b);mj_key(b,"availability");mcp_raw(b,mcp_field(offer.p,"availability"));mj_key(b,"cost");mcp_raw(b,mcp_field(offer.p,"cost"));mj_endobj(b);
    }
    mj_endarr(b);
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
                        const char *request_id)
{
    mj_Buf b; mj_init(&b); mj_obj(&b);
    mj_key(&b,"version"); mj_intv(&b,1);
    mj_key(&b,"method"); mj_strv(&b,method);
    mj_key(&b,"params"); mj_obj(&b);
    const char *cursor = args.p ? args.p : "{}"; char *key; mj_val value; int next;
    while ((next = nnh_object_next(&cursor,&key,&value)) > 0) {
        if (!strcmp(key,"requestId") || !strcmp(key,"expectedRevision")) b.ok = 0;
        mj_key(&b,key); mcp_raw(&b,value); free(key);
    }
    if (next < 0) b.ok = 0;
    if (revision >= 0) { mj_key(&b,"expectedRevision"); mj_intv(&b,revision); }
    if (request_id) { mj_key(&b,"requestId"); mj_strv(&b,request_id); }
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
    return mcp_agent_present_mode(response,historical,0);
}
char *mcp_agent_present_mode(const char *response, int historical, int compact)
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
    /* Terminal facts lead even when navigation or an error supplies the detail.
     * A disconnected close ends the connection, but the run can resume. */
    int ended = 0; mj_val ended_value = mcp_field(response,"ended");
    if (ended_value.p) mj_bool(ended_value,&ended);
    mj_val end = mcp_field(response,"end");
    if (ended && !text_is(mcp_field(end.p,"kind"),"disconnected")) {
        char *kind = mcp_string(mcp_field(end.p,"kind"));
        char *cause = mcp_string(mcp_field(end.p,"cause"));
        char *detail = summary; summary = NULL;
        if (asprintf(&summary,"Run ended (%s)%s%s.%s%s",kind ? kind : "unknown",
                     cause && *cause ? ": " : "",cause ? cause : "",
                     detail ? " " : "",detail ? detail : "") < 0) summary = NULL;
        free(kind); free(cause); free(detail);
    }
    mj_key(&b,"summary"); mj_strv(&b,summary ? summary : "Perceived information."); free(summary);
    /* Preserve all response members exactly, except the agent-facing ID name. */
    const char *cursor = response; char *key; mj_val value; int next;
    long long omitted_clear = 0;
    while ((next = nnh_object_next(&cursor,&key,&value)) > 0) {
        if (!strcmp(key,"summary")) { free(key); continue; }
        if (!strcmp(key,"requestId") && mj_is_null(value)) { free(key); continue; }
        if (!strcmp(key,"decision")) { mj_key(&b,key);present_decision(&b,mcp_field(response,"sessionId"),value);free(key);continue; }
        if (compact && observation.p && !strcmp(key,"observation")) {
            const char *fields=value.p; char *field; mj_val member; int more;
            mj_key(&b,key); mj_obj(&b);
            while ((more=nnh_object_next(&fields,&field,&member))>0) {
                if (strcmp(field,"neighborhood")) {mj_key(&b,field);mcp_raw(&b,member);}
                free(field);
            }
            if(more<0)b.ok=0;
            mj_endobj(&b);free(key);continue;
        }
        if (compact && observation.p && !strcmp(key,"events")) {
            mj_arr_it events={NULL,1};mj_val event;
            mj_key(&b,key);mj_arr(&b);
            while(mj_arr_next(value.p,&events,&event)) {
                char *mark=mcp_string(mcp_field(event.p,"mark"));
                int clear=text_is(mcp_field(event.p,"type"),"saw") && text_is(mcp_field(event.p,"kind"),"terrain") && mark && (!mark[0] || !strcmp(mark,"\\u0000"));
                free(mark);
                if(clear)omitted_clear++;else mcp_raw(&b,event);
            }
            mj_endarr(&b);free(key);continue;
        }
        mj_key(&b,!strcmp(key,"requestId") ? "operationId" : key); mcp_raw(&b,value); free(key);
    }
    if (next < 0) b.ok = 0;
    mj_val cell=mcp_field(response,"cell");
    if(cell.p)present_attempts(&b,mcp_field(response,"sessionId"),cell);
    if(compact && observation.p) {
        mj_key(&b,"presentation");mj_obj(&b);
        mj_key(&b,"kind");mj_strv(&b,"compact");
        mj_key(&b,"omitted");mj_arr(&b);mj_strv(&b,"observation.neighborhood");mj_endarr(&b);
        mj_key(&b,"omittedClearTerrainEvents");mj_intv(&b,omitted_clear);
        mj_key(&b,"fullObservation");mj_strv(&b,"observe");
        mj_key(&b,"attempts");mj_strv(&b,"inspect");
        if(mcp_field(response,"requestId").p && !mj_is_null(mcp_field(response,"requestId"))) {mj_key(&b,"fullInputReceipt");mj_strv(&b,"receipt");}
        mj_endobj(&b);
    }
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
