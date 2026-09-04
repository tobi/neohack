/* neonethack session library — see neonethack.h. POSIX C99, no deps. */
#define _POSIX_C_SOURCE 200809L
#define _XOPEN_SOURCE 700

#include "neonethack.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
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
    if (pipe(to_child) < 0 || pipe(from_child) < 0)
        goto fail;
    /* An engine must not inherit another session's pipe ends. Otherwise
     * closing the bridge cannot deliver EOF and abandoned engines linger. */
    if (fcntl(to_child[0], F_SETFD, FD_CLOEXEC) < 0 ||
        fcntl(to_child[1], F_SETFD, FD_CLOEXEC) < 0 ||
        fcntl(from_child[0], F_SETFD, FD_CLOEXEC) < 0 ||
        fcntl(from_child[1], F_SETFD, FD_CLOEXEC) < 0)
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
        /* child: wire pipes to stdio, move to the playground, exec */
        size_t n = 0;
        if (extra_argv)
            while (extra_argv[n])
                n++;
        {
            /* argv: binpath + extras. Keep it simple: fixed cap. */
            char **argv;
            size_t i;
            if (n > 256)
                _exit(127);
            argv = malloc((n + 2) * sizeof *argv);
            if (!argv)
                _exit(127);
            argv[0] = bin_abs;
            for (i = 0; i < n; i++)
                argv[i + 1] = extra_argv[i];
            argv[n + 1] = NULL;
            if (dup2(to_child[0], STDIN_FILENO) < 0)
                _exit(127);
            if (dup2(from_child[1], STDOUT_FILENO) < 0)
                _exit(127);
            /* engine diagnostics stay on stderr (inherited) */
            close(to_child[0]);
            close(to_child[1]);
            close(from_child[0]);
            close(from_child[1]);
            if (chdir(hack_abs) < 0)
                _exit(127);
            /* chdir alone is not enough: the engine prefers NETHACKDIR
             * over cwd (compiled HACKDIR wins otherwise), so point it
             * at the session playground explicitly. */
            if (setenv("NETHACKDIR", hack_abs, 1) < 0)
                _exit(127);
            execv(bin_abs, argv);
            _exit(127);
        }
    }
    s->pid = pid;
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
        free(s);
        errno = e;
        return NULL;
    }
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
        w = write(s->wfd, line + off, len - off);
        if (w < 0) {
            if (errno == EINTR)
                continue;
            return -1;
        }
        off += (size_t) w;
    }
    for (;;) {
        w = write(s->wfd, "\n", 1);
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
