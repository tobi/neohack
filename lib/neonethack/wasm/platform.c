/* Core-only WASM filesystem hooks. One semantic context owns this module.
 * Browser durable storage is guarded by an origin Web Lock before this module
 * is entered. MEMFS-only mode explicitly advertises volatile persistence.
 * All native pre-input fsync boundaries await IDBFS, not just end-of-action.
 */
#include <emscripten.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>
EM_JS(int, nnh_wasm_durable, (void), { return globalThis.__nnhHost.persistence === 'indexeddb' ? 1 : 0; });
EM_ASYNC_JS(int, nnh_sync_store, (void), {
    try { await globalThis.__nnhHost.sync(); return 0; }
    catch (error) { globalThis.__nnhHost.diagnostic(String(error)); return -1; }
});
int nnh_wasm_fsync(int fd)
{
    if (fcntl(fd, F_GETFD) < 0) return -1;
    if (nnh_sync_store() < 0) { errno = EIO; return -1; }
    return 0;
}
int nnh_wasm_flock(int fd, int operation)
{
    if (fcntl(fd, F_GETFD) < 0) return -1;
    /* Not an emulated inter-process lock: the worker owns the entire store.
     * Reject unexpected operations rather than treating them as protection. */
    if (operation != (LOCK_EX | LOCK_NB)) { errno = EINVAL; return -1; }
    return 0;
}
