#define _POSIX_C_SOURCE 200809L
#include "neonethack.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static nnh_result *call(nnh_context *x, const char *json)
{
    nnh_result *r = NULL;
    assert(nnh_dispatch(x, json, strlen(json), &r) == NNH_OK && r);
    return r;
}
static void success(nnh_status s, nnh_result *r)
{
    if (s != NNH_OK || nnh_result_error(r)) fprintf(stderr, "Unexpected: %d %s\n", s, nnh_result_json(r));
    assert(s == NNH_OK && r && !nnh_result_error(r));
}
static void rejected(nnh_status s, nnh_result *r)
{
    assert(s == NNH_OK && r && nnh_result_error(r) && !strcmp(nnh_result_error(r), "invalidParams"));
    nnh_result_free(r);
}
int main(int argc, char **argv)
{
    char directory[] = "/tmp/neonethack-api-XXXXXX", sid[65], json[1024];
    nnh_config config = {sizeof config, NULL, NULL, NULL};
    nnh_identity identity = {"Library", "valkyrie", "dwarf", "female", "lawful", 1, 42, NULL};
    nnh_context *x = NULL;
    nnh_result *r = NULL, *retry = NULL;
    nnh_status s;
    nnh_guard guard = {"wait-1", 0};
    int64_t before;
    size_t i;
    const char *invalid[] = {
        "{\"version\":1,\"method\":\"game.wait\",\"params\":{}}",
        "{\"version\":1,\"method\":\"session.observe\",\"params\":{\"sessionId\":\"../escape\"}}",
        "{\"version\":1,\"method\":\"session.create\",\"params\":{\"role\":\"fake\"}}",
        "{\"version\":1,\"method\":\"session.create\",\"params\":{\"role\":\"wizard\",\"role\":\"tourist\"}}",
        "{\"version\":1,\"method\":\"session.create\",\"params\":{\"key\":32}}",
        "{\"version\":1,\"method\":\"protocol.describe\",\"params\":{},\"tool\":\"act\"}",
        "{\"version\":1,\"version\":1,\"method\":\"protocol.describe\",\"params\":{}}",
        "{\"version\":2,\"method\":\"protocol.describe\",\"params\":{}}",
        "{\"version\":1,\"method\":\"act\",\"params\":{}}",
        "{\"version\":1,\"method\":\"session.create\",\"params\":{\"name\":\"x\\u0000y\"}}",
    };
    assert(argc == 3 && mkdtemp(directory));
    config.engine_path = argv[1]; config.data_path = argv[2]; config.sessions_path = directory;
    config.size--;
    assert(nnh_context_open(&config, &x) == NNH_INVALID_ARGUMENT && x == NULL);
    config.size++;
    assert(nnh_context_open(&config, &x) == NNH_OK);
    assert(nnh_dispatch(x, "{}", 2, NULL) == NNH_INVALID_ARGUMENT);
    for (i = 0; i < sizeof invalid / sizeof invalid[0]; i++) { r = call(x, invalid[i]); assert(nnh_result_error(r)); nnh_result_free(r); }
    r = call(x, "{\"version\":1,\"method\":\"protocol.describe\",\"params\":{}}");
    assert(!nnh_result_error(r) && strstr(nnh_result_json(r), "decision.answer")); nnh_result_free(r);
    s = nnh_session_create(x, &identity, &r); success(s, r);
    snprintf(sid, sizeof sid, "%s", nnh_result_session(r)); guard.expected_revision = nnh_result_revision(r);
    assert(strstr(nnh_result_json(r), "\"observation\"") && !strstr(nnh_result_json(r), "\"glyph\""));
    nnh_result_free(r);
    guard.request_id = "counted-search";
    s = nnh_game_search(x, sid, &guard, 2, &r); success(s,r);
    guard.expected_revision = nnh_result_revision(r); nnh_result_free(r);
    guard.request_id = "counted-rest";
    s = nnh_game_rest(x, sid, &guard, 2, &r); success(s,r);
    guard.expected_revision = nnh_result_revision(r); nnh_result_free(r);
    guard.request_id = "wait-1";
    s = nnh_game_wait(x, sid, &guard, &r); success(s, r);
    before = nnh_result_revision(r);
    s = nnh_game_wait(x, sid, &guard, &retry); success(s, retry);
    assert(!strcmp(nnh_result_json(r), nnh_result_json(retry)));
    nnh_result_free(r); nnh_result_free(retry);
    snprintf(json, sizeof json, "{\"version\":1,\"method\":\"game.wait\",\"params\":{\"sessionId\":\"%s\",\"requestId\":\"typo\",\"expectedRevision\":%lld,\"direction\":\"north\"}}", sid, (long long)before);
    r = call(x, json); assert(!strcmp(nnh_result_error(r), "invalidParams")); nnh_result_free(r);
    s = nnh_session_observe(x, sid, &r); success(s, r); assert(nnh_result_revision(r) == before); nnh_result_free(r);
    s = nnh_game_move(x, sid, &guard, NNH_UP, &r); assert(s == NNH_OK && nnh_result_error(r)); nnh_result_free(r);
    guard.request_id = "invalid-typed"; guard.expected_revision = before;
    {
        nnh_item ambiguous = {"item-1", "dagger"};
        nnh_target target = {(nnh_target_kind)99, NNH_NORTH};
        nnh_answer answers[] = {
            {(nnh_answer_kind)99, {.confirm = 0}},
            {NNH_ANSWER_CONFIRMATION, {.confirm = 2}},
            {NNH_ANSWER_CHOICE, {.choice = {NULL, 65}}},
            {NNH_ANSWER_CHOICE, {.choice = {NULL, 1}}},
            {NNH_ANSWER_TEXT, {.text = NULL}},
            {NNH_ANSWER_ITEM, {.item = {NULL, NULL}}},
            {NNH_ANSWER_TARGET, {.target = {(nnh_target_kind)99, NNH_NORTH}}},
        };
        s = nnh_game_move(x, sid, &guard, (nnh_direction)-1, &r); rejected(s, r);
        s = nnh_game_move(x, sid, &guard, (nnh_direction)99, &r); rejected(s, r);
        s = nnh_game_eat(x, sid, &guard, &ambiguous, &r); rejected(s, r);
        { nnh_item negative = {"item-1", NULL, -1}, named_count = {NULL, "dagger", 2};
          s = nnh_game_drop(x, sid, &guard, &negative, &r); rejected(s, r);
          s = nnh_game_drop(x, sid, &guard, &named_count, &r); rejected(s, r); }
        { nnh_run_options badmode = {(nnh_run_mode)99, 0}, badflag = {NNH_RUN_NORMAL, 2};
          s = nnh_game_run(x,sid,&guard,NNH_WEST,&badmode,&r); rejected(s,r);
          s = nnh_game_run(x,sid,&guard,NNH_WEST,&badflag,&r); rejected(s,r);
          s = nnh_game_search(x,sid,&guard,0,&r); rejected(s,r);
          s = nnh_game_rest(x,sid,&guard,1001,&r); rejected(s,r); }
        s = nnh_game_move_without_attack(x, sid, &guard, NNH_UP, &r); rejected(s, r);
        s = nnh_game_kick(x, sid, &guard, &target, &r); rejected(s, r);
        s = nnh_game_wait(x, sid, NULL, &r); rejected(s, r);
        for (i = 0; i < sizeof answers / sizeof answers[0]; i++) {
            s = nnh_decision_answer(x, sid, &guard, "decision-1", &answers[i], &r); rejected(s, r);
        }
        s = nnh_session_observe(x, sid, &r); success(s, r);
        assert(nnh_result_revision(r) == before); nnh_result_free(r);
    }
    guard.request_id = "typed-throw"; guard.expected_revision = before;
    { nnh_item dagger = {NULL, "dagger", 0}; nnh_target down = {NNH_TARGET_DIRECTION, NNH_DOWN};
      s = nnh_game_throw(x, sid, &guard, &dagger, &down, &r); success(s, r);
      assert(strstr(nnh_result_json(r), "\"action\":\"throw\"") && strstr(nnh_result_json(r), "\"turnsElapsed\":1"));
      s = nnh_game_throw(x, sid, &guard, &dagger, &down, &retry); success(s, retry);
      assert(!strcmp(nnh_result_json(r), nnh_result_json(retry)));before=nnh_result_revision(r);
      nnh_result_free(r);nnh_result_free(retry); }
    guard.request_id = "prayer"; guard.expected_revision = before;
    s = nnh_game_pray(x, sid, &guard, &r); success(s, r);
    assert(strstr(nnh_result_json(r), "\"kind\":\"confirmation\""));
    before = nnh_result_revision(r); nnh_result_free(r);
    s = nnh_session_close(x, sid, &r); success(s, r); nnh_result_free(r);
    nnh_context_close(x);
    assert(nnh_context_open(&config, &x) == NNH_OK);
    s = nnh_session_resume(x, sid, &r); success(s, r);
    assert(nnh_result_revision(r) == before && strstr(nnh_result_json(r), "\"kind\":\"confirmation\""));
    nnh_context_close(x);
    assert(nnh_result_revision(r) == before && strstr(nnh_result_json(r), "\"kind\":\"confirmation\""));
    nnh_result_free(r);
    puts("Public C API: strict schemas, typed calls, exact retries and pending resume passed.");
    return 0;
}
