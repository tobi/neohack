/* Test-only interposer: stop after the driver committed its receipt, immediately
 * before the worker publishes its full response to the supervisor. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int puts(const char *text)
{
    int (*original)(const char *) = dlsym(RTLD_NEXT,"puts");
    const char *armed = getenv("NNH_TEST_STOP_REPLY");
    if (armed && strstr(text,"\"outcome\"") && !unlink(armed)) raise(SIGSTOP);
    return original(text);
}

/* Observe only supervisor admission, never engine input. The test filters by
 * the server PID; mcp_route captures its revision synchronously after minting. */
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <sys/syscall.h>
int open(const char *path, int flags, ...)
{
    int (*original)(const char *, int, ...) = dlsym(RTLD_NEXT, "open");
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, int);
        va_end(args);
    }
    int fd = original(path, flags, mode);
    const char *log = getenv("NNH_TEST_ADMISSIONS");
    if (log && !strcmp(path, "/dev/urandom")) {
        int out = syscall(SYS_openat, AT_FDCWD, log,
                          O_CREAT | O_WRONLY | O_APPEND, 0600);
        if (out >= 0) {
            char line[64];
            int length = snprintf(line, sizeof line, "%ld\n", (long) getpid());
            (void) write(out, line, length);
            close(out);
        }
    }
    return fd;
}
