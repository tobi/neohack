#define _GNU_SOURCE
#include "mcp.h"
#include <stdlib.h>
#include <string.h>

char *mcp_take(mj_Buf *b) { if (!b->ok) { mj_free(b); return NULL; } return mj_take(b); }
mj_val mcp_field(const char *s, const char *key) { mj_val v = {NULL}; if (s) mj_find(s,key,&v); return v; }
char *mcp_string(mj_val value) { return value.p ? mj_str(value) : NULL; }
void mcp_raw(mj_Buf *b, mj_val v)
{
    size_t n; char *s;
    if (!v.p) { mj_nullv(b); return; }
    mj_raw(v,&n); s = strndup(v.p,n);
    if (!s) { b->ok = 0; return; }
    mj_rawv(b,s); free(s);
}
char *mcp_failure(int code, const char *message)
{
    mj_Buf b; mj_init(&b); mj_obj(&b);
    mj_key(&b,"code"); mj_intv(&b,code);
    mj_key(&b,"message"); mj_strv(&b,message);
    mj_endobj(&b); return mcp_take(&b);
}
