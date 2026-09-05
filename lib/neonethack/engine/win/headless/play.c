/* neonethack --play: interactive ASCII terminal mode, in-process.
 *
 * The engine is already synchronous request/response, so no threads or
 * sockets are needed: rpc_write() routes engine lines here for display,
 * and json_read_line() blocks on the human for answers. Full-screen
 * layout (80x21 map, status, message tail, prompt line) with ANSI colors.
 */
#include "play.h"

#include <stdio.h>
#include <ctype.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "json_min.h"

#ifdef __unix__
#include <termios.h>
#endif

#define MAP_W 80
#define MAP_H 21
#define MSG_N 64
#define MSG_SHOW 6

static struct {
    char ch[MAP_H][MAP_W];
    unsigned char co[MAP_H][MAP_W];
    char *msgs[MSG_N];
    int mnext, mcount;
    /* status fields (owned strings) */
    char *hp, *hpmax, *ene, *enemax, *ac, *gold, *xp, *depth, *time, *name;
    /* menu items per window */
    struct {
        int used;
        int nitems;
        struct {
            int index, accel;
            char text[160];
        } items[512];
        char prompt[256];
    } wins[64];
    /* pending input request */
    long long req_id;
    char req_kind[16];
    char *req_params; /* owned raw params text */
    int req_how;      /* menu behavior */
    int ended;
} P;

static int raw_on = 0;
#ifdef __unix__
static struct termios saved_term;
#endif

static const char *
ansi_for(int c)
{
    switch (c & 15) {
    case 0: return "\x1b[90m";
    case 1: return "\x1b[31m";
    case 2: return "\x1b[32m";
    case 3: return "\x1b[33m";
    case 4: return "\x1b[34m";
    case 5: return "\x1b[35m";
    case 6: return "\x1b[36m";
    case 7: return "\x1b[37m";
    case 8: return "\x1b[90m";
    case 9: return "\x1b[91m";
    case 10: return "\x1b[92m";
    case 11: return "\x1b[93m";
    case 12: return "\x1b[94m";
    case 13: return "\x1b[95m";
    case 14: return "\x1b[96m";
    default: return "\x1b[97m";
    }
}

static void
push_msg(const char *text)
{
    char *s = strdup(text ? text : "");
    if (!s)
        return;
    free(P.msgs[P.mnext]);
    P.msgs[P.mnext] = s;
    P.mnext = (P.mnext + 1) % MSG_N;
    if (P.mcount < MSG_N)
        P.mcount++;
}

/* Numeric status field ids (must match enum statusfields in botl.h). */
enum {
    PSF_TITLE = 0, PSF_GOLD = 10, PSF_ENE = 11, PSF_ENEMAX = 12,
    PSF_XP = 13, PSF_AC = 14, PSF_TIME = 16, PSF_HP = 18,
    PSF_HPMAX = 19, PSF_LEVELDESC = 20
};

static void
set_status_slot(char **slot, const char *v)
{
    char *nv;
    if (!slot || !v)
        return;
    nv = strdup(v);
    if (nv) {
        free(*slot);
        *slot = nv;
    }
}

/* Numeric status_update form: {"field":N,"value":"..."}. */
static void
set_status_by_field(int fld, const char *v)
{
    char **slot = NULL;
    switch (fld) {
    case PSF_TITLE:
        slot = &P.name;
        break;
    case PSF_GOLD: slot = &P.gold; break;
    case PSF_ENE: slot = &P.ene; break;
    case PSF_ENEMAX: slot = &P.enemax; break;
    case PSF_XP: slot = &P.xp; break;
    case PSF_AC: slot = &P.ac; break;
    case PSF_TIME: slot = &P.time; break;
    case PSF_HP: slot = &P.hp; break;
    case PSF_HPMAX: slot = &P.hpmax; break;
    case PSF_LEVELDESC: slot = &P.depth; break;
    default: break;
    }
    if (!slot || !v)
        return;
    if (fld == PSF_TITLE) {
        /* "Name the Role ..." (padded): display just the name. */
        const char *t = strstr(v, " the ");
        size_t n = t ? (size_t) (t - v) : strlen(v);
        char buf[64];
        if (n >= sizeof buf)
            n = sizeof buf - 1;
        memcpy(buf, v, n);
        buf[n] = '\0';
        while (n > 0 && buf[n - 1] == ' ')
            buf[--n] = '\0';
        set_status_slot(slot, buf);
        return;
    }
    set_status_slot(slot, v);
}

static void
set_status_field(const char *key, const char *params)
{
    const char *p = j_find_key(params, key);
    char **slot = NULL;
    char *v = NULL;
    int ok = 0;
    if (!p)
        return;
    if (strcmp(key, "hp") == 0)
        slot = &P.hp;
    else if (strcmp(key, "hpmax") == 0)
        slot = &P.hpmax;
    else if (strcmp(key, "ene") == 0)
        slot = &P.ene;
    else if (strcmp(key, "enemax") == 0)
        slot = &P.enemax;
    else if (strcmp(key, "ac") == 0)
        slot = &P.ac;
    else if (strcmp(key, "gold") == 0)
        slot = &P.gold;
    else if (strcmp(key, "xp") == 0)
        slot = &P.xp;
    else if (strcmp(key, "leveldesc") == 0)
        slot = &P.depth;
    else if (strcmp(key, "time") == 0)
        slot = &P.time;
    else if (strcmp(key, "name") == 0)
        slot = &P.name;
    if (!slot)
        return;
    if (*p == '"')
        v = j_parse_str(p, &ok);
    else {
        long long n = j_parse_int(p, &ok);
        if (ok) {
            char buf[64];
            snprintf(buf, sizeof buf, "%lld", n);
            v = strdup(buf);
        }
    }
    if (ok && v) {
        free(*slot);
        *slot = v;
    } else {
        free(v);
    }
}

/* Apply one flat {...} cell object at p (already inside the object). */
static void
apply_cell_obj(const char *p, const char *end)
{
    const char *q;
    int ok = 0, x = -1, y = -1, ch = ' ', co = 7;
    (void) end;
    q = j_find_key(p, "x");
    /* j_find_key matches key names; scope by staying before '}' is the
     * caller's job (chunks are single objects). */
    if (q)
        x = (int) j_parse_int(q, &ok);
    if (!ok)
        return;
    q = j_find_key(p, "y");
    if (q)
        y = (int) j_parse_int(q, &ok);
    if (!ok)
        return;
    q = j_find_key(p, "ttychar");
    if (q)
        ch = (int) j_parse_int(q, &ok);
    q = j_find_key(p, "framecolor");
    if (q)
        co = (int) j_parse_int(q, &ok);
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H)
        return;
    P.ch[y][x] = (ch > 0 && ch < 127) ? (char) ch : (ch ? '?' : ' ');
    P.co[y][x] = (unsigned char) (co & 15);
}

/* Walk the cells array calling apply_cell_obj per {...} chunk. */
static void
apply_cells(const char *line)
{
    const char *arr = strstr(line, "\"cells\"");
    const char *p;
    if (!arr)
        return;
    arr = strchr(arr, '[');
    if (!arr)
        return;
    p = arr + 1;
    while (*p && *p != ']') {
        const char *o, *q;
        int depth;
        if (*p != '{') {
            p++;
            continue;
        }
        o = p;
        depth = 0;
        for (q = p; *q; q++) {
            if (*q == '{')
                depth++;
            else if (*q == '}') {
                depth--;
                if (!depth) {
                    char *chunk = malloc((size_t) (q - o) + 2);
                    if (chunk) {
                        memcpy(chunk, o, (size_t) (q - o) + 1);
                        chunk[q - o + 1] = '\0';
                        apply_cell_obj(chunk, chunk + (q - o) + 1);
                        free(chunk);
                    }
                    p = q + 1;
                    break;
                }
            }
        }
        if (!*q)
            break;
    }
}

static void
store_menu_item(const char *params)
{
    const char *p;
    int ok = 0, win = -1, idx = -1, accel = 0;
    char *text = NULL;
    p = j_find_key(params, "window");
    if (p)
        win = (int) j_parse_int(p, &ok);
    if (!ok || win < 0 || win >= 64)
        return;
    p = j_find_key(params, "index");
    if (p)
        idx = (int) j_parse_int(p, &ok);
    p = j_find_key(params, "accel");
    if (p)
        accel = (int) j_parse_int(p, &ok);
    p = j_find_key(params, "text");
    if (p)
        text = j_parse_str(p, &ok);
    if (idx >= 0 && idx < 512) {
        P.wins[win].used = 1;
        if (idx >= P.wins[win].nitems)
            P.wins[win].nitems = idx + 1;
        P.wins[win].items[idx].index = idx;
        P.wins[win].items[idx].accel = accel;
        strncpy(P.wins[win].items[idx].text, text ? text : "",
                sizeof P.wins[win].items[idx].text - 1);
    }
    free(text);
}

/* ---------------- terminal ---------------- */

static int
use_tty(void)
{
    return isatty(0) && isatty(1);
}

void
hl_play_begin(void)
{
    int y, x;
    for (y = 0; y < MAP_H; y++)
        for (x = 0; x < MAP_W; x++) {
            P.ch[y][x] = ' ';
            P.co[y][x] = 7;
        }
    if (!use_tty())
        return;
#ifdef __unix__
    {
        struct termios raw;
        if (tcgetattr(0, &saved_term) == 0) {
            raw = saved_term;
            raw.c_iflag &= (unsigned) ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
            raw.c_oflag &= (unsigned) ~OPOST;
            raw.c_cflag |= (unsigned) CS8;
            raw.c_lflag &= (unsigned) ~(ECHO | ICANON | IEXTEN | ISIG);
            raw.c_cc[VMIN] = 1;
            raw.c_cc[VTIME] = 0;
            if (tcsetattr(0, TCSANOW, &raw) == 0)
                raw_on = 1;
        }
    }
#endif
    fputs("\x1b[?1049h\x1b[H", stdout); /* alt screen */
    fflush(stdout);
    atexit(hl_play_end);
}

void
hl_play_end(void)
{
    if (raw_on) {
#ifdef __unix__
        tcsetattr(0, TCSANOW, &saved_term);
#endif
        raw_on = 0;
    }
    if (use_tty()) {
        fputs("\x1b[?1049l", stdout); /* leave alt screen */
        fflush(stdout);
    }
}

/* One raw keypress; translates arrows, returns bytes as-is otherwise.
 * Returns -1 on EOF. */
static int
read_key(void)
{
    unsigned char c;
    ssize_t n;
    for (;;) {
        n = read(0, &c, 1);
        if (n < 0)
            continue; /* EINTR retry (loop is tiny; keep raw) */
        if (n == 0)
            return -1;
        if (c == 0x1b) {
            unsigned char seq[2];
            /* peek with a short blocking read; lone ESC cancels */
            ssize_t m = read(0, &seq[0], 1);
            if (m <= 0)
                return 27;
            if (seq[0] != '[')
                return 27;
            m = read(0, &seq[1], 1);
            if (m <= 0)
                return 27;
            switch (seq[1]) {
            case 'A': return 'k';
            case 'B': return 'j';
            case 'C': return 'l';
            case 'D': return 'h';
            default: return 27;
            }
        }
        return c;
    }
}

/* ---------------- render ---------------- */

static void
render_map(void)
{
    int y, x, cur = -1;
    for (y = 0; y < MAP_H; y++) {
        for (x = 0; x < MAP_W; x++) {
            int co = P.co[y][x];
            if (co != cur) {
                fputs(ansi_for(co), stdout);
                cur = co;
            }
            putc(P.ch[y][x] ? P.ch[y][x] : ' ', stdout);
        }
        fputs("\x1b[0m\n", stdout);
        cur = -1;
    }
}

static void
render_status(void)
{
    fputs("\x1b[1m", stdout);
    printf("%s  HP:%s/%s EN:%s/%s AC:%s Gold:%s XP:%s %s T:%s",
           P.name ? P.name : "you",
           P.hp ? P.hp : "?", P.hpmax ? P.hpmax : "?",
           P.ene ? P.ene : "?", P.enemax ? P.enemax : "?",
           P.ac ? P.ac : "?", P.gold ? P.gold : "0", P.xp ? P.xp : "?",
           P.depth ? P.depth : "", P.time ? P.time : "?");
    fputs("\x1b[0m\n", stdout);
}

static void
render_msgs(void)
{
    int i, shown = P.mcount < MSG_SHOW ? P.mcount : MSG_SHOW;
    for (i = shown - 1; i >= 0; i--) {
        int idx = (P.mnext - 1 - i + MSG_N * 2) % MSG_N;
        const char *m = P.msgs[idx] ? P.msgs[idx] : "";
        char tmp[82];
        strncpy(tmp, m, 80);
        tmp[80] = '\0';
        /* crude control-char scrub for terminal safety */
        {
            char *p;
            for (p = tmp; *p; p++)
                if ((unsigned char) *p < 32 && *p != '\t')
                    *p = '?';
        }
        printf("%s\n", tmp);
    }
}

static void
render_prompt(void)
{
    if (!P.req_kind[0]) {
        fputs("-- working --\n", stdout);
        return;
    }
    if (strcmp(P.req_kind, "key") == 0 || strcmp(P.req_kind, "poskey") == 0) {
        fputs("\x1b[93mmove (hjkl/yubn, arrows, . wait, i inventory, : command)\x1b[0m\n",
              stdout);
    } else if (strcmp(P.req_kind, "yn") == 0) {
        const char *p = j_find_key(P.req_params, "prompt");
        int ok = 0;
        char *t = p ? j_parse_str(p, &ok) : NULL;
        if (!ok) {
            free(t);
            t = NULL;
        }
        printf("\x1b[93m%s\x1b[0m\n", t ? t : "(yes/no?)");
        free(t);
    } else if (strcmp(P.req_kind, "getlin") == 0) {
        const char *p = j_find_key(P.req_params, "prompt");
        int ok = 0;
        char *t = p ? j_parse_str(p, &ok) : NULL;
        if (!ok) {
            free(t);
            t = NULL;
        }
        printf("\x1b[93m%s\x1b[0m\n", t ? t : ">");
        free(t);
    } else if (strcmp(P.req_kind, "menu") == 0) {
        fputs("\x1b[93mchoose (letter), space toggles in multi, enter commits\x1b[0m\n",
              stdout);
    } else if (strcmp(P.req_kind, "extcmd") == 0) {
        fputs("\x1b[93mextended command (letter), esc cancels\x1b[0m\n", stdout);
    } else {
        printf("\x1b[93m[%s] key to continue\x1b[0m\n", P.req_kind);
    }
}

static void
render(void)
{
    fputs("\x1b[H", stdout);
    render_map();
    render_status();
    render_msgs();
    render_prompt();
    fflush(stdout);
}

/* ---------------- engine lines ---------------- */

void
hl_play_on_line(const char *line)
{
    const char *p;
    int ok = 0;
    char *method = NULL;
    long long id = -1;
    if (!line)
        return;
    p = j_find_key(line, "method");
    if (p)
        method = j_parse_str(p, &ok);
    if (!ok) {
        free(method);
        return; /* reply id=.. : nothing to show */
    }
    p = j_find_key(line, "id");
    if (p)
        id = j_parse_int(p, &ok);
    if (strcmp(method, "input") == 0) {
        const char *pp = strstr(line, "\"params\"");
        free(P.req_params);
        P.req_params = pp ? strdup(pp) : strdup("{}");
        P.req_id = id;
        p = j_find_key(line, "kind");
        {
            char *k = p ? j_parse_str(p, &ok) : NULL;
            if (ok && k) {
                strncpy(P.req_kind, k, sizeof P.req_kind - 1);
                P.req_kind[sizeof P.req_kind - 1] = '\0';
            } else {
                P.req_kind[0] = '\0';
            }
            free(k);
        }
        p = j_find_key(line, "how");
        P.req_how = p ? (int) j_parse_int(p, &ok) : 0;
    } else if (strcmp(method, "message") == 0 || strcmp(method, "text") == 0) {
        p = j_find_key(line, "text");
        if (p) {
            char *t = j_parse_str(p, &ok);
            if (ok && t)
                push_msg(t);
            free(t);
        }
    } else if (strcmp(method, "status_update") == 0) {
        const char *pf = j_find_key(line, "field");
        const char *pv = j_find_key(line, "value");
        if (pf && pv) {
            int fld = (int) j_parse_int(pf, &ok);
            if (ok) {
                char *v = j_parse_str(pv, &ok);
                if (ok && v)
                    set_status_by_field(fld, v);
                free(v);
            }
        }
    } else if (strcmp(method, "status") == 0) {
        static const char *keys[] = { "hp", "hpmax", "ene", "enemax",
            "ac", "gold", "xp", "leveldesc", "time", "name", NULL
        };
        int i;
        const char *pp = strstr(line, "\"params\"");
        for (i = 0; keys[i]; i++)
            set_status_field(keys[i], pp ? pp : line);
    } else if (strcmp(method, "snapshot") == 0 || strcmp(method, "map_delta") == 0) {
        apply_cells(line);
    } else if (strcmp(method, "menu_start") == 0) {
        p = j_find_key(line, "window");
        if (p) {
            int w = (int) j_parse_int(p, &ok);
            if (ok && w >= 0 && w < 64) {
                P.wins[w].used = 1;
                P.wins[w].nitems = 0;
                P.wins[w].prompt[0] = '\0';
            }
        }
    } else if (strcmp(method, "menu_item") == 0) {
        const char *pp = strstr(line, "\"params\"");
        store_menu_item(pp ? pp : line);
    } else if (strcmp(method, "menu_end") == 0) {
        const char *pp = strstr(line, "\"params\"");
        int w = -1;
        p = j_find_key(line, "window");
        if (p)
            w = (int) j_parse_int(p, &ok);
        if (w >= 0 && w < 64 && pp) {
            p = j_find_key(pp, "prompt");
            if (p) {
                char *t = j_parse_str(p, &ok);
                if (ok && t) {
                    strncpy(P.wins[w].prompt, t, sizeof P.wins[w].prompt - 1);
                    free(t);
                } else {
                    free(t);
                }
            }
        }
    } else if (strcmp(method, "session_ended") == 0) {
        p = j_find_key(line, "reason");
        if (p) {
            char *t = j_parse_str(p, &ok);
            if (ok && t) {
                char tmp[128];
                snprintf(tmp, sizeof tmp, "-- session ended: %s --", t);
                push_msg(tmp);
                free(t);
            }
        }
        P.ended = 1;
    } else if (strcmp(method, "bell") == 0) {
        fputc('\a', stdout);
        fflush(stdout);
        free(method);
        return;
    }
    free(method);
    render();
}

/* ---------------- answers ---------------- */

/* Render the pending menu over the message area, then read the choice. */
static char *
answer_menu(void)
{
    const char *pp = P.req_params ? P.req_params : "{}";
    const char *p = j_find_key(pp, "window");
    int ok = 0, w = -1, i, how = P.req_how;
    int picked[512] = { 0 };
    int npicked = 0;
    if (p)
        w = (int) j_parse_int(p, &ok);
    if (!ok || w < 0 || w >= 64 || !P.wins[w].used) {
        char *r = strdup("{\"picks\":[],\"counts\":[]}");
        return r ? r : strdup("{}");
    }
    fputs("\x1b[H", stdout);
    render_map();
    render_status();
    if (P.wins[w].prompt[0])
        printf("\x1b[1m%s\x1b[0m\n", P.wins[w].prompt);
    for (i = 0; i < P.wins[w].nitems; i++) {
        int a = P.wins[w].items[i].accel;
        char disp = a > 0 && a < 127 ? (char) a : (char) ('a' + (i % 26));
        printf("  \x1b[93m[%c]\x1b[0m %s\n", disp,
               P.wins[w].items[i].text);
    }
    if (how == 2)
        fputs("-- space toggles, enter commits, esc cancels --\n", stdout);
    else
        fputs("-- letter to choose, esc cancels --\n", stdout);
    fflush(stdout);
    if (how == 0) {
        /* display-only menu */
        int k = read_key();
        (void) k;
        return strdup("{\"picks\":[],\"counts\":[]}");
    }
    if (how == 1) {
        for (;;) {
            int k = read_key();
            int j;
            if (k < 0)
                return strdup("{\"cancelled\":true}");
            if (k == 27)
                return strdup("{\"cancelled\":true}");
            for (j = 0; j < P.wins[w].nitems; j++) {
                int a = P.wins[w].items[j].accel;
                char disp = a > 0 && a < 127 ? (char) a : (char) ('a' + (j % 26));
                if (k == disp || k == ('a' + (j % 26))) {
                    char *r = malloc(64);
                    if (!r)
                        return strdup("{\"cancelled\":true}");
                    snprintf(r, 64, "{\"picks\":[%d],\"counts\":[]}", j);
                    return r;
                }
            }
        }
    }
    /* PICK_ANY: toggle with letters, enter commits */
    for (;;) {
        int k = read_key();
        int j;
        if (k < 0)
            return strdup("{\"cancelled\":true}");
        if (k == 27)
            return strdup("{\"cancelled\":true}");
        if (k == '\r' || k == '\n') {
            char *r, *q;
            size_t cap = 64 + (size_t) npicked * 8;
            r = malloc(cap);
            if (!r)
                return strdup("{\"cancelled\":true}");
            strcpy(r, "{\"picks\":[");
            q = r + strlen(r);
            for (j = 0; j < P.wins[w].nitems; j++) {
                if (!picked[j])
                    continue;
                q += snprintf(q, cap - (size_t) (q - r), "%s%d",
                              q == r + 10 ? "" : ",", j);
            }
            snprintf(q, cap - (size_t) (q - r), "],\"counts\":[]}");
            return r;
        }
        for (j = 0; j < P.wins[w].nitems; j++) {
            int a = P.wins[w].items[j].accel;
            char disp = a > 0 && a < 127 ? (char) a : (char) ('a' + (j % 26));
            if (k == disp || k == ' ') {
                if (k == ' ')
                    continue; /* space alone only toggles in tty nh */
                picked[j] = !picked[j];
                if (picked[j])
                    npicked++;
                else
                    npicked--;
                fputs(picked[j] ? "+" : "-", stdout);
                fflush(stdout);
                break;
            }
        }
    }
}

static char *
answer_yn(void)
{
    const char *pp = P.req_params ? P.req_params : "{}";
    const char *p = j_find_key(pp, "default");
    int ok = 0, def = 'n';
    if (p)
        def = (int) j_parse_int(p, &ok);
    for (;;) {
        int k = read_key();
        char *r;
        if (k < 0)
            k = def;
        if (k == 27 || k == '\r' || k == '\n' || k == ' ')
            k = def;
        r = malloc(32);
        if (!r)
            return strdup("{\"answer\":\"n\"}");
        snprintf(r, 32, "{\"answer\":\"%c\"}", (char) k);
        return r;
    }
}

/* JSON-escape a line answer. */
static char *
quote_line(const char *s)
{
    size_t n = 0;
    const char *p;
    char *out, *q;
    for (p = s; *p; p++)
        n += (*p == '"' || *p == '\\') ? 2 : 1;
    out = malloc(n + 16);
    if (!out)
        return strdup("\"\"");
    q = out;
    *q++ = '"';
    for (p = s; *p; p++) {
        if (*p == '"' || *p == '\\')
            *q++ = '\\';
        *q++ = *p;
    }
    *q++ = '"';
    *q = '\0';
    return out;
}

static char *
answer_getlin(void)
{
    char buf[256];
    size_t len = 0;
    char *q, *r;
    for (;;) {
        int k = read_key();
        if (k < 0 || k == 27) {
            buf[0] = '\0';
            break;
        }
        if ((k == '\r' || k == '\n') && len < sizeof buf - 1) {
            buf[len] = '\0';
            break;
        }
        if ((k == 127 || k == 8) && len > 0) {
            len--;
            fputs("\b \b", stdout);
            fflush(stdout);
            continue;
        }
        if (k >= 32 && k < 127 && len < sizeof buf - 1) {
            buf[len++] = (char) k;
            fputc(k, stdout);
            fflush(stdout);
        }
    }
    buf[len] = '\0';
    q = quote_line(buf);
    r = malloc(strlen(q) + 16);
    if (!r) {
        free(q);
        return strdup("{\"line\":\"\"}");
    }
    snprintf(r, strlen(q) + 16, "{\"line\":%s}", q);
    free(q);
    return r;
}

static char *
answer_extcmd(void)
{
    const char *pp = P.req_params ? P.req_params : "{}";
    const char *arr = strstr(pp, "\"commands\"");
    char cmds[128][48];
    int n = 0, i;
    fputs("\x1b[H", stdout);
    render_map();
    render_status();
    fputs("\x1b[1mextended command\x1b[0m\n", stdout);
    if (arr) {
        const char *p = strchr(arr, '[');
        if (p) {
            p++;
            while (*p && *p != ']' && n < 128) {
                if (*p == '"') {
                    int ok = 0;
                    char *s = j_parse_str(p, &ok);
                    const char *e;
                    if (ok && s) {
                        strncpy(cmds[n], s, 47);
                        cmds[n][47] = '\0';
                        free(s);
                        n++;
                    }
                    e = p + 1;
                    while (*e && *e != '"') {
                        if (*e == '\\' && e[1])
                            e++;
                        e++;
                    }
                    p = *e ? e + 1 : e;
                } else {
                    p++;
                }
            }
        }
    }
    for (i = 0; i < n; i++)
        printf("  \x1b[93m[%c]\x1b[0m %s\n", (char) ('a' + (i % 26)), cmds[i]);
    fputs("-- letter to run, esc cancels --\n", stdout);
    fflush(stdout);
    for (;;) {
        int k = read_key();
        char *r = malloc(32);
        if (!r)
            return strdup("{\"index\":-1}");
        if (k < 0 || k == 27) {
            strcpy(r, "{\"index\":-1}");
            return r;
        }
        if ((k >= 'a' && k < 'a' + n) || (k >= 'A' && k < 'A' + n)) {
            int idx = (k >= 'a') ? k - 'a' : k - 'A';
            snprintf(r, 32, "{\"index\":%d}", idx);
            return r;
        }
    }
}

/* Answer body for the pending request (bare result object). */
static char *
read_body(void)
{
    char *r = NULL;
    if (!P.req_kind[0]) {
        /* no pending request (shouldn't happen): wait for a key so the
         * human, not a spin loop, drives */
        int k = read_key();
        (void) k;
        return strdup("{}");
    }
    if (strcmp(P.req_kind, "ack") == 0 || strcmp(P.req_kind, "msgmenu") == 0) {
        int k = read_key();
        (void) k;
        if (strcmp(P.req_kind, "msgmenu") == 0)
            return strdup("{\"answer\":\"\\r\"}");
        return strdup("{}");
    }
    if (strcmp(P.req_kind, "key") == 0 || strcmp(P.req_kind, "poskey") == 0) {
        int k = read_key();
        char *out;
        if (k < 0)
            k = 27;
        out = malloc(64);
        if (!out)
            return strdup("{\"key\":27}");
        if (strcmp(P.req_kind, "key") == 0)
            snprintf(out, 64, "{\"key\":%d}", k);
        else
            snprintf(out, 64, "{\"x\":0,\"y\":0,\"mod\":0,\"key\":%d}", k);
        r = out;
    } else if (strcmp(P.req_kind, "menu") == 0) {
        r = answer_menu();
    } else if (strcmp(P.req_kind, "yn") == 0) {
        r = answer_yn();
    } else if (strcmp(P.req_kind, "getlin") == 0) {
        r = answer_getlin();
    } else if (strcmp(P.req_kind, "extcmd") == 0) {
        r = answer_extcmd();
    } else {
        int k = read_key();
        (void) k;
        r = strdup("{}");
    }
    P.req_kind[0] = '\0';
    free(P.req_params);
    P.req_params = NULL;
    return r ? r : strdup("{}");
}

/* Full client->engine envelope for the pending request id, which is what
 * rpc_input validates and unwraps. */
char *
hl_play_read(void)
{
    char *body = read_body();
    char *env;
    size_t n;
    if (!body)
        return NULL;
    n = strlen(body) + 64;
    env = malloc(n);
    if (!env) {
        free(body);
        return NULL;
    }
    snprintf(env, n, "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":%s}",
             P.req_id, body);
    free(body);
    return env;
}
