/* neonethack wasm shim: bridges the headless engine's blocking stdin
 * (json_read_line, the single choke point for rpc_input/rpc_read_request)
 * to an async JS line provider, via Asyncify (EM_ASYNC_JS).
 *
 * Called directly from json_min.c under #ifdef __EMSCRIPTEN__.
 */
#include <stdlib.h>
#include <string.h>

#include <emscripten.h>

/* Worker glue sets globalThis.__nhTakeLine to an async () => string|null
 * function. It resolves with the next UI->engine line, or null when the
 * session is closed (engine then sees EOF and exits cleanly). */
EM_ASYNC_JS(char *, nh_wasm_take_line, (void), {
    const take = globalThis.__nhTakeLine;
    if (typeof take !== "function")
        return 0;
    const line = await take();
    if (line == null)
        return 0;
    const n = lengthBytesUTF8(line) + 1;
    const p = _malloc(n);
    stringToUTF8(line, p, n);
    return p;
});

char *
nh_wasm_read_line(void)
{
    return nh_wasm_take_line();
}
