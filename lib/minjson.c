/* minjson — see minjson.h. */
#include "minjson.h"

#include <stdio.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>

static const char *
skip_ws(const char *p)
{
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')
        p++;
    return p;
}

/* End of the value starting at p (valid JSON assumed where located). */
static const char *
val_end(const char *p)
{
    int depth = 0;
    int instr = 0;
    for (;;) {
        char c = *p;
        if (!c)
            return p;
        if (instr) {
            if (c == '\\') {
                p += 2;
                continue;
            }
            if (c == '"')
                instr = 0;
            p++;
            continue;
        }
        if (c == '"') {
            instr = 1;
            p++;
            continue;
        }
        if (c == '{' || c == '[') {
            depth++;
            p++;
            continue;
        }
        if (c == '}' || c == ']') {
            if (depth == 0)
                return p;
            depth--;
            p++;
            continue;
        }
        if ((c == ',' || c == '}' || c == ']') && depth == 0)
            return p;
        if (c == ',' && depth == 0)
            return p;
        p++;
    }
}

int
mj_find(const char *json, const char *key, mj_val *out)
{
    const char *p;
    size_t klen;
    if (!json || !key || !out)
        return 0;
    p = skip_ws(json);
    if (*p != '{')
        return 0;
    p++;
    klen = strlen(key);
    for (;;) {
        const char *ks, *ke, *v;
        p = skip_ws(p);
        if (*p == '}')
            return 0;
        if (*p != '"')
            return 0;
        ks = p + 1;
        /* keys here are plain (no escapes needed for our shapes). */
        ke = strchr(ks, '"');
        if (!ke)
            return 0;
        p = skip_ws(ke + 1);
        if (*p != ':')
            return 0;
        v = skip_ws(p + 1);
        if ((size_t) (ke - ks) == klen && memcmp(ks, key, klen) == 0) {
            out->p = v;
            return 1;
        }
        p = val_end(v);
        p = skip_ws(p);
        if (*p == ',') {
            p++;
            continue;
        }
        return 0;
    }
}

static int
valid_string(const char **cursor)
{
    const unsigned char *p = (const unsigned char *) *cursor;
    if (*p++ != '"') return 0;
    while (*p && *p != '"') {
        if (*p < 0x20) return 0;
        if (*p++ == '\\') {
            unsigned char c = *p++;
            if (!c) return 0;
            if (c == 'u') {
                int i;
                for (i = 0; i < 4; i++, p++)
                    if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f') || (*p >= 'A' && *p <= 'F'))) return 0;
            } else if (!strchr("\"\\/bfnrt", c)) return 0;
        }
    }
    if (*p != '"') return 0;
    *cursor = (const char *) p + 1;
    return 1;
}

static int
valid_value(const char **cursor, int depth)
{
    const char *p = skip_ws(*cursor);
    if (depth > 32) return 0;
    if (*p == '"') {
        if (!valid_string(&p)) return 0;
    } else if (*p == '{' || *p == '[') {
        int object = *p == '{';
        char end = object ? '}' : ']';
        p = skip_ws(p + 1);
        if (*p != end) for (;;) {
            if (object) {
                if (!valid_string(&p)) return 0;
                p = skip_ws(p); if (*p++ != ':') return 0;
            }
            if (!valid_value(&p, depth + 1)) return 0;
            p = skip_ws(p);
            if (*p == end) break;
            if (*p++ != ',') return 0;
            p = skip_ws(p);
        }
        p++;
    } else if (!strncmp(p, "true", 4)) p += 4;
    else if (!strncmp(p, "false", 5)) p += 5;
    else if (!strncmp(p, "null", 4)) p += 4;
    else {
        if (*p == '-') p++;
        if (*p == '0') p++;
        else {
            if (*p < '1' || *p > '9') return 0;
            while (*p >= '0' && *p <= '9') p++;
        }
        if (*p == '.') {
            p++; if (*p < '0' || *p > '9') return 0;
            while (*p >= '0' && *p <= '9') p++;
        }
        if (*p == 'e' || *p == 'E') {
            p++; if (*p == '+' || *p == '-') p++;
            if (*p < '0' || *p > '9') return 0;
            while (*p >= '0' && *p <= '9') p++;
        }
    }
    *cursor = p;
    return 1;
}

int
mj_valid(const char *json)
{
    const char *p = json;
    return json && valid_value(&p, 0) && !*skip_ws(p);
}

static int
hexval(char c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return 10 + c - 'a';
    if (c >= 'A' && c <= 'F')
        return 10 + c - 'A';
    return -1;
}

char *
mj_str(mj_val v)
{
    const char *p;
    char *out, *w;
    size_t cap = 64, n = 0;
    if (*v.p != '"')
        return NULL;
    p = v.p + 1;
    out = malloc(cap);
    if (!out)
        return NULL;
    w = out;
    for (;;) {
        char c = *p++;
        if (!c) {
            free(out);
            return NULL;
        }
        if (c == '"')
            break;
        if (c == '\\') {
            int h1, h2, h3, h4;
            c = *p++;
            switch (c) {
            case '"': c = '"'; break;
            case '\\': c = '\\'; break;
            case '/': c = '/'; break;
            case 'b': c = '\b'; break;
            case 'f': c = '\f'; break;
            case 'n': c = '\n'; break;
            case 'r': c = '\r'; break;
            case 't': c = '\t'; break;
            case 'u':
                /* BMP only, enough for engine text; others become '?'. */
                h1 = hexval(p[0]);
                h2 = hexval(p[1]);
                h3 = hexval(p[2]);
                h4 = hexval(p[3]);
                if (h1 < 0 || h2 < 0 || h3 < 0 || h4 < 0) {
                    free(out);
                    return NULL;
                }
                {
                    unsigned cp = (unsigned) ((h1 << 12) | (h2 << 8) | (h3 << 4) | h4);
                    p += 4;
                    if (cp < 0x80) {
                        c = (char) cp;
                        break;
                    }
                    /* encode UTF-8 inline */
                    if (n + 3 >= cap) {
                        cap *= 2;
                        out = realloc(out, cap);
                        if (!out)
                            return NULL;
                        w = out + n;
                    }
                    if (cp < 0x800) {
                        *w++ = (char) (0xc0 | (cp >> 6));
                        n++;
                        *w++ = (char) (0x80 | (cp & 0x3f));
                        n++;
                    } else {
                        *w++ = (char) (0xe0 | (cp >> 12));
                        n++;
                        *w++ = (char) (0x80 | ((cp >> 6) & 0x3f));
                        n++;
                        *w++ = (char) (0x80 | (cp & 0x3f));
                        n++;
                    }
                    continue;
                }
            default:
                free(out);
                return NULL;
            }
        }
        if (n + 2 >= cap) {
            cap *= 2;
            out = realloc(out, cap);
            if (!out)
                return NULL;
            w = out + n;
        }
        *w++ = c;
        n++;
    }
    *w = '\0';
    return out;
}

int
mj_int(mj_val v, long long *out)
{
    char *end;
    long long n;
    if (!out)
        return 0;
    errno = 0;
    n = strtoll(v.p, &end, 10);
    if (end == v.p || errno == ERANGE ||
        (*end && *end != ',' && *end != '}' && *end != ']' &&
         *end != ' ' && *end != '\t' && *end != '\r' && *end != '\n'))
        return 0;
    *out = n;
    return 1;
}

int
mj_bool(mj_val v, int *out)
{
    if (!out)
        return 0;
    if (!strncmp(v.p, "true", 4)) {
        *out = 1;
        return 1;
    }
    if (!strncmp(v.p, "false", 5)) {
        *out = 0;
        return 1;
    }
    return 0;
}

int
mj_is_null(mj_val v)
{
    return !strncmp(v.p, "null", 4);
}

const char *
mj_raw(mj_val v, size_t *len_out)
{
    const char *e = val_end(v.p);
    if (len_out)
        *len_out = (size_t) (e - v.p);
    return v.p;
}

int
mj_arr_next(const char *json_array, mj_arr_it *it, mj_val *out)
{
    const char *p;
    if (!json_array || !it || !out)
        return 0;
    p = it->first ? skip_ws(json_array) : it->p;
    if (it->first) {
        if (*p != '[')
            return 0;
        p = skip_ws(p + 1);
        it->first = 0;
    }
    if (*p == ']')
        return 0;
    out->p = p;
    p = val_end(p);
    p = skip_ws(p);
    if (*p == ',')
        p++;
    it->p = p;
    return 1;
}

/* ---- emit ---- */

void
mj_init(mj_Buf *b)
{
    b->buf = NULL;
    b->len = b->cap = 0;
    b->ok = 1;
    b->depth = 0;
    memset(b->need_comma, 0, sizeof b->need_comma);
}

void
mj_free(mj_Buf *b)
{
    free(b->buf);
    b->buf = NULL;
    b->len = b->cap = 0;
}

char *
mj_take(mj_Buf *b)
{
    char *out = b->buf ? b->buf : strdup("");
    b->buf = NULL;
    b->len = b->cap = 0;
    return out;
}

static void
putc_(mj_Buf *b, char c)
{
    if (!b->ok)
        return;
    if (b->len + 2 > b->cap) {
        size_t ncap = b->cap ? b->cap * 2 : 256;
        char *nb = realloc(b->buf, ncap);
        if (!nb) {
            b->ok = 0;
            return;
        }
        b->buf = nb;
        b->cap = ncap;
    }
    b->buf[b->len++] = c;
    b->buf[b->len] = '\0';
}

static void
puts_(mj_Buf *b, const char *s)
{
    while (*s)
        putc_(b, *s++);
}

static void
comma(mj_Buf *b)
{
    if (b->depth > 0 && b->need_comma[b->depth - 1])
        putc_(b, ',');
    if (b->depth > 0)
        b->need_comma[b->depth - 1] = 1;
}

void
mj_obj(mj_Buf *b)
{
    comma(b);
    putc_(b, '{');
    if (b->depth < 32) {
        b->need_comma[b->depth] = 0;
        b->depth++;
    } else {
        b->ok = 0;
    }
}

void
mj_endobj(mj_Buf *b)
{
    if (b->depth > 0)
        b->depth--;
    putc_(b, '}');
}

void
mj_arr(mj_Buf *b)
{
    comma(b);
    putc_(b, '[');
    if (b->depth < 32) {
        b->need_comma[b->depth] = 0;
        b->depth++;
    } else {
        b->ok = 0;
    }
}

void
mj_endarr(mj_Buf *b)
{
    if (b->depth > 0)
        b->depth--;
    putc_(b, ']');
}

void
mj_key(mj_Buf *b, const char *k)
{
    comma(b);
    putc_(b, '"');
    puts_(b, k);
    puts_(b, "\":");
    if (b->depth > 0)
        b->need_comma[b->depth - 1] = 0;
}

void
mj_strv(mj_Buf *b, const char *s)
{
    const unsigned char *p;
    comma(b);
    putc_(b, '"');
    if (s) {
        for (p = (const unsigned char *) s; *p; p++) {
            switch (*p) {
            case '"': puts_(b, "\\\""); break;
            case '\\': puts_(b, "\\\\"); break;
            case '\b': puts_(b, "\\b"); break;
            case '\f': puts_(b, "\\f"); break;
            case '\n': puts_(b, "\\n"); break;
            case '\r': puts_(b, "\\r"); break;
            case '\t': puts_(b, "\\t"); break;
            default:
                if (*p < 0x20) {
                    char esc[7];
                    snprintf(esc, sizeof esc, "\\u%04x", *p);
                    puts_(b, esc);
                } else {
                    putc_(b, (char) *p);
                }
            }
        }
    }
    putc_(b, '"');
}

void
mj_intv(mj_Buf *b, long long v)
{
    char tmp[32];
    comma(b);
    snprintf(tmp, sizeof tmp, "%lld", v);
    puts_(b, tmp);
}

void
mj_boolv(mj_Buf *b, int v)
{
    comma(b);
    puts_(b, v ? "true" : "false");
}

void
mj_nullv(mj_Buf *b)
{
    comma(b);
    puts_(b, "null");
}

void
mj_rawv(mj_Buf *b, const char *s)
{
    comma(b);
    puts_(b, s ? s : "null");
}

struct canonical_member { char *key; mj_val value; };
static int canonical_cmp(const void *a, const void *b)
{
    return strcmp(((const struct canonical_member *) a)->key,
                  ((const struct canonical_member *) b)->key);
}

static int canonical_into(mj_Buf *b, mj_val v, int depth)
{
    const char *p = skip_ws(v.p);
    v.p = p;
    if (depth > 24) return 0;
    if (*p == '{') {
        struct canonical_member members[64];
        size_t n = 0, i;
        int ok = 1;
        p = skip_ws(p + 1);
        while (*p && *p != '}') {
            char *key;
            const char *q;
            if (*p != '"' || n == 64) { ok = 0; break; }
            key = mj_str((mj_val) { p });
            if (!key) { ok = 0; break; }
            q = p + 1;
            while (*q && *q != '"') { if (*q == '\\' && q[1]) q++; q++; }
            p = skip_ws(*q ? q + 1 : q);
            if (*p != ':') { free(key); ok = 0; break; }
            p = skip_ws(p + 1);
            members[n].key = key;
            members[n++].value.p = p;
            p = skip_ws(val_end(p));
            if (*p == ',') p = skip_ws(p + 1);
            else if (*p != '}') { ok = 0; break; }
        }
        if (*p != '}') ok = 0;
        qsort(members, n, sizeof members[0], canonical_cmp);
        mj_obj(b);
        for (i = 0; i < n; i++) {
            if (i && !strcmp(members[i - 1].key, members[i].key)) ok = 0;
            mj_key(b, members[i].key);
            if (!canonical_into(b, members[i].value, depth + 1)) ok = 0;
        }
        mj_endobj(b);
        for (i = 0; i < n; i++) free(members[i].key);
        return ok;
    }
    if (*p == '[') {
        mj_arr_it it = { 0 };
        mj_val item;
        it.first = 1;
        mj_arr(b);
        while (mj_arr_next(p, &it, &item))
            if (!canonical_into(b, item, depth + 1)) return 0;
        mj_endarr(b);
        return 1;
    }
    if (*p == '"') {
        char *s = mj_str(v);
        if (!s) return 0;
        mj_strv(b, s); free(s); return 1;
    }
    {
        const char *end = val_end(p);
        size_t len;
        char *raw;
        while (end > p && (end[-1] == ' ' || end[-1] == '\n' || end[-1] == '\r' || end[-1] == '\t')) end--;
        len = (size_t) (end - p);
        raw = malloc(len + 1);
        if (!raw) return 0;
        memcpy(raw, p, len); raw[len] = '\0';
        mj_rawv(b, raw); free(raw); return 1;
    }
}

char *mj_canonical(mj_val v)
{
    mj_Buf b;
    mj_init(&b);
    if (!canonical_into(&b, v, 0) || !b.ok) { mj_free(&b); return NULL; }
    return mj_take(&b);
}
