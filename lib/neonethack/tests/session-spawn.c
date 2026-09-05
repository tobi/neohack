#define _POSIX_C_SOURCE 200809L
#include "session.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
/* Link wrapping traps forbidden work in the post-fork, pre-exec child. */
static int fork_child;
static void child_started(void) { fork_child = 1; }
void *__real_malloc(size_t); void *__real_calloc(size_t, size_t);
char *__real_strdup(const char *); char *__real_getenv(const char *);
int __real_setenv(const char *, const char *, int);
void *__wrap_malloc(size_t n) { if (fork_child) _exit(91); return __real_malloc(n); }
void *__wrap_calloc(size_t n, size_t s) { if (fork_child) _exit(92); return __real_calloc(n, s); }
char *__wrap_strdup(const char *s) { if (fork_child) _exit(93); return __real_strdup(s); }
char *__wrap_getenv(const char *s) { if (fork_child) _exit(94); return __real_getenv(s); }
int __wrap_setenv(const char *n, const char *v, int r) { if (fork_child) _exit(95); return __real_setenv(n, v, r); }
static void line(nh_session_t *session, const char *expected) {
    char *value = nh_session_read_line(session, 2000);
    assert(value && !strcmp(value, expected)); free(value);
}
int main(int argc, char **argv) {
    int closed, original[3], i;
    nh_session_t *session;
    char *extra[] = {"argument with spaces", NULL};
    assert(argc == 2);
    assert(pthread_atfork(NULL, NULL, child_started) == 0);
    assert(setenv("NETHACKDIR", "/host-value-must-not-change", 1) == 0);
    for (closed = 0; closed < 2; ++closed) {
        if (closed) assert(setenv("NETHACKOPTIONS", "!tutorial,notime", 1) == 0);
        else assert(unsetenv("NETHACKOPTIONS") == 0);
        for (i = 0; i < 3; ++i) { original[i] = fcntl(i, F_DUPFD_CLOEXEC, 3); assert(original[i] >= 3); }
        if (closed) for (i = 0; i < 3; ++i) close(i);
        session = nh_session_start(argv[1], "/tmp", extra);
        for (i = 0; i < 3; ++i) { assert(dup2(original[i], i) == i); close(original[i]); }
        assert(session);
        assert(!strcmp(getenv("NETHACKDIR"), "/host-value-must-not-change"));
        if (!closed) assert(getenv("NETHACKOPTIONS") == NULL);
        line(session, "/tmp"); line(session, "/tmp");
        line(session, closed ? "!tutorial,notime" : "!tutorial,time");
        line(session, "argument with spaces");
        assert(nh_session_write(session, "received") == 0);
        line(session, "received");
        assert(nh_session_close(session) == 0);
    }
    {
        char *profile[] = { "--runtime-v1=1000", "argument with spaces", NULL };
        assert(setenv("NNH_FORBIDDEN", "must not inherit", 1) == 0);
        session = nh_session_start(argv[1], "/tmp", profile); assert(session);
        line(session, "/tmp"); line(session, "."); line(session, "!tutorial,time");
        line(session, "argument with spaces"); line(session, "isolated");
        assert(nh_session_write(session, "received") == 0); line(session, "received");
        assert(nh_session_close(session) == 0);
        assert(!strcmp(getenv("NNH_FORBIDDEN"), "must not inherit"));
        assert(!strcmp(getenv("NETHACKOPTIONS"), "!tutorial,notime"));
    }
    {
        char *too_many[258];
        for (i = 0; i < 257; ++i) too_many[i] = "argument";
        too_many[257] = NULL; errno = 0;
        assert(nh_session_start(argv[1], "/tmp", too_many) == NULL);
        assert(errno == E2BIG);
    }
    return 0;
}
