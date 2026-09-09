/* Native MCP transport. Only the public C driver owns gameplay semantics. */
#define _GNU_SOURCE
#include "mcp.h"
#include "mcp-agent.h"
#ifdef NNH_BUNDLE_MCP
#include "mcp-bundle.h"
#endif
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

const char *mcp_tools_json, *mcp_guidance;
void mcp_maybe_stop(mcp_server *s)
{
    if (s->stopping && !s->pending && !evbuffer_get_length(s->output)) {
        /* Let libevent flush completed HTTP replies before retiring sockets. */
        struct timeval grace = {0,100000};
        event_base_loopexit(s->base,&grace);
    }
}
void mcp_finish(mcp_job *j, char *value, int error, int status)
{
    mcp_server *s = j->server;
    mj_Buf b; mj_val id = mcp_field(j->frame,"id"); char *reply;
    if (!value) { error = 1; status = 500; value = mcp_failure(-32603,"Transport failed; execution may be uncertain. Retain exact requestId and payload."); }
    if (j->legacy_http && !error && value) {
        mj_val structured=mcp_field(value,"structuredContent"), content=mcp_field(value,"content");
        if (structured.p && content.p) {
            size_t length; mj_raw(content,&length);
            char *text=mj_canonical(structured), *replacement=NULL;
            mj_Buf rendered; mj_init(&rendered); mj_arr(&rendered); mj_obj(&rendered);
            mj_key(&rendered,"type"); mj_strv(&rendered,"text"); mj_key(&rendered,"text"); mj_strv(&rendered,text);
            mj_endobj(&rendered); mj_endarr(&rendered); char *array=mcp_take(&rendered);
            if (array && asprintf(&replacement,"%.*s%s%s",(int)(content.p-value),value,array,content.p+length)>=0) { free(value); value=replacement; }
            free(array); free(text);
        }
    }
    mj_init(&b); mj_obj(&b); mj_key(&b,"jsonrpc"); mj_strv(&b,"2.0");
    if (id.p || !j->http) { mj_key(&b,"id"); mcp_raw(&b,id); }
    mj_key(&b,error ? "error" : "result");
    if (j->http && !j->legacy_http && !error && value) {
        size_t n = strlen(value);
        char *members = n >= 2 ? strndup(value+1,n-2) : NULL;
        if (!members) b.ok = 0;
        else {
            char *modern;
            if (asprintf(&modern,"{\"resultType\":\"complete\",\"_meta\":{\"io.modelcontextprotocol/serverInfo\":{\"name\":\"neohack\",\"version\":\"%s\"}}%s%s}",nnh_version(), *members ? "," : "",members) < 0) b.ok = 0;
            else { mj_rawv(&b,modern); free(modern); }
            free(members);
        }
    } else if (value) mj_rawv(&b,value);
    else b.ok = 0;
    mj_endobj(&b); reply = mcp_take(&b);
    if (j->http) {
        if (evhttp_request_get_connection(j->http)) {
            struct evbuffer *out = evbuffer_new();
            struct evkeyvalq *headers = evhttp_request_get_output_headers(j->http);
            evhttp_add_header(headers,"Content-Type","application/json");
            evhttp_add_header(headers,"Cache-Control","no-store");
            /* Each request is independent; bounded connection lifetime also
             * makes disconnect/shutdown ownership unambiguous. */
            evhttp_add_header(headers,"Connection","close");
            if (out && reply && status != 202) evbuffer_add(out,reply,strlen(reply));
            evhttp_send_reply(j->http,reply ? status : 500,NULL,out);
            if (out) evbuffer_free(out);
        } else evhttp_request_free(j->http);
    } else if (reply) {
        evbuffer_add(s->output,reply,strlen(reply)); evbuffer_add(s->output,"\n",1);
        event_add(s->output_event,NULL);
    } else s->failed = 1;
    free(reply); free(value); free(j->frame); free(j->semantic); free(j->method); free(j);
    --s->pending; mcp_maybe_stop(s);
}
void mcp_reject(mcp_job *j, int status, int code, const char *message) { mcp_finish(j,mcp_failure(code,message),1,status); }

static void tool_request(mcp_job *j, const char *params)
{
    mj_val args = mcp_field(params,"arguments");
    char *tool = mcp_string(mcp_field(params,"name"));
    mj_val definition = mcp_agent_method(tool);
    if (mcp_agent_valid(definition,args)) j->method = mcp_string(mcp_field(definition.p,"method"));
    if (!j->method) {
        char *message=NULL;
        if(definition.p && tool) {
            if(asprintf(&message,"Invalid arguments for %s; no operation was sent. Call help with {name:\"%s\"} for the schema. Item actions take itemId; answer takes decisionId and value.",tool,tool)<0)message=NULL;
        }
        mcp_reject(j,400,-32602,message?message:"Unknown tool; no operation was sent. Call help with {} to list tool names.");
        free(message);free(tool);return;
    }
    free(tool);
    mj_Buf b; mj_init(&b); mj_obj(&b);
    mj_key(&b,"version"); mj_intv(&b,1);
    mj_key(&b,"method"); mj_strv(&b,j->method);
    mj_key(&b,"params"); if (args.p) mcp_raw(&b,args); else mj_rawv(&b,"{}");
    mj_endobj(&b); j->semantic = mcp_take(&b);
    if (!j->semantic) { mcp_finish(j,NULL,1,500); return; }
    mcp_route(j);
}
void mcp_request(mcp_server *s, const char *line, size_t length, struct evhttp_request *http)
{
    mcp_job *j = calloc(1,sizeof *j);
    if (!j) { s->failed = 1; return; }
    j->server = s; j->http = http; ++s->pending;
    if (http) evhttp_request_own(http);
    if (memchr(line,0,length) || !mj_valid(line)) { mcp_reject(j,400,-32700,"Invalid JSON"); return; }
    j->frame = mj_canonical((mj_val){line});
    if (!j->frame) { mcp_reject(j,400,-32600,"Duplicate keys or unsupported JSON structure"); return; }
    mj_val id = mcp_field(j->frame,"id"), params = mcp_field(j->frame,"params");
    char *method = mcp_string(mcp_field(j->frame,"method")), *version = mcp_string(mcp_field(j->frame,"jsonrpc"));
    long long number;
    int valid_id = !id.p || *id.p == '"' || (mj_int(id,&number) && number >= -9007199254740991LL && number <= 9007199254740991LL);
    if (!version || strcmp(version,"2.0") || !method || !valid_id ||
        mcp_field(j->frame,"result").p || mcp_field(j->frame,"error").p || (params.p && *params.p != '{')) {
        free(j->frame); j->frame = NULL; mcp_reject(j,400,-32600,"Invalid JSON-RPC request");
    } else if (!id.p) {
        if (http) {
            if (mcp_http_validate(j)) {
                if (j->legacy_http && !strcmp(method,"notifications/initialized")) mcp_finish(j,strdup("{}"),0,202);
                else mcp_reject(j,400,-32600,"Unsupported notification");
            }
        }
        else { free(j->frame); free(j); --s->pending; mcp_maybe_stop(s); }
    } else if (http && !mcp_http_validate(j)) {
        /* Validation owns the error response and job on failure. */
    } else if (!strcmp(method,"initialize") && (!http || j->legacy_http)) {
        char *protocol = mcp_string(mcp_field(params.p,"protocolVersion"));
        if (!protocol || !mcp_field(params.p,"clientInfo").p || !mcp_field(params.p,"capabilities").p) mcp_reject(j,400,-32602,"Missing initialization parameters");
        else {
            const char *negotiated = (!http && !strcmp(protocol,"2024-11-05")) || !strcmp(protocol,"2025-03-26") || !strcmp(protocol,"2025-06-18") ? protocol : "2025-11-25";
            mj_Buf b; mj_init(&b); mj_obj(&b);
            mj_key(&b,"protocolVersion"); mj_strv(&b,negotiated);
            mj_key(&b,"capabilities"); mj_rawv(&b,"{\"tools\":{}}");
            mj_key(&b,"serverInfo"); mj_rawv(&b,"{\"name\":\"neohack\",\"version\":\"1.0.0-alpha.1\"}");
            mj_key(&b,"instructions"); mj_strv(&b,mcp_guidance);
            mj_endobj(&b); s->initialized = 1; mcp_finish(j,mcp_take(&b),0,200);
        }
        free(protocol);
    } else if (!strcmp(method,"ping")) mcp_finish(j,strdup("{}"),0,200);
    else if (!http && !s->initialized) mcp_reject(j,400,-32000,"Initialize first");
    else if (!strcmp(method,"server/discover") && http) {
        mj_Buf b; mj_init(&b); mj_obj(&b);
        mj_key(&b,"supportedVersions"); mj_rawv(&b,"[\"" MCP_HTTP_VERSION "\"]");
        mj_key(&b,"capabilities"); mj_rawv(&b,"{\"tools\":{}}");
        mj_key(&b,"instructions"); mj_strv(&b,mcp_guidance);
        mj_endobj(&b); mcp_finish(j,mcp_take(&b),0,200);
    } else if (!strcmp(method,"tools/list")) mcp_finish(j,strdup(mcp_tools_json),0,200);
    else if (!strcmp(method,"tools/call")) tool_request(j,params.p);
    else mcp_reject(j,404,-32601,"Method not found; HTTP supports 2026-07-28 via server/discover");
    free(method); free(version);
}
static void stop(evutil_socket_t fd, short events, void *arg)
{
    mcp_server *s = arg; (void)fd; (void)events;
    if (!s->stopping) {
        s->stopping = 1;
        if (s->input_event) event_del(s->input_event);
        if (s->listener) { evhttp_del_accept_socket(s->http,s->listener); s->listener = NULL; }
    }
    mcp_maybe_stop(s);
}
static void child_exited(evutil_socket_t fd, short events, void *arg)
{
    (void)fd; (void)events; mcp_reap(arg);
}
static void output_ready(evutil_socket_t fd, short events, void *arg)
{
    mcp_server *s = arg; (void)events;
    if (evbuffer_write(s->output,fd) < 0 && errno != EAGAIN && errno != EINTR) {
        s->failed = 1; evbuffer_drain(s->output,evbuffer_get_length(s->output)); stop(0,0,s);
    }
    if (!evbuffer_get_length(s->output)) { event_del(s->output_event); mcp_maybe_stop(s); }
}
static void input_ready(evutil_socket_t fd, short events, void *arg)
{
    mcp_server *s = arg; (void)events;
    int got = evbuffer_read(s->input,fd,4096); size_t n; char *line;
    if (got <= 0) {
        if (got < 0 && (errno == EAGAIN || errno == EINTR)) return;
        if (evbuffer_get_length(s->input) || s->oversized) mcp_request(s,"",0,NULL);
        stop(0,0,s); return;
    }
    while ((line = evbuffer_readln(s->input,&n,EVBUFFER_EOL_LF))) {
        if (s->oversized || n > MCP_FRAME_LIMIT) mcp_request(s,"",0,NULL);
        else mcp_request(s,line,n,NULL);
        free(line); s->oversized = 0;
    }
    if (evbuffer_get_length(s->input) > MCP_FRAME_LIMIT) { evbuffer_drain(s->input,evbuffer_get_length(s->input)); s->oversized = 1; }
}
int main(int argc, char **argv)
{
    mcp_server s = {0}; char self[PATH_MAX], *paths[3]; int count = 0, worker = 0;
    s.config.size = sizeof s.config;
    if (argc == 2 && !strcmp(argv[1],"--version")) { puts(nnh_version()); return 0; }
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i],"--worker") && i == 1) worker = 1;
        else if (!strcmp(argv[i],"--http") && !s.port && i+1 < argc) {
            char *end; long port = strtol(argv[++i],&end,10);
            if (!*argv[i] || *end || port < 1 || port > 65535) goto usage;
            s.port = (int)port;
        } else if (argv[i][0] == '-' || count == 3) goto usage;
        else paths[count++] = argv[i];
    }
#ifdef NNH_BUNDLE_MCP
    if (!worker && count <= 1) {
        char *sessions = count ? paths[0] : NULL;
        if (mcp_bundle_paths(&paths[0],&paths[1],&sessions)) return 1;
        paths[2] = sessions; count = 3;
    }
#endif
    if (count != 3 || (worker && s.port)) goto usage;
    s.config.engine_path = paths[0]; s.config.data_path = paths[1]; s.config.sessions_path = paths[2];
    signal(SIGPIPE,SIG_IGN); /* Executable only; never installed by the C library. */
    mcp_tools_json = mcp_agent_tools; mcp_guidance = mcp_agent_instructions;
    if (worker) return mcp_worker_main(&s.config);
    ssize_t self_length = readlink("/proc/self/exe",self,sizeof self-1);
    if (self_length >= 0) snprintf(self,sizeof self,"/proc/self/exe");
    else if (!realpath(argv[0],self)) { perror("MCP executable path"); return 1; }
    s.self = self;
    /* Validate runtime paths before accepting work, without opening a game. */
    nnh_context *probe = NULL;
    if (nnh_context_open(&s.config,&probe) != NNH_OK) { fprintf(stderr,"neonethack-mcp: context open failed\n"); return 1; }
    nnh_context_close(probe);
    struct event_config *ec = event_config_new();
    /* poll supports redirected regular-file stdin as well as pipes/sockets. */
    event_config_avoid_method(ec,"epoll"); s.base = event_base_new_with_config(ec); event_config_free(ec);
    s.input = evbuffer_new(); s.output = evbuffer_new();
    if (!s.base || !s.input || !s.output) return 1;
    struct event *sigint = evsignal_new(s.base,SIGINT,stop,&s), *sigterm = evsignal_new(s.base,SIGTERM,stop,&s);
    struct event *sigchild = evsignal_new(s.base,SIGCHLD,child_exited,&s);
    event_add(sigint,NULL); event_add(sigterm,NULL); event_add(sigchild,NULL);
    if (s.port) { if (mcp_http_start(&s)) return 1; }
    else {
        evutil_make_socket_nonblocking(STDIN_FILENO); evutil_make_socket_nonblocking(STDOUT_FILENO);
        s.input_event = event_new(s.base,STDIN_FILENO,EV_READ|EV_PERSIST,input_ready,&s);
        s.output_event = event_new(s.base,STDOUT_FILENO,EV_WRITE|EV_PERSIST,output_ready,&s);
        event_add(s.input_event,NULL);
    }
    event_base_dispatch(s.base);
    mcp_workers_close(&s);
    if (s.http) evhttp_free(s.http);
    if (s.input_event) event_free(s.input_event);
    if (s.output_event) event_free(s.output_event);
    event_free(sigint); event_free(sigterm); event_free(sigchild); evbuffer_free(s.input); evbuffer_free(s.output);
    event_base_free(s.base);
    return s.failed;
usage:
#ifdef NNH_BUNDLE_MCP
    fprintf(stderr,"usage: %s [--http PORT] [SESSIONS]\nBundled engine and data; sessions default to $XDG_STATE_HOME/neohack/sessions\n(or ~/.local/state/neohack/sessions). Runtime cache: $XDG_CACHE_HOME/neohack/runtimes\n(or ~/.cache/neohack/runtimes). Custom runtime: ENGINE DATA SESSIONS.\n",argv[0]);
#else
    fprintf(stderr,"usage: %s [--http PORT] ENGINE DATA SESSIONS\nNative C MCP: default stdio; HTTP " MCP_HTTP_VERSION " at 127.0.0.1:PORT/mcp.\n",argv[0]);
#endif
    return argc == 2 && (!strcmp(argv[1],"--help") || !strcmp(argv[1],"-h")) ? 0 : 2;
}
