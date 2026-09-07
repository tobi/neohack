#ifndef NNH_MCP_H
#define NNH_MCP_H
#include "neonethack.h"
#include "minjson.h"
#include <event2/event.h>
#include <event2/buffer.h>
#include <event2/bufferevent.h>
#include <event2/http.h>
#include <sys/types.h>

#define MCP_FRAME_LIMIT (NNH_MAX_REQUEST_BYTES + 8192)
#define MCP_RESPONSE_LIMIT (8 * 1024 * 1024)
#define MCP_HTTP_VERSION "2026-07-28"
typedef struct mcp_server mcp_server;
typedef struct mcp_worker mcp_worker;
typedef struct mcp_recovery {
    struct mcp_recovery *next;
    char *session, *request;
    int unresolved;
} mcp_recovery;
typedef struct mcp_job {
    struct mcp_job *next;
    mcp_server *server;
    struct evhttp_request *http;
    char *frame, *semantic, *method;
} mcp_job;
struct mcp_server {
    nnh_config config;
    const char *self;
    struct event_base *base;
    struct evhttp *http;
    struct evhttp_bound_socket *listener;
    struct event *input_event, *output_event;
    struct evbuffer *input, *output;
    mcp_worker *workers, *retired;
    mcp_recovery *recoveries;
    int port, initialized, stopping, failed, oversized;
    size_t pending;
};
extern const char *mcp_tools_json, *mcp_guidance;
mj_val mcp_field(const char *, const char *);
char *mcp_string(mj_val);
void mcp_raw(mj_Buf *, mj_val);
char *mcp_take(mj_Buf *);
char *mcp_failure(int, const char *);
void mcp_finish(mcp_job *, char *, int, int);
void mcp_reject(mcp_job *, int, int, const char *);
void mcp_request(mcp_server *, const char *, size_t, struct evhttp_request *);
void mcp_route(mcp_job *);
void mcp_workers_close(mcp_server *);
void mcp_reap(mcp_server *);
int mcp_worker_main(const nnh_config *);
int mcp_http_start(mcp_server *);
int mcp_http_validate(mcp_job *);
void mcp_maybe_stop(mcp_server *);
#endif
