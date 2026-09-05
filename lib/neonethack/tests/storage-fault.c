/* Linux-only test interposer. Never installed or linked into production.
 * Faults and pipe tracing apply only to the explicitly named test bridge PID,
 * never its engine or an unrelated process. No game behavior is injected. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
/* Only the explicitly launched test bridge loads this module. Profiled
 * engines must not inherit it. Monotonic clocks/timeouts are never faked. */
time_t time(time_t *out)
{
    static time_t (*real_time)(time_t *);
    const char *path = getenv("NNH_TEST_CLOCK");
    char text[40] = {0}; int fd; ssize_t n;
    if (!real_time) real_time = dlsym(RTLD_NEXT, "time");
    if (path && (fd = open(path, O_RDONLY | O_CLOEXEC)) >= 0) {
        n = read(fd, text, sizeof text - 1); close(fd);
        if (n > 0) { time_t result = (time_t) strtoll(text, NULL, 10); if (out) *out = result; return result; }
    }
    return real_time(out);
}
static int owner(void)
{
    const char *file = getenv("NNH_TEST_OWNER");
    char text[32] = {0}; int fd; ssize_t n;
    if (!file || (fd = open(file, O_RDONLY | O_CLOEXEC)) < 0) return 0;
    n = read(fd, text, sizeof text - 1); close(fd);
    return n > 0 && strtol(text, NULL, 10) == (long)getpid();
}
ssize_t write(int fd, const void *bytes, size_t length)
{
    static ssize_t (*real_write)(int, const void *, size_t);
    const char *trace = getenv("NNH_TEST_WRITES"); struct stat st; int saved = errno;
    if (!real_write) real_write = dlsym(RTLD_NEXT, "write");
    if (trace && fd > 2 && owner() && !fstat(fd, &st) && S_ISFIFO(st.st_mode)) {
        int log = open(trace, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
        if (log >= 0) { real_write(log, bytes, length); close(log); }
    }
    errno = saved; return real_write(fd, bytes, length);
}
int fsync(int fd)
{
    static int (*real_sync)(int);
    static int boundary_saves;
    const char *control = getenv("NNH_TEST_FAULT");
    char mode[32] = {0}, link[64], path[4096]; int input, saved = errno; ssize_t n;
    if (!real_sync) real_sync = dlsym(RTLD_NEXT, "fsync");
    if (control && owner() && (input = open(control, O_RDONLY | O_CLOEXEC)) >= 0) {
        n = read(input, mode, sizeof mode - 1); close(input);
        snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
        n = n > 0 ? readlink(link, path, sizeof path - 1) : -1;
        if (n > 0) {
            path[n] = 0;
            if ((!strcmp(mode, "boundary") && strstr(path, "/.session-meta-") && ++boundary_saves > 1) ||
                (!strcmp(mode, "reservation") && strstr(path, "/requests.seen.jsonl")) ||
                (!strcmp(mode, "input") && strstr(path, "/input.log.jsonl")) ||
                (!strcmp(mode, "sidecar") && strstr(path, "/.session-meta-")) ||
                (!strcmp(mode, "data") && strstr(path, "/perceptions.jsonl")) ||
                (!strcmp(mode, "index") && strstr(path, "/perceptions.index.jsonl")) ||
                (!strcmp(mode, "meta") && strstr(path, "/.run-meta-"))) {
                errno = ENOSPC; return -1;
            }
        }
    }
    errno = saved; return real_sync(fd);
}
