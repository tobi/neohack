/* libneonethack Explorer API — the API_DESING.md contract in C.
 *
 * One implementation serves every binding (CLI, MCP, WASM): requests and
 * responses are JSON strings; game shapes follow the design document
 * (tools new_game/get_state/act/resume/end_session, full observations,
 * typed decisions, outcomes, revisions, terminal results).
 *
 * Threading: a handle is NOT thread-safe; serialize calls per handle.
 * The engine stays a separate child process per game session (see
 * neonethack.h for why in-process embedding is unsafe).
 *
 * Memory: nhx_call returns a malloc'd NUL-terminated JSON response;
 * release it with nhx_free. The response is always a result envelope
 * (semantic errors ride inside it, never as NULL), except on OOM.
 *
 * Build (native):
 *   cc -O2 -Wall -Wextra -I. -c session.c minjson.c explorer.c
 *   ar rcs libneonethack.a session.o minjson.o explorer.o
 */
#ifndef NEONETHACK_EXPLORER_H
#define NEONETHACK_EXPLORER_H

typedef struct nhx nhx_t;

/* Open a world-set. engine_bin is the headless engine binary,
 * template_dir its playground template, sessions_dir the root holding
 * per-session dirs (input log, sidecar, playground). All three must
 * exist. Returns NULL with errno set on failure. */
nhx_t *nhx_open(const char *engine_bin, const char *template_dir,
                const char *sessions_dir);

/* One tool call. request_json is e.g.
 * {"tool":"act","sessionId":"...","requestId":"...","expectedRevision":3,
 *  "action":"move","direction":"north"}
 * Returns a malloc'd response envelope (see API_DESING.md section 6);
 * release with nhx_free. Returns NULL only on allocation failure. */
char *nhx_call(nhx_t *x, const char *request_json);

void nhx_free(char *s);

/* Close all engines, free everything. Game state stays on disk under
 * sessions_dir (input logs + sidecars); re-open to continue. */
void nhx_close(nhx_t *x);

#endif /* NEONETHACK_EXPLORER_H */
