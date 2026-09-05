/* neonethack headless CLI flags — see cli.h.
 * Modified for neonethack 2026-09-05: versioned frozen-calendar runtime boot. */
#include "cli.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Static defaults: no presets, no log/replay, protocol (non-pretty,
 * non-play) mode. This is what the wasm build runs with (it never calls
 * hl_cli_parse); the native unix main re-parses argv over these. */
hl_cli_t hl_cli = {
    0, 0L, { 0 }, 0, -1, -1, -1, -1, NULL, NULL, 0, 0
};

static long long runtime_epoch = -1;
long long headless_runtime_epoch(void) { return runtime_epoch; }

/* One of ours? Compares the --name part only (caller handles =/space). */
static int
is_opt(const char *arg, const char *opt, size_t *namelen_out)
{
    size_t n = strlen(opt);
    const char *eq;
    if (strncmp(arg, "--", 2) != 0)
        return 0;
    eq = strchr(arg + 2, '=');
    *namelen_out = eq ? (size_t) (eq - (arg + 2)) : strlen(arg + 2);
    return *namelen_out == n && strncmp(arg + 2, opt, n) == 0;
}

void
hl_cli_parse(int *argcp, char **argv)
{
    static const char *valued[] = { "seed", "name", "role", "race",
        "gender", "align", "log", "replay", "runtime-v1", NULL
    };
    static const char *flags[] = { "pretty", "play", NULL };
    int argc = *argcp, i, w = 1;
    hl_cli.role = hl_cli.race = hl_cli.gender = hl_cli.align = -1;
    for (i = 1; i < argc; i++) {
        const char *v = NULL;
        char *end = NULL;
        size_t nl = 0;
        int k, known = 0;
        for (k = 0; valued[k]; k++) {
            if (is_opt(argv[i], valued[k], &nl)) {
                const char *eq = strchr(argv[i] + 2, '=');
                if (eq) {
                    v = eq + 1;
                } else if (i + 1 < argc && argv[i + 1][0] != '-') {
                    v = argv[++i]; /* space form: consume the value */
                }
                known = 1;
                break;
            }
        }
        if (!known) {
            for (k = 0; flags[k]; k++) {
                if (is_opt(argv[i], flags[k], &nl)) {
                    known = 2;
                    break;
                }
            }
        }
        if (!known) {
            argv[w++] = argv[i]; /* not ours: keep */
            continue;
        }
        if (known == 2) {
            if (strcmp(flags[k], "pretty") == 0)
                hl_cli.pretty = 1;
            else
                hl_cli.play = 1;
            continue;
        }
        if (strcmp(valued[k], "runtime-v1") == 0) {
            long long epoch;
            errno = 0;
            epoch = v ? strtoll(v, &end, 10) : -1;
            if (!v || !*v || !end || *end || errno || epoch < 0 || epoch > 4102444799LL) {
                fputs("invalid runtime-v1 calendar epoch\n", stderr);
                exit(64);
            }
            runtime_epoch = epoch;
        } else if (strcmp(valued[k], "seed") == 0 && v) {
            hl_cli.seed = strtol(v, &end, 10);
            hl_cli.seed_set = (end && *end == '\0');
        } else if (strcmp(valued[k], "name") == 0 && v && *v) {
            strncpy(hl_cli.name, v, sizeof hl_cli.name - 1);
            hl_cli.name[sizeof hl_cli.name - 1] = '\0';
            hl_cli.has_name = 1;
        } else if (strcmp(valued[k], "role") == 0 && v) {
            hl_cli.role = (int) strtol(v, NULL, 10);
        } else if (strcmp(valued[k], "race") == 0 && v) {
            hl_cli.race = (int) strtol(v, NULL, 10);
        } else if (strcmp(valued[k], "gender") == 0 && v) {
            hl_cli.gender = (int) strtol(v, NULL, 10);
        } else if (strcmp(valued[k], "align") == 0 && v) {
            hl_cli.align = (int) strtol(v, NULL, 10);
        } else if (strcmp(valued[k], "log") == 0 && v) {
            hl_cli.logfile = v;
        } else if (strcmp(valued[k], "replay") == 0 && v) {
            hl_cli.replayfile = v;
        }
        /* ours: consumed (dropped from argv) */
    }
    *argcp = w;
}

int
hl_cli_seed(long *out)
{
    if (!hl_cli.seed_set)
        return 0;
    *out = hl_cli.seed;
    return 1;
}

int
hl_cli_name(char *out, unsigned outcap)
{
    if (!hl_cli.has_name || !outcap)
        return 0;
    strncpy(out, hl_cli.name, outcap - 1);
    out[outcap - 1] = '\0';
    return 1;
}

int
hl_cli_slot(const char *key)
{
    if (strcmp(key, "role") == 0)
        return hl_cli.role;
    if (strcmp(key, "race") == 0)
        return hl_cli.race;
    if (strcmp(key, "gender") == 0)
        return hl_cli.gender;
    if (strcmp(key, "align") == 0)
        return hl_cli.align;
    return -1;
}

/* ---- replay + log ---- */

static char **replay_lines = NULL;
static size_t replay_n = 0, replay_pos = 0;
static FILE *logfp = NULL;

/* fgets-based full-line reader (no getline: keeps -pedantic builds
 * warning-free without feature-test macros). */
static char *
read_full_line(FILE *f)
{
    size_t cap = 512, len = 0;
    char *buf = malloc(cap), chunk[512];
    if (!buf)
        return NULL;
    for (;;) {
        size_t n;
        if (!fgets(chunk, sizeof chunk, f)) {
            if (!len) {
                free(buf);
                return NULL;
            }
            break;
        }
        n = strlen(chunk);
        if (len + n + 1 > cap) {
            size_t ncap = (len + n + 1) * 2;
            char *nb = realloc(buf, ncap);
            if (!nb) {
                free(buf);
                return NULL;
            }
            buf = nb;
            cap = ncap;
        }
        memcpy(buf + len, chunk, n);
        len += n;
        if (n > 0 && chunk[n - 1] == '\n')
            break;
    }
    while (len > 0 && (buf[len - 1] == '\n' || buf[len - 1] == '\r'))
        len--;
    buf[len] = '\0';
    if (!len) {
        /* blank line: return empty (caller skips) rather than NULL */
        return buf;
    }
    return buf;
}

static void
replay_load(void)
{
    static int loaded = 0;
    FILE *f;
    char *line;
    if (loaded || !hl_cli.replayfile)
        return;
    loaded = 1;
    f = fopen(hl_cli.replayfile, "r");
    if (!f)
        return;
    while ((line = read_full_line(f)) != NULL) {
        if (!*line) {
            free(line);
            continue;
        }
        replay_lines = realloc(replay_lines,
                               (replay_n + 1) * sizeof *replay_lines);
        if (!replay_lines) {
            free(line);
            replay_n = 0;
            break;
        }
        replay_lines[replay_n++] = line;
    }
    fclose(f);
}

char *
hl_cli_replay_next(void)
{
    replay_load();
    if (replay_pos >= replay_n)
        return NULL;
    return strdup(replay_lines[replay_pos++]);
}

void
hl_cli_log_line(const char *line)
{
    if (!hl_cli.logfile || !line)
        return;
    if (!logfp) {
        logfp = fopen(hl_cli.logfile, "a");
        if (!logfp)
            return;
    }
    fputs(line, logfp);
    fputc('\n', logfp);
    fflush(logfp);
}

/* ---- pretty printer (strings-aware, no other JSON knowledge) ---- */

void
hl_cli_pretty(const char *line, FILE *out)
{
    int indent = 0, i, in_str = 0, esc = 0;
    if (!line || !out)
        return;
    for (i = 0; line[i]; i++) {
        char c = line[i];
        if (in_str) {
            fputc(c, out);
            if (esc)
                esc = 0;
            else if (c == '\\')
                esc = 1;
            else if (c == '"')
                in_str = 0;
            continue;
        }
        if (c == '"') {
            in_str = 1;
            fputc(c, out);
        } else if (c == '{' || c == '[') {
            int j;
            fputc(c, out);
            indent++;
            fputc('\n', out);
            for (j = 0; j < indent; j++)
                fputs("  ", out);
        } else if (c == '}' || c == ']') {
            int j;
            indent--;
            if (indent < 0)
                indent = 0;
            fputc('\n', out);
            for (j = 0; j < indent; j++)
                fputs("  ", out);
            fputc(c, out);
        } else if (c == ',') {
            int j;
            fputc(c, out);
            fputc('\n', out);
            for (j = 0; j < indent; j++)
                fputs("  ", out);
        } else if (c == ':') {
            fputs(": ", out);
        } else {
            fputc(c, out);
        }
    }
    fputc('\n', out);
    fflush(out);
}
