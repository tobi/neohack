/* neonethack headless port: NDJSON JSON-RPC 2.0 transport (see rpc.h). */
#include "rpc.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
/* The wasm build bypasses FILE* entirely: engine->UI lines go straight
 * to the worker glue via __nhEmitLine (musl's fdopen-on-dup'd-fd does
 * not survive under emscripten, and UI->engine lines arrive through
 * __wrap_json_read_line in wasm/nh_wasm.c). */
EM_JS(void, nh_wasm_emit_line, (const char *line), {
    if (typeof globalThis.__nhEmitLine === "function")
        globalThis.__nhEmitLine(UTF8ToString(line));
});
#else
#include "cli.h"
#include "play.h"
#endif

const char *rpc_protocol_version = "0.1";

static FILE *rpc_out = NULL;
static FILE *rpc_in = NULL;
static long long rpc_next_id = 1;
static int rpc_ended = 0;

const char *
rpc_engine_version(void)
{
    /* version_string() lives in the core (src/version.c) and fills the
     * caller's buffer. */
    static char buf[256];
    extern char *version_string(char *, size_t);
    return version_string(buf, sizeof buf);
}

static int rpc_inited = 0;

void
rpc_init(void)
{
#ifdef __EMSCRIPTEN__
    /* No fd juggling: rpc_write emits straight to JS, while stray
     * fd-1/fd-2 output flows to Module.print/printErr as engine logs. */
    rpc_out = stdout;
    rpc_in = stdin;
#else
    int fd;
    if (rpc_inited)
        return;
    rpc_inited = 1;
    /* keep a private handle on the original stdout... */
    fd = dup(1);
    if (fd >= 0) {
        rpc_out = fdopen(fd, "w");
        /* ...and send all future fd-1 output (core printfs, Lua print,
         * panic fallbacks) to stderr instead. */
        dup2(2, 1);
    }
    if (!rpc_out)
        rpc_out = stderr;
    rpc_in = stdin;
#endif
}

static void
rpc_write(const char *line)
{
#ifdef __EMSCRIPTEN__
    nh_wasm_emit_line(line);
#else
    if (hl_cli.play) {
        /* --play: the in-process terminal driver renders instead. */
        hl_play_on_line(line);
        return;
    }
    if (hl_cli.pretty) {
        hl_cli_pretty(line, rpc_out ? rpc_out : stderr);
        return;
    }
    /* Defense in depth: config errors before rpc_init() must not crash
     * the transport; they fall back to stderr until init runs. */
    if (!rpc_out)
        rpc_out = stderr;
    fputs(line, rpc_out);
    fputc('\n', rpc_out);
    fflush(rpc_out);
#endif
}

void
rpc_notify(const char *method, const char *params_json)
{
    JBuf jb;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "jsonrpc");
    jb_str(&jb, "2.0");
    jb_key(&jb, "method");
    jb_str(&jb, method);
    if (params_json) {
        jb_sep(&jb);
        jb_raw(&jb, "\"params\":");
        jb_raw(&jb, params_json);
    }
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_write(jb.buf);
    jb_free(&jb);
}

static void
rpc_session_ended(const char *reason)
{
    JBuf jb;
    if (rpc_ended)
        return;
    rpc_ended = 1;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "reason");
    jb_str(&jb, reason);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("session_ended", jb.buf);
    jb_free(&jb);
}

char *
rpc_input(const char *kind, const char *params_json)
{
    JBuf jb;
    long long id = rpc_next_id++;
    char *line, *result = NULL;
    const char *p;
    int ok = 0;
    long long rid;

    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "jsonrpc");
    jb_str(&jb, "2.0");
    jb_key(&jb, "id");
    jb_int(&jb, id);
    jb_key(&jb, "method");
    jb_str(&jb, "input");
    jb_sep(&jb);
    jb_raw(&jb, "\"params\":{\"kind\":");
    {
        JBuf kb;
        jb_init(&kb);
        jb_str(&kb, kind);
        if (kb.ok)
            jb_raw(&jb, kb.buf);
        jb_free(&kb);
    }
    if (params_json) {
        /* merge caller params into the same object (params_json holds
         *     ,"name":value, ...  fragments, leading comma included) */
        jb_raw(&jb, params_json);
    }
    jb_end_obj(&jb); /* close params */
    jb_end_obj(&jb); /* close envelope */
    if (jb.ok)
        rpc_write(jb.buf);
    jb_free(&jb);


    /* json_read_line serves --play answers from the keyboard (and logs
     * them) via its own play branch; the request was already rendered
     * by hl_play_on_line above. */
    line = json_read_line(rpc_in);
    if (!line) {
        rpc_session_ended("eof");
        return NULL;
    }
    p = j_find_key(line, "id");
    rid = j_parse_int(p, &ok);
    if (!ok || rid != id) {
        free(line);
        rpc_session_ended("protocol");
        return NULL;
    }
    p = j_find_key(line, "error");
    if (p) {
        /* client cancelled this prompt: behave as an empty answer, NOT
         * as EOF (which would hangup the whole session). */
        free(line);
        result = malloc(3);
        if (result)
            strcpy(result, "{}");
        return result;
    }
    p = j_find_key(line, "result");
    if (p) {
        /* copy the result object text for the caller to parse */
        const char *start = p;
        const char *end = strrchr(line, '}');
        size_t n;
        if (*start != '{' || !end || end <= start) {
            free(line);
            return NULL;
        }
        n = (size_t) (end - start) + 1;
        result = malloc(n + 1);
        if (result) {
            memcpy(result, start, n);
            result[n] = '\0';
        }
    }
    free(line);
    return result;
}

long long
rpc_read_request(char **method_out, char **params_out)
{
    char *line = json_read_line(rpc_in);
    const char *p, *start, *end;
    char *method = NULL, *params = NULL;
    long long id = -2;
    int ok = 0;
    size_t n;
    if (!line)
        return -1;
    p = j_find_key(line, "id");
    if (p)
        id = j_parse_int(p, &ok);
    p = j_find_key(line, "method");
    if (p) {
        method = j_parse_str(p, &ok);
        if (!ok) {
            free(method);
            method = NULL;
        }
    }
    p = j_find_key(line, "params");
    if (p && *p == '{') {
        /* params run to the final '}' of the line */
        start = p;
        end = strrchr(line, '}');
        if (end && end > start) {
            n = (size_t) (end - start) + 1;
            params = malloc(n + 1);
            if (params) {
                memcpy(params, start, n);
                params[n] = '\0';
            }
        }
    }
    free(line);
    if (!method) {
        free(params);
        return -2;
    }
    *method_out = method;
    *params_out = params;
    return ok ? id : -2;
}

void
rpc_reply(long long id, const char *result_json)
{
    JBuf jb;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "jsonrpc");
    jb_str(&jb, "2.0");
    jb_key(&jb, "id");
    jb_int(&jb, id);
    jb_sep(&jb);
    jb_raw(&jb, "\"result\":");
    jb_raw(&jb, result_json ? result_json : "null");
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_write(jb.buf);
    jb_free(&jb);
}

void
rpc_reply_error(long long id, long long code, const char *message)
{
    JBuf jb;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "jsonrpc");
    jb_str(&jb, "2.0");
    jb_key(&jb, "id");
    jb_int(&jb, id);
    jb_sep(&jb);
    jb_raw(&jb, "\"error\":{\"code\":");
    {
        JBuf nb;
        jb_init(&nb);
        jb_int(&nb, code);
        if (nb.ok)
            jb_raw(&jb, nb.buf);
        jb_free(&nb);
    }
    jb_raw(&jb, ",\"message\":");
    {
        JBuf mb;
        jb_init(&mb);
        jb_str(&mb, message ? message : "error");
        if (mb.ok)
            jb_raw(&jb, mb.buf);
        jb_free(&mb);
    }
    jb_raw(&jb, "}");
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_write(jb.buf);
    jb_free(&jb);
}
