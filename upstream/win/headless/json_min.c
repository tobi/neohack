/* neonethack headless port: minimal JSON emitter/parser (see json_min.h). */
#include "json_min.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef __EMSCRIPTEN__
#include "cli.h"
#include "play.h"
#endif

void
jb_init(JBuf *jb)
{
    jb->buf = NULL;
    jb->len = jb->cap = 0;
    jb->depth = 0;
    jb->ok = 1;
}

void
jb_free(JBuf *jb)
{
    free(jb->buf);
    jb->buf = NULL;
    jb->len = jb->cap = 0;
}

void
jb_reset(JBuf *jb)
{
    jb->len = 0;
    jb->depth = 0;
    jb->ok = 1;
    if (jb->buf)
        jb->buf[0] = '\0';
}

static void
jb_putc(JBuf *jb, char c)
{
    if (!jb->ok)
        return;
    if (jb->len + 2 > jb->cap) {
        size_t ncap = jb->cap ? jb->cap * 2 : 256;
        char *nb = realloc(jb->buf, ncap);
        if (!nb) {
            jb->ok = 0;
            return;
        }
        jb->buf = nb;
        jb->cap = ncap;
    }
    jb->buf[jb->len++] = c;
    jb->buf[jb->len] = '\0';
}

static void
jb_puts(JBuf *jb, const char *s)
{
    while (*s)
        jb_putc(jb, *s++);
}

void
jb_begin_obj(JBuf *jb)
{
    jb_putc(jb, '{');
    if (jb->depth < 16)
        jb->depth_first[jb->depth++] = 1;
}

void
jb_end_obj(JBuf *jb)
{
    jb_putc(jb, '}');
    if (jb->depth > 0)
        jb->depth--;
}

void
jb_begin_arr(JBuf *jb)
{
    jb_putc(jb, '[');
    if (jb->depth < 16)
        jb->depth_first[jb->depth++] = 1;
}

void
jb_end_arr(JBuf *jb)
{
    jb_putc(jb, ']');
    if (jb->depth > 0)
        jb->depth--;
}

void
jb_sep(JBuf *jb)
{
    if (jb->depth == 0)
        return;
    if (jb->depth_first[jb->depth - 1])
        jb->depth_first[jb->depth - 1] = 0;
    else
        jb_putc(jb, ',');
}

void
jb_key(JBuf *jb, const char *k)
{
    jb_sep(jb);
    jb_str(jb, k);
    jb_putc(jb, ':');
}

void
jb_str(JBuf *jb, const char *s)
{
    unsigned char c;
    char esc[7];
    jb_putc(jb, '"');
    if (!s)
        s = "";
    while ((c = (unsigned char) *s++) != '\0') {
        switch (c) {
        case '"':
        case '\\':
            jb_putc(jb, '\\');
            jb_putc(jb, (char) c);
            break;
        case '\n':
            jb_puts(jb, "\\n");
            break;
        case '\r':
            jb_puts(jb, "\\r");
            break;
        case '\t':
            jb_puts(jb, "\\t");
            break;
        case '\b':
            jb_puts(jb, "\\b");
            break;
        case '\f':
            jb_puts(jb, "\\f");
            break;
        default:
            if (c < 0x20) {
                snprintf(esc, sizeof esc, "\\u%04x", c);
                jb_puts(jb, esc);
            } else {
                jb_putc(jb, (char) c);
            }
            break;
        }
    }
    jb_putc(jb, '"');
}

void
jb_int(JBuf *jb, long long v)
{
    char num[32];
    snprintf(num, sizeof num, "%lld", v);
    jb_puts(jb, num);
}

void
jb_bool(JBuf *jb, int v)
{
    jb_puts(jb, v ? "true" : "false");
}

void
jb_null(JBuf *jb)
{
    jb_puts(jb, "null");
}

void
jb_raw(JBuf *jb, const char *s)
{
    if (s)
        jb_puts(jb, s);
}

char *
json_read_line(void *fp)
{
#ifdef __EMSCRIPTEN__
    /* wasm build: UI->engine lines arrive from JS via Asyncify
     * (see wasm/nh_wasm.c); the FILE* is unused. */
    extern char *nh_wasm_read_line(void);
    (void) fp;
    return nh_wasm_read_line();
#else
    FILE *f = (FILE *) fp;
    char *replayed;
    /* --replay serves logged lines first (resume without a client). */
    replayed = hl_cli_replay_next();
    if (replayed)
        return replayed;
    /* --play answers from the keyboard, never from stdin. */
    if (hl_cli.play) {
        char *ans = hl_play_read();
        if (ans)
            hl_cli_log_line(ans);
        return ans; /* full envelope; NULL = EOF */
    }
    size_t cap = 512, len = 0;
    char *buf = malloc(cap);
    int c;
    if (!buf)
        return NULL;
    for (;;) {
        c = fgetc(f);
        if (c == EOF) {
            free(buf);
            return NULL;
        }
        if (c == '\n')
            break;
        if (len + 1 >= cap) {
            size_t ncap = cap * 2;
            char *nb;
            if (ncap > JSON_MIN_MAX_LINE) {
                free(buf);
                return NULL;
            }
            nb = realloc(buf, ncap);
            if (!nb) {
                free(buf);
                return NULL;
            }
            buf = nb;
            cap = ncap;
        }
        buf[len++] = (char) c;
    }
    while (len > 0 && buf[len - 1] == '\r')
        len--;
    buf[len] = '\0';
    hl_cli_log_line(buf);
    return buf;
#endif
}

static const char *
skip_ws(const char *p)
{
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')
        p++;
    return p;
}

const char *
j_find_key(const char *json, const char *key)
{
    /* finds "key" : value at any depth (flat shapes only); returns value */
    size_t klen = strlen(key);
    const char *p = json;
    while ((p = strchr(p, '"')) != NULL) {
        if (strncmp(p + 1, key, klen) == 0 && p[1 + klen] == '"') {
            const char *q = skip_ws(p + 1 + klen + 1);
            if (*q == ':')
                return skip_ws(q + 1);
        }
        p++;
    }
    return NULL;
}

long long
j_parse_int(const char *p, int *ok)
{
    char *end = NULL;
    long long v;
    if (!p) {
        if (ok)
            *ok = 0;
        return 0;
    }
    v = strtoll(skip_ws(p), &end, 10);
    if (ok)
        *ok = (end != skip_ws(p));
    return v;
}

int
j_parse_bool(const char *p, int *ok)
{
    if (!p) {
        if (ok)
            *ok = 0;
        return 0;
    }
    p = skip_ws(p);
    if (ok)
        *ok = 1;
    if (strncmp(p, "true", 4) == 0)
        return 1;
    if (strncmp(p, "false", 5) == 0)
        return 0;
    if (ok)
        *ok = 0;
    return 0;
}

char *
j_parse_str(const char *p, int *ok)
{
    size_t cap = 64, len = 0;
    char *out;
    unsigned int cp;
    int nok = 1;
    if (!p) {
        if (ok)
            *ok = 0;
        return NULL;
    }
    p = skip_ws(p);
    out = malloc(cap);
    if (!out) {
        if (ok)
            *ok = 0;
        return NULL;
    }
    if (*p != '"') {
        /* accept bare numbers/words as strings */
        while (*p && *p != ',' && *p != '}' && *p != ']' && len + 1 < cap)
            out[len++] = *p++;
        out[len] = '\0';
        if (ok)
            *ok = (len > 0);
        return out;
    }
    p++;
    for (;;) {
        char c = *p++;
        char *nb;
        if (c == '\0' || c == '\n') {
            nok = 0;
            break;
        }
        if (c == '"')
            break;
        if (c == '\\') {
            c = *p++;
            switch (c) {
            case '"':
            case '\\':
            case '/':
                break;
            case 'n':
                c = '\n';
                break;
            case 'r':
                c = '\r';
                break;
            case 't':
                c = '\t';
                break;
            case 'b':
                c = '\b';
                break;
            case 'f':
                c = '\f';
                break;
            case 'u':
                cp = 0;
                for (int i = 0; i < 4; i++) {
                    char h = *p++;
                    cp <<= 4;
                    if (h >= '0' && h <= '9')
                        cp |= (unsigned int) (h - '0');
                    else if (h >= 'a' && h <= 'f')
                        cp |= (unsigned int) (h - 'a' + 10);
                    else if (h >= 'A' && h <= 'F')
                        cp |= (unsigned int) (h - 'A' + 10);
                    else {
                        nok = 0;
                        cp = '?';
                        break;
                    }
                }
                c = (cp < 256) ? (char) cp : '?';
                break;
            default:
                break; /* keep char as-is */
            }
        }
        if (len + 1 >= cap) {
            cap *= 2;
            nb = realloc(out, cap);
            if (!nb) {
                free(out);
                if (ok)
                    *ok = 0;
                return NULL;
            }
            out = nb;
        }
        out[len++] = c;
    }
    out[len] = '\0';
    if (ok)
        *ok = nok;
    return out;
}

int
j_parse_int_array(const char *p, long long *out, int cap)
{
    int n = 0;
    int ok;
    if (!p)
        return -1;
    p = skip_ws(p);
    if (*p != '[')
        return -1;
    p++;
    for (;;) {
        p = skip_ws(p);
        if (*p == ']')
            return n;
        if (n >= cap)
            return -1;
        out[n++] = j_parse_int(p, &ok);
        if (!ok)
            return -1;
        /* advance past the number */
        if (*p == '-' || *p == '+')
            p++;
        while (isdigit((unsigned char) *p))
            p++;
        p = skip_ws(p);
        if (*p == ',') {
            p++;
            continue;
        }
        if (*p == ']')
            return n;
        return -1;
    }
}
