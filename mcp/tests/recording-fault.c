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
                (!strcmp(mode, "meta") && strstr(path, "/.run-meta-"))) {
                errno = ENOSPC;
                return -1;
            }
        }
    }
    return original(fd);
}
