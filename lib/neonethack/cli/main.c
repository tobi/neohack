/* Public v1 JSON-lines transport. No engine protocol or legacy act method. */
#define _POSIX_C_SOURCE 200809L
#include "neonethack.h"
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv)
{
    nnh_context *context = NULL;
    nnh_config config = {sizeof config, NULL, NULL, NULL};
    char line[NNH_MAX_REQUEST_BYTES + 1];
    size_t used = 0;
    int c, oversized = 0;
    if (argc == 2 && !strcmp(argv[1], "--version")) { puts(nnh_version()); return 0; }
    if (argc != 4) { fprintf(stderr, "usage: %s ENGINE DATA SESSIONS\n", argv[0]); return 2; }
    config.engine_path = argv[1]; config.data_path = argv[2]; config.sessions_path = argv[3];
    signal(SIGPIPE, SIG_IGN);
    if (nnh_context_open(&config, &context) != NNH_OK) { perror("neonethack: open"); return 1; }
    while ((c = fgetc(stdin)) != EOF) {
        nnh_result *result = NULL;
        if (c != '\n') {
            if (used < sizeof line) line[used++] = (char)c;
            else oversized = 1;
            continue;
        }
        if (used && line[used - 1] == '\r') used--;
        /* Bounded, length-delimited input: NUL bytes cannot truncate a command
         * or make the parser consume the following frame. */
        if (oversized || used > NNH_MAX_REQUEST_BYTES) {
            puts("{\"version\":1,\"error\":{\"code\":\"invalidFrame\",\"message\":\"request exceeds the frame limit\"}}");
        } else {
            if (nnh_dispatch(context, line, used, &result) != NNH_OK) {
                fprintf(stderr, "neonethack: library call failed; transport is retiring\n");
                nnh_context_close(context); return 1;
            }
            puts(nnh_result_json(result));
            nnh_result_free(result);
        }
        used = 0; oversized = 0;
        if (fflush(stdout)) break;
    }
    if (used || oversized) {
        puts("{\"version\":1,\"error\":{\"code\":\"invalidFrame\",\"message\":\"request must end with LF\"}}");
        fflush(stdout);
    }
    nnh_context_close(context);
    return ferror(stdin) ? 1 : 0;
}
