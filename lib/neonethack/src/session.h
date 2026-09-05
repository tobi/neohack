/* neonethack session library — drive a headless NetHack engine over its
 * NDJSON JSON-RPC protocol from C.
 *
 * The engine is a separate process (one game per process; NetHack's
 * globals and exit() calls make in-process embedding unsafe). This
 * library manages that process: spawn, line-oriented writes, reads with
 * timeout, and teardown.
 *
 * Every line is one LF-terminated JSON-RPC message, no embedded newlines.
 * Returned lines are malloc'd; the caller frees them. NULL from read
 * means timeout (EAGAIN) or EOF/closed (errno set: 0 on clean EOF).
 *
 * Build: cc -I. -c session.c && ar rcs libneonethack.a session.o
 */
#ifndef NNH_SESSION_PRIVATE_H
#define NNH_SESSION_PRIVATE_H
#include "symbols.h"

typedef struct nh_session nh_session_t;

/* Start `binpath` with cwd `hackdir` (the playground holding nhdat,
 * sysconf, …). extra_argv is NULL-terminated extra args or NULL. The private
 * --runtime-v1=EPOCH bootstrap flag selects a minimal child environment;
 * unprofiled standalone peers retain the legacy inherited environment.
 * Returns NULL on failure with errno set. */
nh_session_t *nh_session_start(const char *binpath, const char *hackdir,
                               char *const extra_argv[]);

/* As above, but the child keeps one duplicate of lease_fd until it exits.
 * Other sessions' descriptors remain close-on-exec. This prevents a crashed
 * bridge from releasing ownership while its engine is still saving/exiting. */
nh_session_t *nh_session_start_with_lease(const char *binpath, const char *hackdir,
                                         char *const extra_argv[], int lease_fd);

/* Write one protocol line (LF appended). Returns 0 ok, -1 on error. */
int nh_session_write(nh_session_t *s, const char *line);

/* Read one protocol line. Waits up to timeout_ms (<0 blocks forever).
 * Returns a malloc'd NUL-terminated line WITHOUT the trailing newline,
 * or NULL on timeout (errno=EAGAIN) / EOF / error. */
char *nh_session_read_line(nh_session_t *s, int timeout_ms);

/* Close stdin and drain/wait for at most two seconds of graceful shutdown.
 * Kill and reap our child if it stalls; free everything. Callers must persist
 * their input journal before closing. Returns waitpid status, or -1 on error. */
int nh_session_close(nh_session_t *s);
/* Abort our child without offering EOF as an answer to a pending prompt. */
int nh_session_abort(nh_session_t *s);

/* True once the engine has exited / the pipe hit EOF. */
int nh_session_ended(nh_session_t *s);

#endif /* NNH_SESSION_PRIVATE_H */
