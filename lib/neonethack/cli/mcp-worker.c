#define _GNU_SOURCE
#include "mcp.h"
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif

struct mcp_worker {
    mcp_worker *next;
    mcp_server *server;
    struct bufferevent *io;
    pid_t pid;
    char *session;
    int loaded, control;
    mcp_job *head, *tail;
};
static int failed_result(const char *json)
{
    mj_val error = mcp_field(json,"error"); return error.p && !mj_is_null(error);
}
int mcp_worker_main(const nnh_config *config)
{
    nnh_context *ctx = NULL; char *line = NULL; size_t cap = 0; ssize_t length;
    int loaded = 0, ok = 1;
    if (nnh_context_open(config,&ctx) != NNH_OK) return 1;
    while ((length = getline(&line,&cap,stdin)) >= 0) {
        if (length && line[length-1] == '\n') line[--length] = 0;
        nnh_result *result = NULL;
        if (nnh_dispatch(ctx,line,(size_t)length,&result) != NNH_OK) { ok = 0; break; }
        char *method = mcp_string(mcp_field(line,"method"));
        int opening = method && (!strcmp(method,"session.create") || !strcmp(method,"session.resume"));
        int closing = method && !strcmp(method,"session.close") && !nnh_result_error(result);
        if (opening && !nnh_result_error(result)) loaded = 1;
        int retire = closing || (opening && !loaded);
        /* Release leases before acknowledging close or a failed cold open. */
        if (retire) { nnh_context_close(ctx); ctx = NULL; }
        if (puts(nnh_result_json(result)) < 0 || fflush(stdout)) ok = 0;
        free(method); nnh_result_free(result);
        if (!ok || retire) break;
    }
    free(line); if (ctx) nnh_context_close(ctx);
    return ok ? 0 : 1;
}
static void start_next(mcp_worker *w)
{
    if (!w->head) { bufferevent_set_timeouts(w->io,NULL,NULL); return; }
    struct timeval deadline = {150,0};
    bufferevent_set_timeouts(w->io,&deadline,&deadline);
    bufferevent_write(w->io,w->head->semantic,strlen(w->head->semantic));
    bufferevent_write(w->io,"\n",1);
}
static void retire(mcp_worker *w, int uncertain)
{
    mcp_server *s = w->server;
    mcp_worker **link = &s->workers;
    while (*link && *link != w) link = &(*link)->next;
    if (*link) *link = w->next;
    if (uncertain) kill(-w->pid,SIGKILL); /* retire its engine too; no orphan lease */
    bufferevent_free(w->io);
    mcp_job *jobs = w->head;
    free(w->session); w->session = NULL;
    w->next = s->retired; s->retired = w;
    while (jobs) {
        mcp_job *next = jobs->next; jobs->next = NULL;
        if (uncertain) mcp_finish(jobs,strdup("{\"isError\":true,\"content\":[{\"type\":\"text\",\"text\":\"Game process failed; execution may be uncertain. Explicitly resume and retry only the same requestId and payload. Creation has no retry ID.\"}]}"),0,200);
        else mcp_route(jobs);
        jobs = next;
    }
    mcp_reap(s);
}
static void worker_event(struct bufferevent *io, short flags, void *arg)
{
    (void)io;
    if (flags & (BEV_EVENT_EOF|BEV_EVENT_ERROR|BEV_EVENT_TIMEOUT)) retire(arg,1);
}
static void worker_read(struct bufferevent *io, void *arg)
{
    mcp_worker *w = arg; struct evbuffer *input = bufferevent_get_input(io); size_t n;
    if (evbuffer_get_length(input) > MCP_RESPONSE_LIMIT) { retire(w,1); return; }
    char *line = evbuffer_readln(input,&n,EVBUFFER_EOL_LF);
    if (!line) return;
    if (!w->head || !mj_valid(line) || memchr(line,0,n) || evbuffer_get_length(input)) { free(line); retire(w,1); return; }
    mcp_job *j = w->head; w->head = j->next; j->next = NULL;
    if (!w->head) w->tail = NULL;
    int failed = failed_result(line);
    int opening = !strcmp(j->method,"session.create") || !strcmp(j->method,"session.resume");
    int closing = !strcmp(j->method,"session.close") && !failed;
    if (opening && !failed) {
        char *session = mcp_string(mcp_field(line,"sessionId"));
        if (!session) { free(line); j->next = w->head; w->head = j; retire(w,1); return; }
        free(w->session); w->session = session; w->loaded = 1;
    }
    compact_state snapshot = {0};
    char *projected = compact_project(j->http ? &snapshot : &j->server->compact,line,j->method);
    free(snapshot.previous); free(line);
    mj_Buf b; mj_init(&b); mj_obj(&b);
    mj_key(&b,"isError"); mj_boolv(&b,failed);
    mj_key(&b,"structuredContent"); if (projected) mj_rawv(&b,projected); else b.ok = 0;
    mj_key(&b,"content"); mj_arr(&b); mj_endarr(&b); mj_endobj(&b); free(projected);
    mcp_finish(j,mcp_take(&b),0,200);
    if (closing || (opening && !w->loaded)) { retire(w,0); return; }
    start_next(w);
}
static mcp_worker *new_worker(mcp_server *s, char *session, int control)
{
    int pair[2];
    if (socketpair(AF_UNIX,SOCK_STREAM,0,pair)) { free(session); return NULL; }
    evutil_make_socket_closeonexec(pair[0]); evutil_make_socket_closeonexec(pair[1]);
    long descriptor_limit = sysconf(_SC_OPEN_MAX);
    pid_t pid = fork();
    if (!pid) {
        setpgid(0,0);
        if (dup2(pair[1],STDIN_FILENO) < 0 || dup2(pair[1],STDOUT_FILENO) < 0) _exit(127);
        /* No inherited listeners, sibling IPC or unrelated descriptors. The
         * worker execs fresh before opening any library context or engine. */
#ifdef __linux__
        if (syscall(SYS_close_range,3,~0U,0) < 0)
#endif
            for (long fd = 3; fd < descriptor_limit; fd++) close((int)fd);
        execl(s->self,s->self,"--worker",s->config.engine_path,s->config.data_path,s->config.sessions_path,(char *)NULL);
        _exit(127);
    }
    close(pair[1]);
    if (pid < 0) { close(pair[0]); free(session); return NULL; }
    setpgid(pid,pid);
    mcp_worker *w = calloc(1,sizeof *w);
    if (!w) { kill(-pid,SIGKILL); close(pair[0]); free(session); return NULL; }
    w->server = s; w->pid = pid; w->session = session; w->control = control;
    w->io = bufferevent_socket_new(s->base,pair[0],BEV_OPT_CLOSE_ON_FREE|BEV_OPT_DEFER_CALLBACKS);
    if (!w->io) { kill(-pid,SIGKILL); close(pair[0]); free(session); free(w); return NULL; }
    bufferevent_setcb(w->io,worker_read,NULL,worker_event,w);
    bufferevent_setwatermark(w->io,EV_READ,0,MCP_RESPONSE_LIMIT+1);
    bufferevent_enable(w->io,EV_READ|EV_WRITE);
    w->next = s->workers; s->workers = w;
    return w;
}
void mcp_route(mcp_job *j)
{
    mcp_server *s = j->server; mcp_worker *w = NULL;
    mj_val params = mcp_field(j->semantic,"params");
    char *session = mcp_string(mcp_field(params.p,"sessionId"));
    int create = !strcmp(j->method,"session.create"), resume = !strcmp(j->method,"session.resume");
    mcp_reap(s);
    if (!create && session) for (w = s->workers; w; w = w->next)
        if (!w->control && w->session && !strcmp(w->session,session)) break;
    if (!w) {
        if (create || resume) { w = new_worker(s,resume ? session : NULL,0); if (resume) session = NULL; }
        else {
            for (w = s->workers; w && !w->control; w = w->next) {}
            if (!w) w = new_worker(s,NULL,1);
        }
    }
    free(session);
    if (!w) { mcp_reject(j,500,-32603,"Cannot start game process; request was not dispatched"); return; }
    if (w->tail) w->tail->next = j;
    else w->head = j;
    w->tail = j;
    if (w->head == j) start_next(w);
}
void mcp_workers_close(mcp_server *s)
{
    while (s->workers) {
        mcp_worker *w = s->workers; s->workers = w->next;
        /* All accepted jobs have completed. EOF closes idle contexts and leases. */
        shutdown(bufferevent_getfd(w->io),SHUT_RDWR);
        bufferevent_free(w->io); free(w->session);
        w->next = s->retired; s->retired = w;
    }
    while (s->retired) {
        mcp_worker *w = s->retired; s->retired = w->next;
        while (waitpid(w->pid,NULL,0) < 0 && errno == EINTR) {}
        free(w);
    }
}
void mcp_reap(mcp_server *s)
{
    /* Keep live worker PIDs reserved until their IPC close callback retires
     * their process group. Never reap unrelated or still-routable children. */
    mcp_worker **link = &s->retired;
    while (*link) {
        mcp_worker *w = *link;
        pid_t reaped = waitpid(w->pid,NULL,WNOHANG);
        if (reaped == w->pid || (reaped < 0 && errno == ECHILD)) { *link = w->next; free(w); }
        else link = &w->next;
    }
}
