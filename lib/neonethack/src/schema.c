/* Deliberately small evaluator for the schema vocabulary in catalog.ts.
 * The emitted catalog is also used by MCP/TS. Unsupported schema vocabulary
 * must be implemented here and covered by conformance tests before use.
 */
#include "minjson.h"
#include <stdlib.h>
#include <string.h>

static const char *ws(const char *p) { while (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t') p++; return p; }
/* Walk a previously lexically validated JSON object. Literal field names only.
 * Returns -1 for escaped/duplicate keys, 0 at end, 1 for a field.
 */
int nnh_object_next(const char **cursor, char **key, mj_val *value)
{
    const char *p = ws(*cursor), *end;
    size_t n;
    if (*p == '{' || *p == ',') p = ws(p + 1);
    if (*p == '}') return 0;
    if (*p != '"' || !(end = strchr(p + 1, '"')) || memchr(p + 1, '\\', (size_t)(end - p - 1))) return -1;
    *key = mj_str((mj_val){p});
    if (!*key) return -1;
    p = ws(end + 1);
    if (*p != ':') { free(*key); return -1; }
    value->p = ws(p + 1);
    mj_raw(*value, &n);
    *cursor = ws(value->p + n);
    return 1;
}

static long long bound(mj_val schema, const char *name, long long fallback)
{
    mj_val v; long long n;
    return mj_find(schema.p, name, &v) && mj_int(v, &n) ? n : fallback;
}
static int equal(mj_val a, mj_val b)
{
    char *x = mj_canonical(a), *y = mj_canonical(b);
    int ok = x && y && !strcmp(x, y);
    free(x); free(y); return ok;
}
int nnh_schema_valid(mj_val schema, mj_val value, int depth)
{
    mj_val v, t;
    char *type;
    int ok = 0;
    if (depth > 24) return 0;
    if (mj_find(schema.p, "oneOf", &v)) {
        mj_arr_it it = {0}; int matches = 0; it.first = 1;
        while (mj_arr_next(v.p, &it, &t)) matches += nnh_schema_valid(t, value, depth + 1);
        return matches == 1;
    }
    if (mj_find(schema.p, "const", &v)) return equal(v, value);
    if (mj_find(schema.p, "enum", &v)) {
        mj_arr_it it = {0}; it.first = 1;
        while (mj_arr_next(v.p, &it, &t)) if (equal(t, value)) return 1;
        return 0;
    }
    if (!mj_find(schema.p, "type", &v) || !(type = mj_str(v))) return 0;
    if (!strcmp(type, "object") && *value.p == '{') {
        const char *p = value.p;
        mj_val properties, required, field;
        char *keys[32] = {0}, *key = NULL;
        size_t count = 0, i;
        int r;
        if (!mj_find(schema.p, "properties", &properties)) goto done;
        ok = 1;
        while ((r = nnh_object_next(&p, &key, &field)) > 0) {
            if (count == 32) { free(key); ok = 0; break; }
            for (i = 0; i < count; i++) if (!strcmp(keys[i], key)) break;
            keys[count++] = key;
            if (i != count - 1 || !mj_find(properties.p, key, &t) || !nnh_schema_valid(t, field, depth + 1)) { ok = 0; break; }
        }
        if (r < 0) ok = 0;
        if (ok && mj_find(schema.p, "required", &required)) {
            mj_arr_it it = {0}; it.first = 1;
            while (mj_arr_next(required.p, &it, &t)) {
                key = mj_str(t);
                if (!key || !mj_find(value.p, key, &field)) ok = 0;
                free(key);
            }
        }
        for (i = 0; i < count; i++) free(keys[i]);
    } else if (!strcmp(type, "string")) {
        char *s = mj_str(value);
        if (s) {
            size_t n = strlen(s), i;
            ok = n >= (size_t)bound(schema, "minLength", 0) && n <= (size_t)bound(schema, "x-maxBytes", 4096);
            for (i = 0; i < n; i++) if ((unsigned char)s[i] < 32 || s[i] == 127) ok = 0;
            if (ok && mj_find(schema.p, "pattern", &v)) {
                char *pattern = mj_str(v);
                if (pattern && !strcmp(pattern, "^[A-Za-z0-9_-]+$"))
                    for (i = 0; i < n; i++) if (!((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= 'A' && s[i] <= 'Z') || (s[i] >= '0' && s[i] <= '9') || s[i] == '_' || s[i] == '-')) ok = 0;
                free(pattern);
            }
            free(s);
        }
    } else if (!strcmp(type, "integer")) {
        long long n;
        ok = mj_int(value, &n) && n >= bound(schema, "minimum", -9007199254740991LL) && n <= bound(schema, "maximum", 9007199254740991LL);
    } else if (!strcmp(type, "boolean")) {
        int boolean; ok = mj_bool(value, &boolean);
    } else if (!strcmp(type, "array") && *value.p == '[' && mj_find(schema.p, "items", &t)) {
        mj_arr_it it = {0}; mj_val values[64]; size_t n = 0, i; int unique = 0;
        if (mj_find(schema.p, "uniqueItems", &v)) mj_bool(v, &unique);
        it.first = 1; ok = 1;
        while (mj_arr_next(value.p, &it, &v)) {
            if (n == 64 || !nnh_schema_valid(t, v, depth + 1)) { ok = 0; break; }
            if (unique) for (i = 0; i < n; i++) if (equal(values[i], v)) ok = 0;
            values[n++] = v;
        }
        if (n < (size_t)bound(schema, "minItems", 0) || n > (size_t)bound(schema, "maxItems", 64)) ok = 0;
    }
done:
    free(type); return ok;
}
