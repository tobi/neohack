/* libneonethack conformance probe: handshake, seeded game, prompt-aware
 * answers, N moves, then resume-from-log in a fresh session.
 *
 * Build: cc -Wall -Wextra -I. -o test_lib test_lib.c session.c
 * Run from the project root: ./lib/test_lib
 * (paths below assume that cwd).
 */
#define _XOPEN_SOURCE 700
#define _DEFAULT_SOURCE /* mkdtemp (nftw wants _XOPEN_SOURCE) */
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "neonethack.h"

#define BIN "./upstream/playground/nethack"
#define HACKDIR_SRC "./upstream/playground"
#define TIMEOUT_MS 15000

static int failures = 0;
#define CHECK(cond, ...) do { \
        if (!(cond)) { \
            printf("FAIL: "); printf(__VA_ARGS__); printf("\n"); \
            failures++; \
        } \
    } while (0)

/* Append every client->engine line for the resume phase. */
static char **log_lines = NULL;
static size_t log_n = 0, log_cap = 0;

static void
log_push(const char *line)
{
    if (log_n == log_cap) {
        log_cap = log_cap ? log_cap * 2 : 64;
        log_lines = realloc(log_lines, log_cap * sizeof *log_lines);
    }
    log_lines[log_n++] = strdup(line);
}

static int
send_logged(nh_session_t *s, const char *line)
{
    log_push(line);
    return nh_session_write(s, line);
}

/* Hermetic playground: copy the live tree to a temp dir so lock/save
 * files from earlier runs (or other tests) can never leak into this
 * session via restore. Removed again after each phase. */
static char g_src[PATH_MAX];
static size_t g_srclen = 0;
static char g_dst[PATH_MAX];

static int
copy_cb(const char *fpath, const struct stat *sb, int typeflag,
        struct FTW *ftwbuf)
{
    char dst[PATH_MAX];
    (void) ftwbuf;
    if (snprintf(dst, sizeof dst, "%s%s", g_dst, fpath + g_srclen)
        >= (int) sizeof dst)
        return -1;
    if (typeflag == FTW_D) {
        if (mkdir(dst, 0700) < 0 && errno != EEXIST)
            return -1;
    } else if (typeflag == FTW_F) {
        int in, out;
        ssize_t n;
        char buf[65536];
        in = open(fpath, O_RDONLY);
        if (in < 0)
            return -1;
        out = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (out < 0) {
            close(in);
            return -1;
        }
        /* keep the source mode (the engine binary must stay +x) */
        fchmod(out, sb->st_mode & 07777);
        while ((n = read(in, buf, sizeof buf)) > 0) {
            ssize_t w = 0;
            while (w < n) {
                ssize_t m = write(out, buf + w, (size_t) (n - w));
                if (m <= 0) {
                    close(in);
                    close(out);
                    return -1;
                }
                w += m;
            }
        }
        close(in);
        if (close(out) < 0)
            return -1;
        if (n < 0)
            return -1;
    }
    return 0;
}

static int
rm_cb(const char *fpath, const struct stat *sb, int typeflag,
      struct FTW *ftwbuf)
{
    (void) sb;
    (void) ftwbuf;
    (void) typeflag;
    return remove(fpath);
}

/* Fresh playground copy in out (PATH_MAX). Returns 0 on success. */
static int
fresh_playground(char *out)
{
    char tmpl[] = "/tmp/nhlib-XXXXXX";
    if (!mkdtemp(tmpl))
        return -1;
    if (!realpath(HACKDIR_SRC, g_src))
        return -1;
    g_srclen = strlen(g_src);
    strncpy(g_dst, tmpl, sizeof g_dst - 1);
    g_dst[sizeof g_dst - 1] = '\0';
    if (nftw(g_src, copy_cb, 16, FTW_PHYS) != 0)
        return -1;
    strcpy(out, tmpl);
    return 0;
}

static void
wipe_playground(const char *dir)
{
    nftw(dir, rm_cb, 16, FTW_DEPTH | FTW_PHYS);
}

/* Crude protocol scan: find "method":"input" + id + kind. */
static int
parse_input(const char *line, long long *id, char *kind, size_t kindcap)
{
    const char *m = strstr(line, "\"method\":\"input\"");
    const char *p, *q;
    if (!m)
        return 0;
    p = strstr(line, "\"id\":");
    if (!p || sscanf(p + 5, "%lld", id) != 1)
        return 0;
    p = strstr(line, "\"kind\":\"");
    if (!p)
        return 0;
    p += 8;
    q = strchr(p, '"');
    if (!q || (size_t) (q - p) >= kindcap)
        return 0;
    memcpy(kind, p, (size_t) (q - p));
    kind[q - p] = '\0';
    return 1;
}

/* Answer one input request. Returns 1 if a move was made. */
static int
answer_input(nh_session_t *s, long long id, const char *kind, int *moves_left)
{
    char buf[1024];
    const char *result = NULL;
    char tmp[256];
    if (strcmp(kind, "menu") == 0) {
        result = "{\"picks\":[1],\"counts\":[]}";
    } else if (strcmp(kind, "yn") == 0) {
        result = "{\"answer\":\"n\"}";
    } else if (strcmp(kind, "getlin") == 0) {
        result = "{\"line\":\"\"}";
    } else if (strcmp(kind, "msgmenu") == 0) {
        result = "{\"answer\":\"\\r\"}";
    } else if (strcmp(kind, "extcmd") == 0) {
        result = "{\"index\":-1}";
    } else if (strcmp(kind, "key") == 0 || strcmp(kind, "poskey") == 0) {
        if (*moves_left <= 0)
            return 0; /* stop: leave the prompt pending */
        (*moves_left)--;
        if (strcmp(kind, "key") == 0)
            snprintf(tmp, sizeof tmp, "{\"key\":106}");
        else
            snprintf(tmp, sizeof tmp, "{\"x\":0,\"y\":0,\"mod\":0,\"key\":106}");
        result = tmp;
    } else if (strcmp(kind, "ack") == 0) {
        result = "{}";
    } else {
        snprintf(tmp, sizeof tmp, "{}");
        result = tmp;
    }
    snprintf(buf, sizeof buf, "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":%s}",
             id, result);
    if (send_logged(s, buf) < 0)
        return -1;
    return (strcmp(kind, "key") == 0 || strcmp(kind, "poskey") == 0);
}

/* Drive a session until moves_wanted moves are made (or a session_ended).
 * Returns moves made, or -1 on protocol/session failure. */
static int
drive(nh_session_t *s, int moves_wanted)
{
    int moves = 0, inputs = 0, moves_left;
    for (;;) {
        char *line = nh_session_read_line(s, TIMEOUT_MS);
        long long id;
        char kind[32];
        int r;
        if (!line) {
            printf("  drive: read failed (timeout/EOF)\n");
            return -1;
        }
        if (strstr(line, "\"method\":\"session_ended\"")) {
            printf("  drive: %s\n", line);
            free(line);
            return -1;
        }
        if (parse_input(line, &id, kind, sizeof kind)) {
            if (++inputs > 200) {
                printf("  drive: too many inputs, bailing\n");
                free(line);
                return -1;
            }
            moves_left = moves_wanted - moves;
            r = answer_input(s, id, kind, &moves_left);
            free(line);
            if (r < 0)
                return -1;
            if (r > 0 && ++moves >= moves_wanted)
                return moves;
            continue;
        }
        free(line);
    }
}

int
main(void)
{
    nh_session_t *s;
    char *line;
    int moves, st;
    char pg1[PATH_MAX], pg2[PATH_MAX];
    long long in_id;
    char kind[32];

    CHECK(fresh_playground(pg1) == 0, "phase 1 playground copy failed");
    if (failures)
        return 1;
    printf("== phase 1: new game + 5 moves ==\n");
    s = nh_session_start(BIN, pg1, NULL);
    CHECK(s != NULL, "session_start failed");
    if (!s) {
        wipe_playground(pg1);
        return 1;
    }
    CHECK(send_logged(s, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\","
                       "\"params\":{\"protocolVersion\":\"0.1\"}}") == 0,
          "initialize write failed");
    CHECK(send_logged(s, "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"new_game\","
                       "\"params\":{\"seed\":4242,\"name\":\"libtest\"}}") == 0,
          "new_game write failed");
    moves = drive(s, 5);
    printf("  moves made: %d, log lines: %zu\n", moves, log_n);
    CHECK(moves == 5, "expected 5 moves, got %d", moves);
    /* drive() leaves the next prompt pending: drain the move-5 tail
     * until that input request arrives (TIMEOUT: the live engine must
     * ask), then the pipe must be quiet. A bare timeout-0 read here
     * would race the in-flight prompt. */
    if (moves == 5) {
        for (;;) {
            line = nh_session_read_line(s, TIMEOUT_MS);
            CHECK(line != NULL, "missing pending prompt after 5 moves");
            if (!line)
                break;
            if (parse_input(line, &in_id, kind, sizeof kind)) {
                free(line);
                break;
            }
            free(line);
        }
        line = nh_session_read_line(s, 0);
        CHECK(line == NULL, "expected no backlog");
        free(line);
    }
    st = nh_session_close(s);
    printf("  close status: %#x\n", st);
    wipe_playground(pg1);

    printf("== phase 2: resume from %zu-line log ==\n", log_n);
    CHECK(fresh_playground(pg2) == 0, "phase 2 playground copy failed");
    if (failures)
        return 1;
    s = nh_session_start(BIN, pg2, NULL);
    CHECK(s != NULL, "resume session_start failed");
    if (!s) {
        wipe_playground(pg2);
        return 1;
    }
    {
        size_t i;
        for (i = 0; i < log_n; i++)
            CHECK(nh_session_write(s, log_lines[i]) == 0,
                  "replay write %zu failed", i);
    }
    /* one more live move on the resumed session */
    moves = drive(s, 1);
    printf("  resumed moves made: %d\n", moves);
    CHECK(moves == 1, "expected 1 resumed move, got %d", moves);
    st = nh_session_close(s);
    printf("  close status: %#x\n", st);
    wipe_playground(pg2);

    printf(failures ? "LIB TEST: %d FAILURES\n" : "LIB TEST: ALL OK\n",
           failures);
    return failures != 0;
}
