#define _GNU_SOURCE
#include "mcp.h"
#include "mcp-agent.h"
#include "../src/choice-names.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Exercise real committed engine input followed by failed supervisor retention.
 * The production callback already owns this boundary; no game state is faked. */
static int reserve_countdown(const char *request, void *context)
{
    (void)request;
    long long *remaining = context;
    return --*remaining != 0;
}

int main(int argc, char **argv)
{
    if (argc == 5 && !strcmp(argv[1],"execute")) {
        nnh_config config = {.size=sizeof config,.engine_path=argv[2],.data_path=argv[3],.sessions_path=argv[4]};
        nnh_context *ctx = NULL; assert(nnh_context_open(&config,&ctx) == NNH_OK);
        mcp_agent_state state = {0}; char *line = NULL; size_t cap = 0;
        while (getline(&line,&cap,stdin) >= 0) {
            assert(mj_valid(line));
            char *name = mcp_string(mcp_field(line,"name"));
            mj_val definition = mcp_agent_method(name), args = mcp_field(line,"args");
            assert(mcp_agent_valid(definition,args));
            char *method = mcp_string(mcp_field(definition.p,"method"));
            char *operation = mcp_string(mcp_field(line,"operationId"));
            long long seen = -1; mj_int(mcp_field(line,"seen"),&seen);
            long long fail_after = 0; mj_val fault = mcp_field(line,"failReservationAfter");
            if (fault.p) mj_int(fault,&fail_after);
            state.reserve = fail_after > 0 ? reserve_countdown : NULL;
            state.reserve_context = &fail_after;
            char *result = mcp_agent_execute(ctx,&state,method,args,seen,operation);
            assert(result); puts(result); fflush(stdout);
            free(result); free(name); free(method); free(operation);
        }
        free(line); mcp_agent_clear(&state); nnh_context_close(ctx); return 0;
    }
    if (argc == 2 && !strcmp(argv[1],"request")) {
        char *line = NULL; size_t cap = 0;
        assert(getline(&line,&cap,stdin) >= 0 && mj_valid(line));
        char *name = mcp_string(mcp_field(line,"name"));
        mj_val definition = mcp_agent_method(name), args = mcp_field(line,"args");
        assert(mcp_agent_valid(definition,args));
        char *method = mcp_string(mcp_field(definition.p,"method"));
        char *request_id = mcp_string(mcp_field(line,"operationId"));
        long long revision = -1; mj_int(mcp_field(line,"revision"),&revision);
        char *out = mcp_agent_request(method,args,revision,request_id);
        assert(out); puts(out);
        free(out); free(line); free(name); free(method); free(request_id);
        return 0;
    }
    if (argc == 2 && (!strcmp(argv[1],"present") || !strcmp(argv[1],"present-compact"))) {
        char *line = NULL; size_t cap = 0;
        while (getline(&line,&cap,stdin) >= 0) {
            assert(mj_valid(line)); char *out = mcp_agent_present_mode(line,0,!strcmp(argv[1],"present-compact"));
            assert(out); puts(out); free(out);
        }
        free(line); return 0;
    }
    char alias[128];
    /* Seed-44 play exposed an unidentified remembered marker. Unchanged
     * unknown appearance is not a new creature on every walking step. */
    const char *marker = "{\"observation\":{\"world\":[{\"x\":43,\"y\":9,\"occupant\":{\"kind\":\"creature\",\"mark\":\"I\"}}]}}";
    const char *empty = "{\"observation\":{\"world\":[]}}";
    const char *identified = "{\"observation\":{\"world\":[{\"x\":43,\"y\":9,\"occupant\":{\"kind\":\"creature\",\"appearance\":\"goblin\"}}]}}";
    const char *moved_marker = "{\"observation\":{\"world\":[{\"x\":44,\"y\":9,\"occupant\":{\"kind\":\"creature\",\"mark\":\"I\"}}]}}";
    assert(!mcp_agent_new_creature(marker,marker));
    assert(mcp_agent_new_creature(empty,marker));
    assert(mcp_agent_new_creature(marker,identified));
    assert(mcp_agent_new_creature(marker,moved_marker));
    const char *healthy="{\"observation\":{\"vitals\":{\"condition\":[],\"hunger\":\"not_hungry\"}}}";
    const char *blind="{\"observation\":{\"vitals\":{\"condition\":[\"blind\"],\"hunger\":\"not_hungry\"}}}";
    const char *hungry="{\"observation\":{\"vitals\":{\"condition\":[],\"hunger\":\"hungry\"}}}";
    assert(!mcp_agent_vitals_changed(healthy,healthy));
    assert(mcp_agent_vitals_changed(healthy,blind));
    assert(mcp_agent_vitals_changed(blind,healthy));
    assert(mcp_agent_vitals_changed(healthy,hungry));
    nnh_choice_name(" Force Bolt! ",alias,sizeof alias); assert(!strcmp(alias,"force-bolt"));
    nnh_choice_name("force---bolt",alias,sizeof alias); assert(!strcmp(alias,"force-bolt"));
    nnh_choice_name("Éclair 魔法",alias,sizeof alias); assert(!strcmp(alias,"Éclair-魔法"));
    nnh_choice_name("???",alias,sizeof alias); assert(!strcmp(alias,"option"));
    char small[3]; nnh_choice_name("魔法",small,sizeof small); assert(!strcmp(small,""));
    mcp_agent_state choices = {0};
    choices.snapshot = strdup("{\"revision\":4,\"decision\":{\"id\":\"question\",\"kind\":\"choice\",\"options\":[{\"id\":1,\"name\":\"same\",\"label\":\"Same\"},{\"id\":2,\"name\":\"same\",\"label\":\"Same!\"}]}}");
    char *clarified = mcp_agent_execute(NULL,&choices,"decision.answer",(mj_val){"{\"sessionId\":\"abcdefghijklmnop\",\"decisionId\":\"question\",\"answer\":{\"kind\":\"choice\",\"choose\":[\"same\"]}}"},4,"unused");
    assert(clarified && strstr(clarified,"ambiguousName") && !choices.pending && !choices.last); free(clarified);
    clarified = mcp_agent_execute(NULL,&choices,"decision.answer",(mj_val){"{\"sessionId\":\"abcdefghijklmnop\",\"decisionId\":\"question\",\"answer\":{\"kind\":\"choice\",\"choose\":[\"missing\"]}}"},4,"unused");
    assert(clarified && strstr(clarified,"unknownName") && !choices.pending); free(clarified);
    mcp_agent_clear(&choices);
    mj_val go = mcp_agent_method("go"), answer = mcp_agent_method("decision_answer");
    assert(go.p && answer.p && !mcp_agent_method("game_move").p);
    assert(mcp_agent_valid(go,(mj_val){"{\"sessionId\":\"abcdefghijklmnop\",\"to\":{\"x\":1,\"y\":0}}"}));
    assert(!mcp_agent_valid(go,(mj_val){"{\"sessionId\":\"abcdefghijklmnop\",\"to\":{\"x\":1,\"y\":0},\"expectedRevision\":0}"}));
    assert(!mcp_agent_valid(go,(mj_val){"{\"sessionId\":\"abcdefghijklmnop\",\"to\":{\"x\":1,\"y\":0},\"force\":\"yes\"}"}));
    assert(!mcp_agent_valid(go,(mj_val){"{\"sessionId\":\"abcdefghijklmnop\",\"to\":{\"x\":80,\"y\":0}}"}));
    const char *args = "{\"sessionId\":\"abcdefghijklmnop\",\"decisionId\":\"standing-context\",\"answer\":{\"kind\":\"confirmation\",\"confirm\":false}}";
    assert(mcp_agent_valid(answer,(mj_val){args}));
    assert(!mcp_agent_valid(answer,(mj_val){"{\"sessionId\":\"abcdefghijklmnop\",\"answer\":{\"kind\":\"confirmation\",\"confirm\":false}}"}));
    char *request = mcp_agent_request("decision.answer",(mj_val){args},7,"unique-operation");
    assert(request && mj_valid(request));
    mj_val params = mcp_field(request,"params"); long long revision;
    assert(mj_int(mcp_field(params.p,"expectedRevision"),&revision) && revision == 7);
    char *id = mcp_string(mcp_field(params.p,"decisionId")); assert(id && !strcmp(id,"standing-context")); free(id);
    int confirm = 1; assert(mj_bool(mcp_field(mcp_field(params.p,"answer").p,"confirm"),&confirm) && !confirm);
    free(request);
    assert(!mcp_agent_request("game.wait",(mj_val){"{\"requestId\":\"caller\"}"},1,"adapter"));
    assert(mcp_agent_uncertain("{\"outcome\":{\"status\":\"unknown\"}}"));
    assert(mcp_agent_uncertain("{\"error\":{\"code\":\"incompleteRequest\"}}"));
    assert(!mcp_agent_uncertain("{\"error\":{\"code\":\"staleRevision\"}}"));
    char *help = mcp_agent_help((mj_val){"{}"}); assert(help && !strstr(help,"inputSchema")); free(help);
    help = mcp_agent_help((mj_val){"{\"name\":\"go\"}"}); assert(help && strstr(help,"inputSchema")); free(help);
    puts("native MCP agent schema, guards and uncertainty checks passed");
    return 0;
}
