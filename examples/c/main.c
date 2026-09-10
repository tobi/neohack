/* A client of the installed public C API; no engine/private headers. */
#include <neonethack.h>
#include <stdio.h>
int main(int argc, char **argv)
{
    nnh_context *worlds = NULL;
    nnh_result *result = NULL;
    nnh_config config = {sizeof config, NULL, NULL, NULL};
    nnh_identity hero = {
        .name = "C explorer", .role = "valkyrie", .race = "dwarf",
        .gender = "female", .align = "lawful", .has_seed = 1, .seed = 42,
        .harness_name = "C example"
    };
    nnh_guard guard = {"first-wait", 0};
    char session[65];
    int status = 1;
    if (argc != 4) { fprintf(stderr, "usage: %s ENGINE DATA SESSIONS\n", argv[0]); return 2; }
    config.engine_path = argv[1]; config.data_path = argv[2]; config.sessions_path = argv[3];
    if (nnh_context_open(&config, &worlds) != NNH_OK) goto done;
    if (nnh_session_create(worlds, &hero, &result) != NNH_OK || nnh_result_error(result)) goto done;
    snprintf(session, sizeof session, "%s", nnh_result_session(result));
    guard.expected_revision = nnh_result_revision(result);
    nnh_result_free(result); result = NULL;
    if (nnh_game_wait(worlds, session, &guard, &result) != NNH_OK || nnh_result_error(result)) goto done;
    puts(nnh_result_json(result));
    status = 0;
done:
    if (status && result) fprintf(stderr, "%s\n", nnh_result_json(result));
    nnh_result_free(result);
    nnh_context_close(worlds); /* leaves journals for explicit resume */
    return status;
}
