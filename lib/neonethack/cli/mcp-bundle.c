/* Immutable embedded runtime extraction. No game state is stored in this cache. */
#define _GNU_SOURCE
#include "mcp-bundle.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
struct bundle_file { const char *name; const unsigned char *bytes; size_t size; mode_t mode; };
#include "runtime.inc"

static int directory(const char *path)
{
    /* Walk without following symlinks, including existing ancestors. */
    if (path[0] != '/') { errno = EINVAL; return -1; }
    char copy[PATH_MAX];
    if (snprintf(copy,sizeof copy,"%s",path) >= (int)sizeof copy) { errno = ENAMETOOLONG; return -1; }
    int fd = open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC), next;
    char *save = NULL;
    for (char *part = strtok_r(copy,"/",&save); part && fd >= 0; part = strtok_r(NULL,"/",&save)) {
        if (!strcmp(part,"..")) { close(fd); errno = EINVAL; return -1; }
        if (mkdirat(fd,part,0700) && errno != EEXIST) { close(fd); return -1; }
        next = openat(fd,part,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
        close(fd); fd = next;
    }
    return fd;
}
static int verify(int dir, const struct bundle_file *f)
{
    int fd = openat(dir,f->name,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
    struct stat st;
    if (fd < 0) return -1;
    int bad = fstat(fd,&st) || !S_ISREG(st.st_mode) || st.st_size != (off_t)f->size || (st.st_mode & 0777) != f->mode;
    unsigned char buffer[65536]; size_t offset = 0;
    while (!bad && offset < f->size) {
        size_t length = f->size-offset; if (length > sizeof buffer) length = sizeof buffer;
        ssize_t n = read(fd,buffer,length);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0 || memcmp(buffer,f->bytes+offset,(size_t)n)) { bad = 1; break; }
        offset += (size_t)n;
    }
    close(fd); if (bad) errno = EIO;
    return bad ? -1 : 0;
}
int mcp_bundle_paths(char **engine, char **data, char **sessions)
{
    static char cache[PATH_MAX], runtime[PATH_MAX], executable[PATH_MAX], state[PATH_MAX];
    const char *home = getenv("HOME"), *xdg = getenv("XDG_CACHE_HOME");
    int root = -1, lock = -1, dir = -1, result = -1; char staging[96] = "";
    if (!xdg || !*xdg) {
        if (!home || home[0] != '/') { errno = EINVAL; goto done; }
        if (snprintf(cache,sizeof cache,"%s/.cache/neohack/runtimes",home) >= (int)sizeof cache) goto too_long;
    } else if (snprintf(cache,sizeof cache,"%s/neohack/runtimes",xdg) >= (int)sizeof cache) goto too_long;
    if (snprintf(runtime,sizeof runtime,"%s/%s",cache,bundle_id) >= (int)sizeof runtime ||
        snprintf(executable,sizeof executable,"%s/engine",runtime) >= (int)sizeof executable) goto too_long;
    if (!*sessions) {
        xdg = getenv("XDG_STATE_HOME");
        if (xdg && *xdg) {
            if (snprintf(state,sizeof state,"%s/neohack/sessions",xdg) >= (int)sizeof state) goto too_long;
        } else {
            if (!home || home[0] != '/') { errno = EINVAL; goto done; }
            if (snprintf(state,sizeof state,"%s/.local/state/neohack/sessions",home) >= (int)sizeof state) goto too_long;
        }
        if (state[0] != '/') { errno = EINVAL; goto done; }
        *sessions = state;
    }
    root = directory(cache); if (root < 0) goto done;
    struct stat st;
    if (fstat(root,&st) || st.st_uid != getuid() || (st.st_mode & 0077)) { errno = EPERM; goto done; }
    lock = openat(root,".lock",O_CREAT|O_RDWR|O_CLOEXEC|O_NOFOLLOW,0600);
    if (lock < 0 || flock(lock,LOCK_EX)) goto done;
    dir = openat(root,bundle_id,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
    if (dir < 0) {
        if (errno != ENOENT) goto done;
        /* PID plus random suffix: interrupted extraction never becomes a runtime. */
        unsigned int nonce;
        int random = open("/dev/urandom",O_RDONLY|O_CLOEXEC);
        if (random < 0) goto done;
        ssize_t n = read(random,&nonce,sizeof nonce); close(random);
        if (n != sizeof nonce) { errno = EIO; goto done; }
        snprintf(staging,sizeof staging,".stage-%ld-%08x",(long)getpid(),nonce);
        if (mkdirat(root,staging,0700)) { staging[0] = 0; goto done; }
        dir = openat(root,staging,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
        if (dir < 0) goto done;
        for (size_t i = 0; i < sizeof bundle_files/sizeof *bundle_files; i++) {
            const struct bundle_file *f = &bundle_files[i];
            int fd = openat(dir,f->name,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC|O_NOFOLLOW,0600);
            if (fd < 0) goto done;
            size_t offset = 0;
            while (offset < f->size) {
                ssize_t n = write(fd,f->bytes+offset,f->size-offset);
                if (n < 0 && errno == EINTR) continue;
                if (n <= 0) { close(fd); goto done; }
                offset += (size_t)n;
            }
            int bad = fchmod(fd,f->mode) || fsync(fd); int saved = errno;
            if (close(fd) && !bad) { bad = 1; saved = errno; }
            if (bad) { errno = saved; goto done; }
        }
        if (fsync(dir) || renameat(root,staging,root,bundle_id)) goto done;
        staging[0] = 0;
        if (fsync(root)) goto done;
    }
    for (size_t i = 0; i < sizeof bundle_files/sizeof *bundle_files; i++)
        if (verify(dir,&bundle_files[i])) goto done;
    *engine = executable; *data = runtime; result = 0;
    goto done;
too_long:
    errno = ENAMETOOLONG;
done:
    if (result) fprintf(stderr,"neohack-mcp: embedded runtime unavailable (%s); cache files are never repaired automatically\n",strerror(errno));
    if (staging[0] && dir >= 0) {
        for (size_t i = 0; i < sizeof bundle_files/sizeof *bundle_files; i++) unlinkat(dir,bundle_files[i].name,0);
        unlinkat(root,staging,AT_REMOVEDIR);
    }
    if (dir >= 0) close(dir);
    if (lock >= 0) close(lock);
    if (root >= 0) close(root);
    return result;
}
