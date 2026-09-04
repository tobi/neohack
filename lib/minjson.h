/* minjson — tiny owned JSON parse/emit for libneonethack. C99, no deps.
 *
 * Parse model: zero-copy locators into the source string. mj_find() locates
 * a key's value within one flat object level; mj_str/int/bool() decode it
 * (mj_str mallocs the unescaped string, caller frees). mj_arr_next()
 * walks array elements. Only what the adapter needs exists here.
 *
 * Emit model: mj_Buf appends builder (objects, arrays, escaped strings,
 * ints, bools, null, raw fragments). Renders NUL-terminated JSON.
 */
#ifndef MINJSON_H
#define MINJSON_H

#include <stddef.h>

typedef struct {
    const char *p;   /* value start (after colon, ws skipped) */
} mj_val;

/* Find "key" in the flat object at json (which must start at '{').
 * Returns 1 and fills *out; 0 when absent or malformed. */
int mj_find(const char *json, const char *key, mj_val *out);

/* Decode helpers. mj_str returns malloc'd unescaped string (or NULL);
 * the int/bool variants return 1 on success. */
char *mj_str(mj_val v);
int mj_int(mj_val v, long long *out);
int mj_bool(mj_val v, int *out);
/* 1 when the value is JSON null. */
int mj_is_null(mj_val v);
/* Raw span of a value (object/array/string/word), for nested decode. */
const char *mj_raw(mj_val v, size_t *len_out);
/* Owned canonical JSON: sorted object keys, normalized whitespace. */
char *mj_canonical(mj_val v);

/* Walk the elements of an array value: init with the array value, then
 * call repeatedly; returns 1 per element, 0 at the end. */
typedef struct {
    const char *p;
    int first;
} mj_arr_it;
int mj_arr_next(const char *json_array, mj_arr_it *it, mj_val *out);

/* Emit builder. */
typedef struct {
    char *buf;
    size_t len, cap;
    int ok;
    int depth;
    int need_comma[32];
} mj_Buf;

void mj_init(mj_Buf *b);
void mj_free(mj_Buf *b);
/* Steal the buffer (NUL-terminated); caller frees. Builder left empty. */
char *mj_take(mj_Buf *b);
void mj_obj(mj_Buf *b);
void mj_endobj(mj_Buf *b);
void mj_arr(mj_Buf *b);
void mj_endarr(mj_Buf *b);
void mj_key(mj_Buf *b, const char *k);
void mj_strv(mj_Buf *b, const char *s);
void mj_intv(mj_Buf *b, long long v);
void mj_boolv(mj_Buf *b, int v);
void mj_nullv(mj_Buf *b);
/* Pre-rendered JSON fragment (object/array/number). */
void mj_rawv(mj_Buf *b, const char *s);

#endif /* MINJSON_H */
