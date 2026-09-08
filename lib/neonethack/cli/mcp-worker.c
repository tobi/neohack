#define _GNU_SOURCE
#include "mcp.h"
#include "mcp-agent.h"
#include <fcntl.h>
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
    long long revision;
    int checkpointed;
    mcp_job *head, *tail;
};
static int failed_result(const char *json)
{
    mj_val error = mcp_field(json,"error"); return error.p && !mj_is_null(error);
}
static mcp_recovery *recovery(mcp_server *s, const char *session)
{
    for (mcp_recovery *r = s->recoveries; session && r; r = r->next)
        if (!strcmp(r->session,session)) return r;
    return NULL;
}
static void forget_recovery(mcp_server *s, const char *session)
{
    mcp_recovery **link = &s->recoveries;
    while (*link) {
        mcp_recovery *r = *link;
        if (session && !strcmp(r->session,session)) {
            *link = r->next; free(r->request); free(r->session); free(r); return;
        }
        link = &r->next;
    }
}
static void agent_failure(mcp_job *j, const char *code, const char *message, const char *request)
{
    char *body = mcp_agent_error(code,message);
    mj_Buf b; mj_init(&b); mj_obj(&b);
    mj_key(&b,"isError"); mj_boolv(&b,1);
    mj_key(&b,"structuredContent"); mj_obj(&b);
    mj_key(&b,"version"); mj_intv(&b,1);
    mj_key(&b,"summary"); mj_strv(&b,message);
    mj_key(&b,"error"); mcp_raw(&b,mcp_field(body,"error"));
    if (request) { mj_key(&b,"operationId"); mcp_raw(&b,mcp_field(mcp_field(request,"params").p,"requestId")); }
    mj_endobj(&b); mj_key(&b,"content"); mj_arr(&b); mj_endarr(&b); mj_endobj(&b);
    free(body); mcp_finish(j,mcp_take(&b),0,200);
}
/* A worker may submit input only after the supervisor owns an exact copy.
 * The acknowledgement is IPC, never part of the public semantic protocol. */
static int reserve_input(const char *request, void *unused)
{
    (void)unused;
    if (printf("{\"mcpPending\":%s}\n",request) < 0 || fflush(stdout)) _exit(1);
    char *ack = NULL; size_t size = 0;
    ssize_t n = getline(&ack,&size,stdin);
    int accepted = n == 9 && !memcmp(ack,"accepted\n",9); free(ack);
    if (!accepted) _exit(1);
    return 1;
}
int mcp_worker_main(const nnh_config *config)
{
    nnh_context *ctx = NULL; char *line = NULL; size_t cap = 0; ssize_t length;
    int loaded = 0, ok = 1; mcp_agent_state state = {0};
    state.reserve = reserve_input;
    if (nnh_context_open(config,&ctx) != NNH_OK) return 1;
    while ((length = getline(&line,&cap,stdin)) >= 0) {
        if (length && line[length-1] == '\n') line[--length] = 0;
        char *response = NULL;
        char *method = mcp_string(mcp_field(line,"method"));
        {
            mj_val retained = mcp_field(line,"retainedRequest");
            if (retained.p) {
                char *copy = mj_canonical(retained);
                if (!copy) { free(method); ok = 0; break; }
                free(state.pending); state.pending = copy;
            }
            long long seen = -1; mj_val v = mcp_field(line,"agentRevision"); if (v.p) mj_int(v,&seen);
            char *operation = mcp_string(mcp_field(line,"operationId"));
            response = method ? mcp_agent_execute(ctx,&state,method,mcp_field(line,"params"),seen,operation) : NULL;
            free(operation);
        }
        if (!response) { free(method); ok = 0; break; }
        int opening = method && (!strcmp(method,"session.create") || !strcmp(method,"session.resume"));
        int closing = method && !strcmp(method,"session.close") && !failed_result(response);
        if (opening && !failed_result(response)) loaded = 1;
        int retire = closing || (opening && !loaded);
        /* Release leases before acknowledging close or a failed cold open. */
        if (retire) { nnh_context_close(ctx); ctx = NULL; }
        if (puts(response) < 0 || fflush(stdout)) ok = 0;
        free(method); free(response);
        if (!ok || retire) break;
    }
    mcp_agent_clear(&state); free(line); if (ctx) nnh_context_close(ctx);
    return ok ? 0 : 1;
}
static void retire(mcp_worker *, int);
static void start_next(mcp_worker *w)
{
    if (!w->head) { bufferevent_set_timeouts(w->io,NULL,NULL); return; }
    w->checkpointed = 0;
    struct timeval deadline = {150,0};
    bufferevent_set_timeouts(w->io,&deadline,&deadline);
    /* Recovery is supervisor state, unlike the agent's captured revision.
     * Resolve it when dispatching so a queued read cannot resurrect a request
     * which an earlier retry just resolved. */
    mj_Buf b; mj_init(&b); mj_obj(&b);
    const char *keys[] = {"method","params","agentRevision","operationId"};
    for (size_t i = 0; i < sizeof keys/sizeof *keys; i++) {
        mj_key(&b,keys[i]); mcp_raw(&b,mcp_field(w->head->semantic,keys[i]));
    }
    mcp_recovery *r = recovery(w->server,w->session);
    if (r && r->unresolved) { mj_key(&b,"retainedRequest"); mj_rawv(&b,r->request); }
    mj_endobj(&b); char *request = mcp_take(&b);
    if (!request) { retire(w,1); return; }
    bufferevent_write(w->io,request,strlen(request)); free(request);
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
    mcp_recovery *retained = recovery(s,w->session);
    if (uncertain && retained) retained->unresolved = 1;
    free(w->session); w->session = NULL;
    w->next = s->retired; s->retired = w;
    while (jobs) {
        mcp_job *next = jobs->next; jobs->next = NULL;
        if (uncertain) agent_failure(jobs,"uncertainExecution",retained ? "Worker failed. Resume this run, then retry the retained exact operation. Do not submit new input." : "Worker failed; no input checkpoint was retained. Creation may already exist: recover its run token before creating again.",retained ? retained->request : NULL);
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
    if (!w->head || !mj_valid(line) || memchr(line,0,n)) { free(line); retire(w,1); return; }
    mj_val checkpoint = mcp_field(line,"mcpPending");
    if (checkpoint.p) {
        char *request = mj_canonical(checkpoint);
        char *sid = mcp_string(mcp_field(mcp_field(checkpoint.p,"params").p,"sessionId"));
        if (!request || !sid || !w->session || strcmp(sid,w->session) || evbuffer_get_length(input)) {
            free(request); free(sid); free(line); retire(w,1); return;
        }
        mcp_recovery *r = recovery(w->server,sid);
        if (!r) {
            r = calloc(1,sizeof *r);
            if (!r) { free(request); free(sid); free(line); retire(w,1); return; }
            r->session = sid; sid = NULL; r->next = w->server->recoveries; w->server->recoveries = r;
        }
        free(sid); free(r->request); r->request = request;
        w->checkpointed = 1;
        bufferevent_write(w->io,"accepted\n",9); free(line); return;
    }
    if (evbuffer_get_length(input)) { free(line); retire(w,1); return; }
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
    if (w->checkpointed) {
        if (!mcp_agent_uncertain(line)) forget_recovery(w->server,w->session);
        else { mcp_recovery *r = recovery(w->server,w->session); if (r) r->unresolved = 1; }
    }
    if (strcmp(j->method,"agent.receipt") && !mcp_field(line,"historical").p && mcp_field(line,"observation").p)
        mj_int(mcp_field(line,"revision"),&w->revision);
    char *projected = mcp_agent_present_mode(line,!strcmp(j->method,"agent.receipt"),strcmp(j->method,"session.observe") && strcmp(j->method,"agent.receipt") && strcmp(j->method,"agent.retry") && !mcp_field(line,"historical").p);
    free(line);
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
    w->server = s; w->pid = pid; w->revision = -1; w->session = session; w->control = control;
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
    mcp_recovery *retained = recovery(s,session);
    if (retained && !retained->unresolved) retained = NULL;
    if (retained && !resume && strcmp(j->method,"session.observe") && strcmp(j->method,"agent.receipt") && strcmp(j->method,"agent.retry")) {
        agent_failure(j,"uncertainExecution","Resolve the retained exact operation before submitting new input.",retained->request); free(session); return;
    }
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
    {
        /* Capture the last returned frame now, before queueing, never at start_next. */
        unsigned char entropy[16]; size_t have = 0; int fd = open("/dev/urandom",O_RDONLY|O_CLOEXEC);
        while (fd >= 0 && have < sizeof entropy) {
            ssize_t got = read(fd,entropy+have,sizeof entropy-have);
            if (got < 0 && errno == EINTR) continue;
            if (got <= 0) break;
            have += (size_t)got;
        }
        if (fd >= 0) close(fd);
        if (have != sizeof entropy) { mcp_reject(j,500,-32603,"Cannot mint operation ID; no input submitted"); return; }
        char operation[36] = "op-";
        for (size_t i = 0; i < sizeof entropy; i++) snprintf(operation+3+i*2,3,"%02x",entropy[i]);
        mj_Buf b; mj_init(&b); mj_obj(&b);
        mj_key(&b,"method"); mj_strv(&b,j->method);
        mj_key(&b,"params"); mcp_raw(&b,params);
        mj_key(&b,"agentRevision"); mj_intv(&b,w->revision);
        mj_key(&b,"operationId"); mj_strv(&b,operation);
        mj_endobj(&b);
        char *request = mcp_take(&b);
        if (!request) { mcp_finish(j,NULL,1,500); return; }
        free(j->semantic); j->semantic = request;
    }
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
    while (s->recoveries) forget_recovery(s,s->recoveries->session);
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
