/* neonethack session library — see session.h. POSIX C99, no deps. */
#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L
#define _XOPEN_SOURCE 700

#include "session.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <time.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

struct nh_session {
    pid_t pid;
    int wfd;          /* parent -> engine stdin */
    int rfd;          /* engine stdout -> parent */
    int ended;        /* EOF seen or child reaped */
    int status;       /* child status once reaped */
    int reaped;
    char *buf;        /* pending bytes */
    size_t len, cap;
};

extern char **environ;

static void
free_environment(char **env)
{
    size_t i;
    if (env) { for (i = 0; env[i]; ++i) free(env[i]); free(env); }
}

/* Build all malloc-backed state before fork. The child must use only
 * async-signal-safe operations even when its C host has other threads. */
static char **
engine_environment(const char *directory, int isolated)
{
    size_t count = 0, used = 0, i, length = strlen(directory);
    int have_options = 0;
    char **env;
    if (isolated) {
        /* Profile 1 does not inherit loader hooks, option filenames, user
         * homes or locale/time-zone settings. Paths/data remain trusted. */
        const char *fixed[] = { "NETHACKDIR=.", "HOME=.", "USER=Explorer",
            "LOGNAME=Explorer", "NETHACKOPTIONS=!tutorial,time", "LC_ALL=C",
            "LANG=C", "TZ=UTC0", "PATH=/usr/bin:/bin", NULL };
        env = calloc(sizeof fixed / sizeof fixed[0], sizeof *env);
        if (!env) return NULL;
        for (i = 0; fixed[i]; ++i) if (!(env[i] = strdup(fixed[i]))) goto fail;
        return env;
    }
    while (environ && environ[count]) ++count;
    if (count > SIZE_MAX / sizeof(char *) - 3) { errno = ENOMEM; return NULL; }
    env = calloc(count + 3, sizeof *env);
    if (!env) return NULL;
    for (i = 0; i < count; ++i) {
        if (!strncmp(environ[i], "NETHACKDIR=", 11)) continue;
        if (!strncmp(environ[i], "NETHACKOPTIONS=", 15)) have_options = 1;
        env[used] = strdup(environ[i]);
        if (!env[used++]) goto fail;
    }
    env[used] = malloc(11 + length + 1);
    if (!env[used]) goto fail;
    memcpy(env[used], "NETHACKDIR=", 11);
    memcpy(env[used++] + 11, directory, length + 1);
    if (!have_options) {
        env[used] = strdup("NETHACKOPTIONS=!tutorial,time");
        if (!env[used]) goto fail;
    }
    return env;
fail:
    free_environment(env);
    return NULL;
}

/* Keep pipe endpoints above stdio, including when an embedding host has
 * closed fd 0/1/2. dup2 + closing the originals must not close the new stdio. */
static int
session_pipe(int fds[2])
{
    int i, moved;
#ifdef __linux__
    if (pipe2(fds, O_CLOEXEC) < 0) return -1;
#else
    if (pipe(fds) < 0) return -1;
    if (fcntl(fds[0], F_SETFD, FD_CLOEXEC) < 0 || fcntl(fds[1], F_SETFD, FD_CLOEXEC) < 0) return -1;
#endif
    for (i = 0; i < 2; ++i) if (fds[i] < 3) {
        moved = fcntl(fds[i], F_DUPFD_CLOEXEC, 3);
        if (moved < 0) return -1;
        close(fds[i]); fds[i] = moved;
    }
    return 0;
}

nh_session_t *
nh_session_start(const char *binpath, const char *hackdir,
                 char *const extra_argv[])
{
    return nh_session_start_with_lease(binpath, hackdir, extra_argv, -1);
}

nh_session_t *
nh_session_start_with_lease(const char *binpath, const char *hackdir,
                            char *const extra_argv[], int lease_fd)
{
    int to_child[2] = { -1, -1 }, from_child[2] = { -1, -1 };
    nh_session_t *s = NULL;
    pid_t pid;
    size_t n = 0;
    int isolated = 0;
    char *argv[258], **env = NULL;
    /* The child chdirs before exec, so resolve relative paths now. */
    char bin_abs[PATH_MAX], hack_abs[PATH_MAX];

    if (!binpath || !hackdir) {
        errno = EINVAL;
        return NULL;
    }
    if (!realpath(binpath, bin_abs) || !realpath(hackdir, hack_abs)) {
        if (errno == 0)
            errno = ENOENT;
        return NULL;
    }
    argv[0] = bin_abs;
    if (extra_argv) while (extra_argv[n]) {
        if (n == 256) { errno = E2BIG; return NULL; }
        if (!strncmp(extra_argv[n], "--runtime-v1=", 13)) isolated = 1;
        argv[n + 1] = extra_argv[n]; ++n;
    }
    argv[n + 1] = NULL;
    env = engine_environment(hack_abs, isolated);
    if (!env || session_pipe(to_child) < 0 || session_pipe(from_child) < 0)
        goto fail;
    s = calloc(1, sizeof *s);
    if (!s)
        goto fail;
    s->wfd = to_child[1];
    s->rfd = from_child[0];

    pid = fork();
    if (pid < 0)
        goto fail;
    if (pid == 0) {
        /* Deliberately retain only this world's lease through exec. The
         * duplicate is made before rewiring stdio in case the caller had a
         * closed standard descriptor. All other leases stay close-on-exec. */
        if (lease_fd >= 0 && fcntl(lease_fd, F_DUPFD, 3) < 0)
            _exit(127);
        /* No allocation, getenv/setenv, stdio, or host callbacks after fork. */
        if (dup2(to_child[0], STDIN_FILENO) < 0 ||
            dup2(from_child[1], STDOUT_FILENO) < 0) _exit(127);
        close(to_child[0]); close(to_child[1]);
        close(from_child[0]); close(from_child[1]);
        if (chdir(hack_abs) < 0) _exit(127);
        execve(bin_abs, argv, env);
        _exit(127);
    }
    s->pid = pid;
    free_environment(env);
    close(to_child[0]);
    close(from_child[1]);
    return s;

fail: {
        int e = errno;
        if (to_child[0] >= 0)
            close(to_child[0]);
        if (to_child[1] >= 0)
            close(to_child[1]);
        if (from_child[0] >= 0)
            close(from_child[0]);
        if (from_child[1] >= 0)
            close(from_child[1]);
        free_environment(env);
        free(s);
        errno = e;
        return NULL;
    }
}

/* Suppress only SIGPIPE generated by this thread's write. Never change the
 * application's process-wide handler, mask in another thread, or a signal
 * already pending before this call. A dead engine must not kill its C host. */
static ssize_t
write_no_sigpipe(int fd, const void *bytes, size_t length)
{
    sigset_t blocked, previous, pending;
    int was_pending, error, saved, signal_number;
    ssize_t written;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGPIPE);
    error = pthread_sigmask(SIG_BLOCK, &blocked, &previous);
    if (error) { errno = error; return -1; }
    if (sigpending(&pending) < 0) {
        saved = errno; pthread_sigmask(SIG_SETMASK, &previous, NULL); errno = saved; return -1;
    }
    was_pending = sigismember(&pending, SIGPIPE);
    written = write(fd, bytes, length);
    saved = errno;
    if (written < 0 && saved == EPIPE && !was_pending &&
        sigpending(&pending) == 0 && sigismember(&pending, SIGPIPE))
        (void)sigwait(&blocked, &signal_number);
    error = pthread_sigmask(SIG_SETMASK, &previous, NULL);
    if (error && written >= 0) { errno = error; return -1; }
    errno = saved;
    return written;
}

int
nh_session_write(nh_session_t *s, const char *line)
{
    size_t len, off = 0;
    ssize_t w;
    if (!s || !line) {
        errno = EINVAL;
        return -1;
    }
    len = strlen(line);
    while (off < len) {
        w = write_no_sigpipe(s->wfd, line + off, len - off);
        if (w < 0) {
            if (errno == EINTR)
                continue;
            return -1;
        }
        off += (size_t) w;
    }
    for (;;) {
        w = write_no_sigpipe(s->wfd, "\n", 1);
        if (w < 0) {
            if (errno == EINTR)
                continue;
            return -1;
        }
        break;
    }
    return 0;
}

/* Slurp available bytes into the buffer. Returns 1 if a full line is
 * present, 0 if more data is needed, -1 on EOF/error. */
static int
fill_buf(nh_session_t *s, int timeout_ms)
{
    struct pollfd pfd;
    ssize_t r;
    pfd.fd = s->rfd;
    pfd.events = POLLIN;
    for (;;) {
        int pr = poll(&pfd, 1, timeout_ms);
        if (pr < 0) {
            if (errno == EINTR)
                continue;
            return -1;
        }
        if (pr == 0) {
            errno = EAGAIN;
            return -1;
        }
        if (pfd.revents & (POLLERR | POLLNVAL))
            return -1;
        if (s->len + 4096 + 1 > s->cap) {
            size_t ncap = s->cap ? s->cap * 2 : 8192;
            char *nb = realloc(s->buf, ncap);
            if (!nb)
                return -1;
            s->buf = nb;
            s->cap = ncap;
        }
        r = read(s->rfd, s->buf + s->len, 4096);
        if (r < 0) {
            if (errno == EINTR)
                continue;
            return -1;
        }
        if (r == 0) {
            s->ended = 1;
            errno = 0;
            return -1; /* EOF */
        }
        s->len += (size_t) r;
        return 1;
    }
}

char *
nh_session_read_line(nh_session_t *s, int timeout_ms)
{
    char *nl, *out;
    size_t n;
    if (!s) {
        errno = EINVAL;
        return NULL;
    }
    for (;;) {
        if (s->len) {
            nl = memchr(s->buf, '\n', s->len);
            if (nl) {
                n = (size_t) (nl - s->buf);
                out = malloc(n + 1);
                if (!out)
                    return NULL;
                memcpy(out, s->buf, n);
                out[n] = '\0';
                /* strip a trailing CR */
                if (n > 0 && out[n - 1] == '\r')
                    out[n - 1] = '\0';
                memmove(s->buf, nl + 1, s->len - n - 1);
                s->len -= n + 1;
                return out;
            }
        }
        if (s->ended) {
            errno = 0;
            return NULL;
        }
        if (fill_buf(s, timeout_ms) < 0)
            return NULL;
    }
}

int
nh_session_ended(nh_session_t *s)
{
    struct pollfd pfd;
    int pr;
    if (!s)
        return 1;
    if (s->ended)
        return 1;
    if (s->len)
        return 0; /* buffered unread data: engine was alive */
    pfd.fd = s->rfd;
    pfd.events = POLLIN;
    pr = poll(&pfd, 1, 0);
    if (pr < 0)
        return 1;
    if (pr == 0)
        return 0;
    if (pfd.revents & (POLLHUP | POLLERR | POLLNVAL)) {
        s->ended = 1;
        return 1;
    }
    return 0;
}

int
nh_session_abort(nh_session_t *s)
{
    if (!s) { errno = EINVAL; return -1; }
    if (!s->reaped) {
        pid_t result;
        int status = -1;
        do { result = waitpid(s->pid, &status, WNOHANG); } while (result < 0 && errno == EINTR);
        if (!result) {
            kill(s->pid, SIGKILL);
            do { result = waitpid(s->pid, &status, 0); } while (result < 0 && errno == EINTR);
        }
        if (result == s->pid || (result < 0 && errno == ECHILD)) { s->reaped = 1; s->status = status; }
    }
    return nh_session_close(s);
}

static long long
close_clock_ms(void)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (long long) now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

int
nh_session_close(nh_session_t *s)
{
    int status = -1;
    long long deadline = close_clock_ms() + 2000;
    if (!s) {
        errno = EINVAL;
        return -1;
    }
    /* EOF the engine's stdin so a blocked read terminates, then drain
     * its last output before closing our read end (avoids SIGPIPE-ing
     * a mid-write engine). */
    close(s->wfd);
    s->wfd = -1;
    if (s->rfd >= 0) {
        char drain[4096];
        for (;;) {
            struct pollfd pfd;
            long long remaining = deadline - close_clock_ms();
            if (remaining <= 0) break;
            pfd.fd = s->rfd;
            pfd.events = POLLIN;
            if (poll(&pfd, 1, (int) remaining) <= 0)
                break;
            if (read(s->rfd, drain, sizeof drain) <= 0)
                break;
        }
        close(s->rfd);
        s->rfd = -1;
    }
    if (!s->reaped) {
        pid_t w;
        for (;;) {
            w = waitpid(s->pid, &status, WNOHANG);
            if (w < 0 && errno == EINTR) continue;
            if (w != 0) break;
            if (close_clock_ms() >= deadline) {
                /* An exited/stopped/broken engine must not hold the bridge
                 * queue and its run lease indefinitely. This is our child. */
                kill(s->pid, SIGKILL);
                do { w = waitpid(s->pid, &status, 0); }
                while (w < 0 && errno == EINTR);
                break;
            }
            poll(NULL, 0, 10);
        }
        if (w == s->pid) {
            s->status = status;
            s->reaped = 1;
        }
    } else {
        status = s->status;
    }
    free(s->buf);
    free(s);
    return status;
}
