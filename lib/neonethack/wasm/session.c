/* Private engine-process backend for WebAssembly. The host owns dedicated
 * engine workers; all semantic decisions, replay and receipts remain in C. */
#include "session.h"
#include <emscripten.h>
#include <errno.h>
#include <stdlib.h>
struct nh_session { int handle; };
EM_JS(int, host_start, (const char *pin, const char *arg), {
    try {
        if (FS.readFile(UTF8ToString(pin), {encoding:'utf8'}) !== globalThis.__nnhHost.identity) {
            globalThis.__nnhHost.diagnostic('Stored engine build differs from this WASM package. Resume requires the original package.');
            return 0;
        }
        return globalThis.__nnhHost.start(arg ? [UTF8ToString(arg)] : []);
    } catch (error) { globalThis.__nnhHost.diagnostic(String(error)); return 0; }
});
EM_JS(int, host_write, (int handle, const char *line), {
    return globalThis.__nnhHost.write(handle, UTF8ToString(line)) ? 0 : -1;
});
EM_ASYNC_JS(char *, host_read, (int handle, int timeout_ms), {
    const line = await globalThis.__nnhHost.read(handle, timeout_ms);
    if (line === null) return 0;
    const bytes = lengthBytesUTF8(line) + 1;
    const pointer = _malloc(bytes);
    if (pointer) stringToUTF8(line, pointer, bytes);
    return pointer;
});
EM_JS(int, host_ended, (int handle), { return globalThis.__nnhHost.ended(handle) ? 1 : 0; });
EM_JS(void, host_stop, (int handle), { globalThis.__nnhHost.stop(handle); });
nh_session_t *nh_session_start_with_lease(const char *bin, const char *dir, char *const argv[], int lease)
{
    nh_session_t *s;
    (void)dir; (void)lease;
    s = calloc(1, sizeof *s);
    if (!s) return NULL;
    s->handle = host_start(bin, argv ? argv[0] : NULL);
    if (!s->handle) { free(s); errno = ESTALE; return NULL; }
    return s;
}
nh_session_t *nh_session_start(const char *bin, const char *dir, char *const argv[])
{ return nh_session_start_with_lease(bin, dir, argv, -1); }
int nh_session_write(nh_session_t *s, const char *line)
{
    if (!s || host_write(s->handle, line)) { errno = EPIPE; return -1; }
    return 0;
}
char *nh_session_read_line(nh_session_t *s, int timeout_ms)
{
    char *line;
    if (!s) { errno = EINVAL; return NULL; }
    line = host_read(s->handle, timeout_ms);
    if (!line) errno = host_ended(s->handle) ? 0 : EAGAIN;
    return line;
}
int nh_session_ended(nh_session_t *s) { return !s || host_ended(s->handle); }
int nh_session_abort(nh_session_t *s)
{
    if (s) { host_stop(s->handle); free(s); }
    return 0;
}
/* C has committed the input journal already. Terminate without sending EOF as
 * a default answer to a pending prompt; resume replays the committed history. */
int nh_session_close(nh_session_t *s) { return nh_session_abort(s); }
