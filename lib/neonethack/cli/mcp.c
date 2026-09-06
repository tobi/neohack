/* Native MCP stdio server. Game validation and execution use only public C API. */
#define _POSIX_C_SOURCE 200809L
#include "neonethack.h"
#include "minjson.h"
#include "compact.h"
#include "mcp-tools.inc"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>

#define FRAME_LIMIT (NNH_MAX_REQUEST_BYTES + 8192)
static char *take(mj_Buf *b)
{
    if (!b->ok) { mj_free(b); return NULL; }
    return mj_take(b);
}

static mj_val field(const char *s, const char *key)
{
    mj_val v = {NULL}; if (s) mj_find(s,key,&v); return v;
}
static void raw(mj_Buf *b, mj_val v)
{
    size_t n; char *s;
    if (!v.p) { mj_nullv(b); return; }
    mj_raw(v,&n); s = strndup(v.p,n);
    if (!s) { b->ok = 0; return; }
    mj_rawv(b,s); free(s);
}
static char *failure(int code, const char *message)
{
    mj_Buf b; mj_init(&b); mj_obj(&b);
    mj_key(&b,"code"); mj_intv(&b,code);
    mj_key(&b,"message"); mj_strv(&b,message);
    mj_endobj(&b); return take(&b);
}
static int reply(mj_val id, const char *value, int error)
{
    mj_Buf b; char *s;
    if (!value) return 0;
    mj_init(&b); mj_obj(&b);
    mj_key(&b,"jsonrpc"); mj_strv(&b,"2.0");
    mj_key(&b,"id"); raw(&b,id);
    mj_key(&b,error ? "error" : "result"); mj_rawv(&b,value);
    mj_endobj(&b); s = take(&b);
    if (!s) return 0;
    int ok = puts(s) >= 0 && fflush(stdout) == 0;
    free(s); return ok;
}
static char *call(nnh_context *ctx, compact_state *compact, const char *params, int *error)
{
    mj_val name = field(params,"name"), args = field(params,"arguments");
    char *tool = name.p ? mj_str(name) : NULL, *method = NULL, *request, *projected, *result;
    mj_val item; mj_arr_it it = {NULL, 1}; mj_Buf b; nnh_result *response = NULL;
    mj_val list = field(mcp_tools,"tools");
    if (tool) while (mj_arr_next(list.p,&it,&item)) {
        char *candidate = mj_str(field(item.p,"name"));
        int match = candidate && !strcmp(candidate,tool); free(candidate);
        if (match) { method = strdup(tool); break; }
    }
    free(tool);
    if (!method || (args.p && *args.p != '{')) {
        free(method); *error = 1; return failure(-32602,"Unknown tool or invalid arguments");
    }
    char *separator = strchr(method,'_'); if (separator) *separator = '.';
    mj_init(&b); mj_obj(&b);
    mj_key(&b,"version"); mj_intv(&b,1);
    mj_key(&b,"method"); mj_strv(&b,method);
    mj_key(&b,"params"); if (args.p) raw(&b,args); else mj_rawv(&b,"{}");
    mj_endobj(&b); request = take(&b);
    if (!request) { free(method); return NULL; }
    nnh_status status = nnh_dispatch(ctx,request,strlen(request),&response); free(request);
    if (status != NNH_OK) { free(method); return NULL; } /* retire: receipt uncertain */
    projected = compact_project(compact,nnh_result_json(response),method); free(method);
    if (!projected) { nnh_result_free(response); return NULL; }
    mj_init(&b); mj_obj(&b);
    mj_key(&b,"isError"); mj_boolv(&b,nnh_result_error(response) != NULL);
    mj_key(&b,"structuredContent"); mj_rawv(&b,projected);
    mj_key(&b,"content"); mj_arr(&b); mj_endarr(&b);
    mj_endobj(&b); result = take(&b);
    free(projected); nnh_result_free(response); return result;
}
int main(int argc, char **argv)
{
    nnh_context *ctx = NULL; nnh_config config = {sizeof config,NULL,NULL,NULL};
    compact_state compact = {0};
    char line[FRAME_LIMIT + 1]; size_t used = 0; int c, oversized = 0, initialized = 0, ok = 1;
    if (argc == 2 && !strcmp(argv[1],"--version")) { puts(nnh_version()); return 0; }
    if (argc != 4) { fprintf(stderr,"usage: %s ENGINE DATA SESSIONS\n",argv[0]); return 2; }
    config.engine_path = argv[1]; config.data_path = argv[2]; config.sessions_path = argv[3];
    signal(SIGPIPE,SIG_IGN); /* executable only; library never installs handlers */
    if (nnh_context_open(&config,&ctx) != NNH_OK) { fprintf(stderr,"neonethack-mcp: context open failed\n"); return 1; }
    while (ok && (c = fgetc(stdin)) != EOF) {
        if (c != '\n') { if (used < FRAME_LIMIT) line[used++] = (char)c; else oversized = 1; continue; }
        line[used] = 0;
        mj_val id = {NULL}; char *value = NULL, *method = NULL, *version = NULL, *canonical = NULL; int error = 0;
        if (oversized || memchr(line,0,used) || !mj_valid(line)) {
            error = 1; value = failure(-32700,"Invalid JSON or frame exceeds limit");
        } else if (!(canonical = mj_canonical((mj_val){line}))) {
            error = 1; value = failure(-32600,"Duplicate keys or unsupported JSON structure");
        } else {
            id = field(canonical,"id");
            mj_val m = field(canonical,"method"), v = field(canonical,"jsonrpc"), params = field(canonical,"params");
            method = m.p ? mj_str(m) : NULL; version = v.p ? mj_str(v) : NULL;
            if (!version || strcmp(version,"2.0") || !method ||
                (id.p && *id.p != '"' && *id.p != '-' && (*id.p < '0' || *id.p > '9')) ||
                (params.p && *params.p != '{')) {
                id.p = NULL; error = 1; value = failure(-32600,"Invalid JSON-RPC request");
            } else if (!id.p) {
                /* Notifications never execute tools and never receive replies. */
            } else if (!strcmp(method,"initialize")) {
                mj_val pv = field(params.p,"protocolVersion"); char *protocol = pv.p ? mj_str(pv) : NULL;
                if (!protocol || !field(params.p,"clientInfo").p || !field(params.p,"capabilities").p) {
                    error = 1; value = failure(-32602,"Missing initialization parameters");
                } else {
                    const char *negotiated = !strcmp(protocol,"2024-11-05") || !strcmp(protocol,"2025-03-26") || !strcmp(protocol,"2025-06-18") ? protocol : "2025-11-25";
                    mj_Buf b; mj_init(&b); mj_obj(&b);
                    mj_key(&b,"protocolVersion"); mj_strv(&b,negotiated);
                    mj_key(&b,"capabilities"); mj_rawv(&b,"{\"tools\":{}}");
                    mj_key(&b,"serverInfo"); mj_rawv(&b,"{\"name\":\"neonethack\",\"version\":\"1.0.0-alpha.1\"}");
                    mj_key(&b,"instructions"); mj_strv(&b,"Create or resume a session. Use named tools and answer standing decisions explicitly; never auto-confirm warnings. Keep requestId and payload unchanged on uncertain retries. Structured results only: snapshot replaces observation; delta replaces supplied fields and upserts world cells by x,y. update.remove deletes fields; update.worldRemoved deletes coordinates. Apply only if update.base equals last update.id; otherwise session_observe resynchronizes. session_actions supplies detailed action offers. Cached receipts may have older revisions.");
                    mj_endobj(&b); value = take(&b); initialized = 1;
                }
                free(protocol);
            } else if (!strcmp(method,"ping")) value = strdup("{}");
            else if (!initialized) { error = 1; value = failure(-32000,"Initialize first"); }
            else if (!strcmp(method,"tools/list")) value = strdup(mcp_tools);
            else if (!strcmp(method,"tools/call")) value = call(ctx,&compact,params.p,&error);
            else { error = 1; value = failure(-32601,"Method not found"); }
        }
        if (id.p || error) ok = reply(id,value,error);
        free(value); free(method); free(version); free(canonical); used = 0; oversized = 0;
    }
    if (used || oversized) { char *value = failure(-32700,"Request must end with LF"); reply((mj_val){NULL},value,1); free(value); }
    free(compact.previous); nnh_context_close(ctx);
    if (!ok) fprintf(stderr,"neonethack-mcp: transport retired; execution may be uncertain, retain exact requestId and payload\n");
    return !ok || ferror(stdin) ? 1 : 0;
}
