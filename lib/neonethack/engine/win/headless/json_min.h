/* neonethack headless port: minimal JSON emitter/parser.
 *
 * Spike-grade on purpose: the wire shapes are flat (null/bool/int64/string,
 * int arrays, flat objects), so this covers everything the protocol needs.
 * No floats, no nesting beyond one level of arrays/objects in practice.
 * Parser functions never allocate except j_parse_str (caller frees).
 */
#ifndef JSON_MIN_H
#define JSON_MIN_H

#include <stddef.h>

/* ---- emitter ---- */
typedef struct {
    char *buf;
    size_t len, cap;
    int depth_first[16];
    int depth;
    int ok; /* cleared on OOM */
} JBuf;

void jb_init(JBuf *jb);
void jb_free(JBuf *jb);
void jb_reset(JBuf *jb);
void jb_begin_obj(JBuf *jb);
void jb_end_obj(JBuf *jb);
void jb_begin_arr(JBuf *jb);
void jb_end_arr(JBuf *jb);
/* insert ',' when the current container already has an item */
void jb_sep(JBuf *jb);
void jb_key(JBuf *jb, const char *k);
void jb_str(JBuf *jb, const char *s);
void jb_int(JBuf *jb, long long v);
void jb_bool(JBuf *jb, int v);
void jb_null(JBuf *jb);
void jb_raw(JBuf *jb, const char *s); /* pre-rendered JSON fragment */

/* ---- line reader ---- */
#define JSON_MIN_MAX_LINE (16u * 1024u * 1024u)
/* Reads one '\n'-terminated line from fp. Returns heap buffer (caller frees)
 * or NULL on EOF/error/over-cap. Strips trailing '\n'/'\r'. */
char *json_read_line(void *fp);

/* ---- minimal parser (operates on one JSON text, no allocation except str)
 */
const char *j_find_key(const char *json, const char *key);
/* value starts at p (after colon, ws skipped by caller j_find_key) */
long long j_parse_int(const char *p, int *ok);
int j_parse_bool(const char *p, int *ok);
/* returns malloc'd unescaped string; handles \" \\ \/ \n \t \r \b \f
 * and \u00XX (latin-1 range mapped to single byte, else '?') */
char *j_parse_str(const char *p, int *ok);
/* parses [1,2,3] into out[0..cap); returns count or -1 on error */
int j_parse_int_array(const char *p, long long *out, int cap);

#endif /* JSON_MIN_H */
