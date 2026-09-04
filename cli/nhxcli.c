/* nhxcli: stdin/stdout JSON-lines bridge for libneonethack.
 *
 * One line in  -> {"tool":"new_game",...} (any nhx_call request)
 * One line out -> the response envelope
 * {"tool":"shutdown"} exits 0; EOF also exits 0. Diagnostics go to stderr.
 *
 * Usage: nhxcli <engine_bin> <template_dir> <sessions_dir>
 */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>

#include "explorer.h"

int
main(int argc, char **argv)
{
    nhx_t *x;
    char *line = NULL;
    size_t cap = 0;
    ssize_t n;
    if (argc != 4) {
        fprintf(stderr, "usage: %s <engine_bin> <template_dir> <sessions_dir>\n",
                argv[0]);
        return 2;
    }
    /* A dead engine is a session error, not a reason to kill the bridge
     * and every other world it owns. Writes then return EPIPE normally. */
    signal(SIGPIPE, SIG_IGN);
    x = nhx_open(argv[1], argv[2], argv[3]);
    if (!x) {
        fprintf(stderr, "nhxcli: cannot open sessions\n");
        return 1;
    }
    while ((n = getline(&line, &cap, stdin)) > 0) {
        char *resp;
        while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r'))
            line[--n] = '\0';
        if (!n)
            continue;
        if (!strcmp(line, "{\"tool\":\"shutdown\"}"))
            break;
        resp = nhx_call(x, line);
        if (!resp) {
            fprintf(stderr, "nhxcli: null response\n");
            continue;
        }
        fputs(resp, stdout);
        fputc('\n', stdout);
        fflush(stdout);
        nhx_free(resp);
    }
    free(line);
    nhx_close(x);
    return 0;
}
