/* Test-only Linux fsync failure injection; never linked into shipped binaries.
 * Uses a per-test control file, and does not change any NetHack game behavior. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>

/* Observe only the test bridge's FIFO writes, never the engine's telemetry. */
ssize_t write(int fd, const void *buffer, size_t length)
{
    static ssize_t (*original_write)(int, const void *, size_t);
    const char *owner = getenv("NH_TEST_BRIDGE_PID_FILE"), *trace = getenv("NH_TEST_ENGINE_WRITES");
    char pid[32] = {0}; struct stat st;
    int input, saved = errno;
    if (!original_write) original_write = dlsym(RTLD_NEXT, "write");
    if (owner && trace && fd > 2 && (input = open(owner, O_RDONLY)) >= 0) {
        ssize_t n = read(input, pid, sizeof pid - 1); close(input);
        if (n > 0 && strtol(pid, NULL, 10) == (long) getpid() && !fstat(fd, &st) && S_ISFIFO(st.st_mode)) {
            int log = open(trace, O_WRONLY | O_CREAT | O_APPEND, 0600);
            if (log >= 0) { original_write(log, buffer, length); close(log); }
        }
    }
    errno = saved;
    return original_write(fd, buffer, length);
}

int fsync(int fd)
{
    static int (*original)(int);
    const char *control = getenv("NH_TEST_RECORDING_FAILURE");
    char mode[16] = {0}, path[4096], link[64];
    int input;
    ssize_t n;
    if (!original) original = dlsym(RTLD_NEXT, "fsync");
    if (control && (input = open(control, O_RDONLY)) >= 0) {
        n = read(input, mode, sizeof mode - 1); close(input);
        snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
        n = n > 0 ? readlink(link, path, sizeof path - 1) : -1;
        if (n > 0) {
            path[n] = 0;
            if ((!strcmp(mode, "data") && strstr(path, "/perceptions.jsonl")) ||
                (!strcmp(mode, "index") && strstr(path, "/perceptions.index.jsonl")) ||
                (!strcmp(mode, "meta") && strstr(path, "/.run-meta-")) ||
                (!strcmp(mode, "sidecar") && strstr(path, "/.session-meta-")) ||
                (!strcmp(mode, "input") && strstr(path, "/input.log.jsonl"))) {
                errno = ENOSPC;
                return -1;
            }
        }
    }
    return original(fd);
}
