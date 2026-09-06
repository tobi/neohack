#define _GNU_SOURCE
#include "mcp.h"
#include <event2/keyvalq_struct.h>
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

static const char *header(struct evhttp_request *req, const char *name)
{
    struct evkeyvalq *headers = evhttp_request_get_input_headers(req);
    struct evkeyval *entry; const char *value = NULL;
    for (entry = headers->tqh_first; entry; entry = entry->next.tqe_next) if (!strcasecmp(entry->key,name)) {
        if (value) return NULL; /* Do not accept ambiguous duplicate routing headers. */
        value = entry->value;
    }
    return value;
}
static int media_type(const char *value, const char *wanted)
{
    if (!value) return 0;
    char *copy = strdup(value), *save = NULL, *part; int found = 0;
    if (!copy) return 0;
    for (part = strtok_r(copy,",",&save); part; part = strtok_r(NULL,",",&save)) {
        while (isspace((unsigned char)*part)) part++;
        char *parameters = strchr(part,';'); if (parameters) *parameters++ = 0;
        char *end = part+strlen(part); while (end > part && isspace((unsigned char)end[-1])) *--end = 0;
        int acceptable = 1;
        if (parameters) {
            char *param_save, *param;
            for (param = strtok_r(parameters,";",&param_save); param; param = strtok_r(NULL,";",&param_save)) {
                while (isspace((unsigned char)*param)) param++;
                if (!strncasecmp(param,"q=",2) && strtod(param+2,NULL) <= 0) acceptable = 0;
            }
        }
        if (acceptable && !strcasecmp(part,wanted)) found = 1;
    }
    free(copy); return found;
}
static char *decode_name(const char *value)
{
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if (!value) return NULL;
    size_t n = strlen(value);
    if (n < 11 || strncmp(value,"=?base64?",9) || strcmp(value+n-2,"?=")) return strdup(value);
    size_t len = n-11, out = 0; const char *encoded = value+9;
    if (len % 4) return NULL;
    char *decoded = malloc(len/4*3+1); if (!decoded) return NULL;
    for (size_t i = 0; i < len; i += 4) {
        unsigned bits = 0; int padding = 0;
        for (size_t k = 0; k < 4; k++) {
            const char *p = strchr(alphabet,encoded[i+k]);
            if (encoded[i+k] == '=') { if (k < 2 || i+4 != len) goto invalid; ++padding; bits <<= 6; }
            else { if (!p || padding) goto invalid; bits = (bits << 6) | (unsigned)(p-alphabet); }
        }
        if (padding > 2 || (padding == 2 && (bits & 0xffff)) || (padding == 1 && (bits & 0xff))) goto invalid;
        decoded[out++] = (char)(bits >> 16);
        if (padding < 2) decoded[out++] = (char)(bits >> 8);
        if (!padding) decoded[out++] = (char)bits;
    }
    if (memchr(decoded,0,out)) goto invalid;
    decoded[out] = 0; return decoded;
invalid:
    free(decoded); return NULL;
}
int mcp_http_validate(mcp_job *j)
{
    const char *version = header(j->http,"MCP-Protocol-Version"), *method_header = header(j->http,"Mcp-Method");
    mj_val params = mcp_field(j->frame,"params"), meta = mcp_field(params.p,"_meta");
    char *method = mcp_string(mcp_field(j->frame,"method"));
    char *body_version = mcp_string(mcp_field(meta.p,"io.modelcontextprotocol/protocolVersion"));
    mj_val capabilities = mcp_field(meta.p,"io.modelcontextprotocol/clientCapabilities");
    int code = 0; const char *message = NULL;
    if (!version || !method_header || !method || strcmp(method_header,method)) {
        code = -32020; message = "Missing or mismatched MCP-Protocol-Version/Mcp-Method headers";
    } else if (!body_version || !capabilities.p || *capabilities.p != '{') {
        code = -32602; message = "Required protocolVersion and clientCapabilities metadata missing or malformed";
    } else if (strcmp(version,body_version)) { code = -32020; message = "MCP-Protocol-Version does not match request metadata"; }
    else if (!strcmp(method,"tools/call") || !strcmp(method,"prompts/get") || !strcmp(method,"resources/read")) {
        char *name = mcp_string(mcp_field(params.p,!strcmp(method,"resources/read") ? "uri" : "name"));
        char *from_header = decode_name(header(j->http,"Mcp-Name"));
        if (!name || !from_header || strcmp(name,from_header)) { code = -32020; message = "Missing or mismatched Mcp-Name header"; }
        free(name); free(from_header);
    }
    free(method); free(body_version);
    if (code) { mcp_reject(j,400,code,message); return 0; }
    if (strcmp(version,MCP_HTTP_VERSION)) {
        mj_Buf b; mj_init(&b); mj_obj(&b);
        mj_key(&b,"code"); mj_intv(&b,-32022);
        mj_key(&b,"message"); mj_strv(&b,"Unsupported protocol version");
        mj_key(&b,"data"); mj_obj(&b);
        mj_key(&b,"supported"); mj_rawv(&b,"[\"" MCP_HTTP_VERSION "\"]");
        mj_key(&b,"requested"); mj_strv(&b,version);
        mj_endobj(&b); mj_endobj(&b); mcp_finish(j,mcp_take(&b),1,400); return 0;
    }
    return 1;
}
static void early_error(mcp_server *s, struct evhttp_request *req, int status, const char *message)
{
    mcp_job *j = calloc(1,sizeof *j);
    if (!j) { evhttp_send_error(req,500,NULL); return; }
    j->server = s; j->http = req; ++s->pending; evhttp_request_own(req);
    mcp_reject(j,status,-32600,message);
}
static void http_request(struct evhttp_request *req, void *arg)
{
    mcp_server *s = arg;
    char host_ip[64], host_name[64], origin_ip[80], origin_name[80];
    snprintf(host_ip,sizeof host_ip,"127.0.0.1:%d",s->port);
    snprintf(host_name,sizeof host_name,"localhost:%d",s->port);
    snprintf(origin_ip,sizeof origin_ip,"http://%s",host_ip);
    snprintf(origin_name,sizeof origin_name,"http://%s",host_name);
    const char *host = header(req,"Host"), *origin = header(req,"Origin");
    /* An invalid or duplicated Origin must not become an absent Origin. */
    int origin_present = evhttp_find_header(evhttp_request_get_input_headers(req),"Origin") != NULL;
    if (!host || (strcmp(host,host_ip) && strcmp(host,host_name)) ||
        (origin_present && (!origin || (strcmp(origin,origin_ip) && strcmp(origin,origin_name))))) {
        early_error(s,req,403,"Forbidden Host or Origin"); return;
    }
    if (strcmp(evhttp_request_get_uri(req),"/mcp")) { early_error(s,req,404,"MCP endpoint is /mcp"); return; }
    if (evhttp_request_get_command(req) != EVHTTP_REQ_POST) {
        evhttp_add_header(evhttp_request_get_output_headers(req),"Allow","POST");
        early_error(s,req,405,"Use POST; HTTP " MCP_HTTP_VERSION " has no GET stream or connection sessions"); return;
    }
    if (!media_type(header(req,"Content-Type"),"application/json")) { early_error(s,req,415,"Content-Type must be application/json"); return; }
    const char *accept = header(req,"Accept");
    if (!media_type(accept,"application/json") || !media_type(accept,"text/event-stream")) {
        early_error(s,req,406,"Accept must include application/json and text/event-stream"); return;
    }
    struct evbuffer *input = evhttp_request_get_input_buffer(req);
    size_t length = evbuffer_get_length(input);
    if (length > 65536) { early_error(s,req,413,"Request exceeds 64 KiB"); return; }
    char *body = malloc(length+1);
    if (!body) { early_error(s,req,500,"Out of memory"); return; }
    evbuffer_copyout(input,body,length); body[length] = 0;
    mcp_request(s,body,length,req); free(body);
}
int mcp_http_start(mcp_server *s)
{
    s->http = evhttp_new(s->base);
    if (!s->http) return -1;
    evhttp_set_max_headers_size(s->http,16384);
    evhttp_set_max_body_size(s->http,65536);
    evhttp_set_timeout(s->http,180);
    evhttp_set_allowed_methods(s->http,EVHTTP_REQ_GET|EVHTTP_REQ_POST|EVHTTP_REQ_HEAD|EVHTTP_REQ_PUT|EVHTTP_REQ_DELETE|EVHTTP_REQ_OPTIONS|EVHTTP_REQ_TRACE|EVHTTP_REQ_CONNECT|EVHTTP_REQ_PATCH);
    evhttp_set_gencb(s->http,http_request,s);
    s->listener = evhttp_bind_socket_with_handle(s->http,"127.0.0.1",s->port);
    if (!s->listener) { perror("MCP HTTP listen"); return -1; }
    evutil_make_socket_closeonexec(evhttp_bound_socket_get_fd(s->listener));
    fprintf(stderr,"neonethack MCP listening at http://127.0.0.1:%d/mcp\n",s->port);
    return 0;
}
