/* Only immutable game data enters a new playground. Never copy a caller's
 * saves, bones, locks, logs, helper executables or arbitrary directory entries.
 * This allowlist is shared in intent with the native/WASM packaging recipes. */
static int
copy_static_file(const char *source, const char *destination)
{
    int in = -1, out = -1, result = -1, saved;
    struct stat st;
    char bytes[65536];
    ssize_t n;
    in = open(source, O_RDONLY | O_NOFOLLOW);
    if (in < 0) return -1;
    if (fstat(in, &st) || !S_ISREG(st.st_mode)) { errno = EINVAL; goto done; }
    out = open(destination, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (out < 0) goto done;
    while ((n = read(in, bytes, sizeof bytes)) > 0) {
        ssize_t offset = 0;
        while (offset < n) {
            ssize_t count = write(out, bytes + offset, (size_t)(n - offset));
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) goto done;
            offset += count;
        }
    }
    if (n < 0 || fsync(out)) goto done;
    result = 0;
done:
    saved = errno;
    if (out >= 0 && close(out) && result == 0) { saved = errno; result = -1; }
    close(in);
    errno = saved;
    return result;
}

static int
copy_template(const char *source, const char *destination)
{
    static const char *const files[] = { "nhdat", "sysconf", "symbols", "license", "options", NULL };
    static const char *const empty[] = { "logfile", "record", "xlogfile", "livelog", "perm", NULL };
    char from[PATH_MAX], to[PATH_MAX];
    size_t i;
    int fd;
    if (mkdir_p(destination)) return -1;
    for (i = 0; files[i]; i++) {
        if (snprintf(from, sizeof from, "%s/%s", source, files[i]) >= (int)sizeof from ||
            snprintf(to, sizeof to, "%s/%s", destination, files[i]) >= (int)sizeof to) { errno = ENAMETOOLONG; return -1; }
        if (access(from, F_OK) && errno == ENOENT) {
#ifndef __EMSCRIPTEN__
            if (!strcmp(files[i], "nhdat")) return -1;
#endif
            continue;
        }
        if (copy_static_file(from, to)) return -1;
    }
    for (i = 0; empty[i]; i++) {
        if (snprintf(to, sizeof to, "%s/%s", destination, empty[i]) >= (int)sizeof to) { errno = ENAMETOOLONG; return -1; }
        fd = open(to, O_WRONLY | O_CREAT | O_EXCL, 0600);
        if (fd < 0) return -1;
        if (fsync(fd)) { close(fd); return -1; }
        if (close(fd)) return -1;
    }
    if (snprintf(to, sizeof to, "%s/save", destination) >= (int)sizeof to) { errno = ENAMETOOLONG; return -1; }
    if (mkdir(to, 0700) && errno != EEXIST) return -1;
    fd = open(destination, O_RDONLY | O_DIRECTORY);
    if (fd < 0) return -1;
    { int ok = fsync(fd); close(fd); return ok; }
}
