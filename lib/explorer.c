/* libneonethack Explorer API — see explorer.h (API_DESING.md contract).
 * POSIX C99 + neonethack.h + minjson.h. No other deps.
 *
 * Glyph-band bounds assume the vendored engine's generated counts
 * (NUMMONS=383, NUM_OBJECTS=481; verified by compiling a probe against
 * upstream/include). If upstream regenerates with different counts,
 * the band test below (item glyphs vs NO_GLYPH headers) catches drift.
 */
#define _POSIX_C_SOURCE 200809L
#define _XOPEN_SOURCE 700

#include "explorer.h"
#include "minjson.h"
#include "neonethack.h"

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <limits.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <time.h>
#include <unistd.h>

#define MAP_W 80
#define MAP_H 21
#define NSTATUS 27
#define NMSG 40
#define MAX_MENU_WINDOWS 16
#define MAX_EVENTS 2048
#define ACT_TIMEOUT_MS 30000
#define NO_GLYPH_NUM 9624 /* MAX_GLYPH: header/non-selectable menu rows */

/* NUMMONS=383, NUM_OBJECTS=481 (see file header). */
#define ALLY_LO 766
#define INVIS_LO 1532
#define BODY_LO 2299
#define RIDDEN_LO 2682
#define OBJ_LO 3448
#define CMAP_LO 3929
#define STRANGE_LO 4051
#define EFFECT_LO 7226

typedef enum {
    T_UNKNOWN = 0, T_WALL, T_FLOOR, T_CORRIDOR, T_DOOR_CLOSED,
    T_STAIRS_UP, T_STAIRS_DOWN, T_ALTAR, T_FOUNTAIN, T_THRONE,
    T_TRAP, T_DARK, T_WATER, T_LAVA, T_SINK, T_GRASS,
    T_DOOR_OPEN, T_BARS, T_TREE, T_ICE, T_GRAVE, T_BRIDGE
} terrain_t;

static const char *const TERRAIN_NAMES[] = {
    "unknown", "wall", "floor", "corridor", "closedDoor",
    "stairsUp", "stairsDown", "altar", "fountain", "throne",
    "trap", "dark", "water", "lava", "sink", "grass",
    "openDoor", "bars", "tree", "ice", "grave", "bridge"
};

typedef struct {
    int present;
    int glyph, ch, color;
} cell_t;

typedef struct {
    int index;
    int accel;      /* 0 = none */
    int glyph;
    int selectable; /* -1 = legacy/unspecified; otherwise engine fact */
    long long object_id; /* private binding for an offered object row */
    char *text;
} menu_item_t;

static int
menu_selectable(const menu_item_t *item)
{
    return item->selectable >= 0 ? item->selectable : item->accel > 0;
}

typedef struct {
    int used;
    int window;
    char *prompt;
    menu_item_t *items;
    size_t nitems, cap;
} menu_t;

typedef struct {
    int waiting;
    long long id;
    char kind[16];
    char *prompt;           /* about text when the engine supplies one */
    int window, how;        /* menu */
    char *choices;          /* yn (may be "") */
    int def;                /* yn default char */
    char **commands;        /* extcmd */
    size_t ncommands;
} pending_t;

/* BL_* status names (upstream/include/botl.h order). */
static const char *const VITAL_NAMES[NSTATUS] = {
    "title", "strength", "dexterity", "constitution",
    "intelligence", "wisdom", "charisma", "alignment",
    "score", "burden", "gold", "energy", "maxEnergy",
    "level", "armor", "toughness", "turn", "hunger",
    "health", "maxHealth", "depth", "experience",
    "condition", "hand", "wear", "ground",
    "version",
};

/* Flat perception kind for events (headers: glyph bands). */
static const char *
band_kind(int glyph)
{
    if (glyph >= NO_GLYPH_NUM - 2)
        return "terrain"; /* unexplored/nothing are not objects */
    if (glyph < ALLY_LO)
        return "creature";
    if (glyph < INVIS_LO)
        return "ally";
    if (glyph < BODY_LO)
        return "creature";
    if (glyph < RIDDEN_LO)
        return "remains";
    if (glyph < OBJ_LO)
        return "creature";
    if (glyph < CMAP_LO)
        return "object";
    if (glyph < STRANGE_LO)
        return "terrain";
    if (glyph < EFFECT_LO)
        return "effect";
    return "object";
}

typedef struct {
    long long seq;
    char *json;             /* rendered event object */
} event_t;

typedef struct {
    char ref[24];           /* opaque handle: item-N / here-N */
    char letter;            /* private engine slot (inventory only) */
    char *label;
    int location;           /* 0 inventory, 1 here */
    int quantity;
    int glyph;
    char category[24];      /* perceived object class, not name heuristics */
    unsigned usage;
    int usage_known;
    int armor_access_known, armor_accessible;
} inv_item_t;

static const char *const USAGE_NAMES[] = { "worn", "wielded", "offhand", "alternate", "quivered", "attached", NULL };

typedef struct {
    int waiting_answer;     /* engine prompt outstanding */
    char action[32];
    char args_json[1024];   /* supplied arguments (truncated ok) */
    char phase[32];
    char decision_id[40];
    char dec_kind[16];      /* kind of the offered decision */
    char prompt_signature[32]; /* exact pending-input context fingerprint */
    long long dec_pending;  /* engine prompt id the offer was built on;
                             * -2 = synthetic (no engine prompt held) */
    int keypos;             /* script keys consumed so far */
    int cmdkey;             /* command key to send (-2 = use action table) */
    char item_letter;       /* resolved inventory letter (0 = none) */
    int floor_index;        /* legacy floor-flow hint (-1 = none) */
    long long floor_object_id; /* resolved identity, never a menu ordinal */
    int dir_code;           /* resolved direction key (-1 = none) */
    int self_ok;            /* target self allowed for this action */
    int letter_answers;     /* letter-prompt answers given this run */
    char fail_code[32];     /* settle as blocked with this code */
    char fail_msg[128];
} operation_t;

typedef struct {
    char *label;
    char ref[24];
    char category[24];
    int quantity;
    long long object_id;   /* engine-issued identity from perception */
} floor_item_t;

typedef struct req_entry {
    char *rid;
    char *args_key;
    char *result;           /* stored response envelope */
    struct req_entry *next;
} req_entry_t;

typedef struct game {
    char id[65];
    char dir[PATH_MAX];     /* sessions_dir/<id> */
    char playground[PATH_MAX];
    nh_session_t *eng;
    int lease_fd;          /* exclusive run ownership; only its own engine retains it */
    int gen;
    int map_win;
    int you_x, you_y, have_you;
    int ended;
    char end_reason[64];
    char terminal_kind[32];
    char terminal_cause[256];
    long long terminal_turn;
    char location_id[80];
    int structured_perception; /* engine perception version; zero = legacy peeks */
    int perception_fresh;      /* snapshot received after the latest engine input */
    int replaying;          /* resume lockstep: suspend live auto-answers */
    int recording_only;
    char reconstruction_source[65];
    char reconstruction_input_hash[32];
    char reconstruction_engine_hash[32];
    char reconstruction_data_hash[32];
    long long reconstruction_step, reconstruction_total;
    long long deadline_ms;
    /* tracked perception */
    cell_t cells[MAP_H][MAP_W];
    unsigned char terrain[MAP_H][MAP_W]; /* terrain_t memory */
    char *status[NSTATUS];
    char *messages[NMSG];
    size_t msg_start, msg_count;
    menu_t menus[MAX_MENU_WINDOWS];
    pending_t pending;
    event_t *events;
    size_t nevents, event_cap;
    long long event_seq;
    long long next_decision;
    long long next_ref;
    /* semantic state */
    long long revision;
    long long frame_count;
    long long recording_bytes, recording_gaps;
    int recording_ready, recording_gap;
    char recording_error[192];
    struct stat recording_data_stat, recording_index_stat;
    req_entry_t *requests;
    size_t nrequests;
    int request_index_corrupt;
    int sidecar_present, sidecar_corrupt, boundary_complete, recovery_required;
    char sidecar_error[192], input_error[192];
    long long input_bytes, sidecar_input_bytes;
    size_t input_count;
    int input_ready;
    struct stat sidecar_stat, input_stat;
    operation_t operation;
    int have_operation;
    inv_item_t *inv;
    size_t ninv;
    long long inventory_rev;
    char *inv_label_by_letter[128]; /* last seen label per letter (stale-ref check) */
    floor_item_t *floor;
    size_t nfloor;
    int floor_x, floor_y;   /* player pos at peek */
    char floor_level[64];   /* level id at peek */
    int floor_valid;
    struct game *next;
} game_t;

struct nhx {
    char engine_bin[PATH_MAX];
    char template_dir[PATH_MAX];
    char sessions_dir[PATH_MAX];
    game_t *games;
};

/* ---------------- errors ---------------- */

static req_entry_t *req_lookup(game_t *g, const char *rid);
static void args_key_of(const char *args, mj_Buf *b);
static int req_reserve(game_t *g, const char *rid, const char *key);
static void req_restore_seen(game_t *g);
static char *req_saved_result(game_t *g, req_entry_t *e);
static char *run_reconstruct(nhx_t *x, const char *args);
static int record_frame(game_t *g, const char *request, const char *response);
static int record_prepare(game_t *g, int before_input);
static int record_regular(const char *path, int flags);
static int record_same(const struct stat *a, const struct stat *b);
static int record_dir_sync(game_t *g);
static int request_fields(const char *json, const char *const *allowed);
static int cmdkey_of(const char *action);
static int recon_unsafe_answer(game_t *g, const char *line);
static int record_is(mj_val v, const char *expected);
static int record_line(FILE *f, char **line, size_t *length);
static int record_validate(game_t *g, const char *line, long long sequence,
                           long long *turn, long long *revision, long long *through, int *gap);

static char *
fail_envelope(const char *session_id, const char *req_id,
              const char *code, const char *msg)
{
    mj_Buf b;
    mj_init(&b);
    mj_obj(&b);
    mj_key(&b, "sessionId"); mj_strv(&b, session_id ? session_id : "");
    mj_key(&b, "requestId");
    if (req_id)
        mj_strv(&b, req_id);
    else
        mj_nullv(&b);
    mj_key(&b, "error"); mj_obj(&b);
    mj_key(&b, "code"); mj_strv(&b, code);
    mj_key(&b, "message"); mj_strv(&b, msg);
    mj_endobj(&b);
    mj_endobj(&b);
    return mj_take(&b);
}

/* Run ownership is held across engine activity AND recording commits. flock
 * locks an open description, so separate handles in the same process also
 * conflict. The lock is kernel-released on process exit, not a stale PID file. */
static int
lease_acquire(game_t *g)
{
    char path[PATH_MAX];
    int fd, saved;
    struct stat st;
    if (g->lease_fd >= 0) return 0;
    if (lstat(g->dir, &st) || !S_ISDIR(st.st_mode)) { errno = EINVAL; return -1; }
    if (snprintf(path, sizeof path, "%s/.lease", g->dir) >= (int) sizeof path) {
        errno = ENAMETOOLONG;
        return -1;
    }
    fd = open(path, O_RDWR | O_CREAT | O_NOFOLLOW, 0600);
    if (fd < 0) return -1;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_nlink != 1) { close(fd); errno = EINVAL; return -1; }
    if (fcntl(fd, F_SETFD, FD_CLOEXEC) < 0 || flock(fd, LOCK_EX | LOCK_NB) < 0) {
        saved = errno; close(fd); errno = saved;
        return -1;
    }
    g->lease_fd = fd;
    return 1;
}

static void
lease_release(game_t *g)
{
    if (g->lease_fd >= 0) close(g->lease_fd);
    g->lease_fd = -1;
}

static char *
lease_error(game_t *g, const char *request_id)
{
    int busy = errno == EWOULDBLOCK || errno == EAGAIN;
    return fail_envelope(g->id, request_id, busy ? "sessionBusy" : "storageError",
                        busy ? "another process still owns or is retiring this world; review its recording or wait for it to leave"
                             : "cannot acquire exclusive run ownership");
}

/* ---------------- dirs + files ---------------- */

static int
valid_id(const char *id)
{
    size_t i, n;
    if (!id)
        return 0;
    n = strlen(id);
    if (n == 0 || n > 64)
        return 0;
    for (i = 0; i < n; i++) {
        char c = id[i];
        if (!(c >= 'A' && c <= 'Z') && !(c >= 'a' && c <= 'z') &&
            !(c >= '0' && c <= '9') && c != '_' && c != '-')
            return 0;
    }
    return 1;
}

static int
mkdir_p(const char *path)
{
    char tmp[PATH_MAX], *p;
    size_t n;
    if (!path || snprintf(tmp, sizeof tmp, "%s", path) >= (int) sizeof tmp)
        return -1;
    n = strlen(tmp);
    if (n == 0)
        return -1;
    for (p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            if (mkdir(tmp, 0700) < 0 && errno != EEXIST)
                return -1;
            *p = '/';
        }
    }
    if (mkdir(tmp, 0700) < 0 && errno != EEXIST)
        return -1;
    return 0;
}

static char copy_dst[PATH_MAX];
static size_t copy_srclen = 0;

static int
copy_cb(const char *fpath, const struct stat *sb, int typeflag,
        struct FTW *ftwbuf)
{
    char dst[PATH_MAX];
    (void) ftwbuf;
    if (snprintf(dst, sizeof dst, "%s%s", copy_dst, fpath + copy_srclen)
        >= (int) sizeof dst)
        return -1;
    if (typeflag == FTW_D) {
        if (mkdir(dst, 0700) < 0 && errno != EEXIST)
            return -1;
    } else if (typeflag == FTW_F) {
        int in, out;
        ssize_t n;
        char buf[65536];
        in = open(fpath, O_RDONLY);
        if (in < 0)
            return -1;
        out = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (out < 0) {
            close(in);
            return -1;
        }
        fchmod(out, sb->st_mode & 07777);
        while ((n = read(in, buf, sizeof buf)) > 0) {
            ssize_t w = 0;
            while (w < n) {
                ssize_t m = write(out, buf + w, (size_t) (n - w));
                if (m <= 0) {
                    close(in);
                    close(out);
                    return -1;
                }
                w += m;
            }
        }
        close(in);
        if (close(out) < 0)
            return -1;
        if (n < 0)
            return -1;
    }
    return 0;
}

static int
copy_tree(const char *src, const char *dst)
{
    char src_abs[PATH_MAX];
    if (!realpath(src, src_abs))
        return -1;
    if (mkdir_p(dst) < 0)
        return -1;
    snprintf(copy_dst, sizeof copy_dst, "%s", dst);
    copy_srclen = strlen(src_abs);
    return nftw(src_abs, copy_cb, 16, FTW_PHYS);
}

static int
rm_cb(const char *fpath, const struct stat *sb, int typeflag,
      struct FTW *ftwbuf)
{
    (void) sb;
    (void) ftwbuf;
    (void) typeflag;
    return remove(fpath);
}

#include "input_integrity.inc"

/* Complete, bounded input history or nothing: never return a partial read. */
static char **
log_read(game_t *g, size_t *n_out)
{
    char path[PATH_MAX], *line = NULL;
    char **out = NULL;
    struct stat before, after;
    FILE *f = NULL;
    size_t n = 0, length = 0, capacity = 0, i;
    int fd = -1, r;
    const char *error = "cannot read committed input journal";
    *n_out = 0; g->input_ready = 0;
    if (snprintf(path, sizeof path, "%s/input.log.jsonl", g->dir) >= (int) sizeof path) goto failed;
    fd = record_regular(path, O_RDONLY);
    if (fd < 0 || fstat(fd, &before) || before.st_size > INPUT_MAX_BYTES) goto failed;
    f = fdopen(fd, "r"); if (!f) goto failed; fd = -1;
    while ((r = record_line(f, &line, &length)) == 1) {
        if (length > INPUT_MAX_LINE || n >= INPUT_MAX_LINES) { error = "input journal exceeds replay limits"; goto failed; }
        if (n == capacity) {
            size_t next = capacity ? capacity * 2 : 64;
            char **grown = realloc(out, next * sizeof *out);
            if (!grown) goto failed;
            out = grown; capacity = next;
        }
        line[--length] = 0; /* LF was verified by record_line. */
        if (length && line[length - 1] == '\r') line[--length] = 0;
        out[n++] = line; line = NULL;
    }
    if (r < 0 || fstat(fileno(f), &after) || !record_same(&before, &after)) { error = "incomplete or changing input journal"; goto failed; }
    error = input_validate_range(out, n, 0);
    if (error) goto failed;
    if (!out && !(out = calloc(1, sizeof *out))) { error = "out of memory reading input journal"; goto failed; }
    fclose(f);
    g->input_count = n; g->input_bytes = before.st_size; g->input_stat = before; g->input_ready = 1;
    g->input_error[0] = 0; *n_out = n;
    return out;
failed:
    snprintf(g->input_error, sizeof g->input_error, "%s", error ? error : "input journal could not be validated");
    free(line); for (i = 0; i < n; i++) free(out[i]); free(out);
    if (f) fclose(f); else if (fd >= 0) close(fd);
    return NULL;
}

/* Journal before input. A failed append is not permission to send the answer. */
static int
log_append(game_t *g, const char *line)
{
    char path[PATH_MAX]; struct stat st;
    int fd, ok; FILE *f;
    char *one = (char *) line;
    if (g->lease_fd < 0 || g->input_error[0]) return -1;
    if (!g->input_ready) {
        size_t n = 0, i; char **lines = log_read(g, &n);
        if (!lines) return -1;
        for (i = 0; i < n; i++) free(lines[i]);
        free(lines);
    }
    if (input_validate_range(&one, 1, g->input_count) || strchr(line, '\n') ||
        g->input_bytes + (long long) strlen(line) + 1 > INPUT_MAX_BYTES) goto failed;
    if (snprintf(path, sizeof path, "%s/input.log.jsonl", g->dir) >= (int) sizeof path) goto failed;
    fd = record_regular(path, O_WRONLY | O_APPEND);
    if (fd < 0) goto failed;
    if (fstat(fd, &st) || !record_same(&st, &g->input_stat)) { close(fd); goto failed; }
    f = fdopen(fd, "a"); if (!f) { close(fd); goto failed; }
    ok = fputs(line, f) >= 0 && fputc('\n', f) != EOF && fflush(f) == 0 && fsync(fileno(f)) == 0;
    if (ok && fstat(fileno(f), &st)) ok = 0;
    if (fclose(f)) ok = 0;
    if (ok) {
        fd = open(g->dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        if (fd < 0) ok = 0;
        else { if (fsync(fd)) ok = 0; close(fd); }
    }
    if (!ok) goto failed;
    g->input_count++; g->input_bytes = st.st_size; g->input_stat = st;
    return 0;
failed:
    g->input_ready = 0;
    snprintf(g->input_error, sizeof g->input_error, "input journal could not be durably appended; no answer was sent");
    return -1;
}

/* ---------------- sidecar (revision, idempotency, operation) ---------------- */
#include "sidecar_integrity.inc"

static int
sidecar_path(game_t *g, char *out, size_t cap)
{
    return snprintf(out, cap, "%s/meta.json", g->dir) < (int) cap ? 0 : -1;
}

static int
sidecar_save(game_t *g)
{
    char path[PATH_MAX], tmp[PATH_MAX];
    struct stat st;
    FILE *f;
    int fd, ok;
    req_entry_t *e;
    mj_Buf b;
    if (g->sidecar_corrupt || g->sidecar_error[0] || g->lease_fd < 0) return -1;
    if (sidecar_path(g, path, sizeof path) ||
        snprintf(tmp, sizeof tmp, "%s/.session-meta-XXXXXX", g->dir) >= (int) sizeof tmp) goto failed;
    if (lstat(path, &st)) {
        if (errno != ENOENT || g->sidecar_present) goto changed;
    } else if (!S_ISREG(st.st_mode) || st.st_nlink != 1 ||
        (g->sidecar_present && !record_same(&st, &g->sidecar_stat))) goto changed;
    fd = mkstemp(tmp);
    if (fd < 0) goto failed;
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    f = fdopen(fd, "w");
    if (!f) { close(fd); unlink(tmp); goto failed; }
    mj_init(&b);
    mj_obj(&b);
    if (g->sidecar_input_bytes >= 0) {
        mj_key(&b, "format"); mj_strv(&b, "neonethack.session");
        mj_key(&b, "version"); mj_intv(&b, 1);
        mj_key(&b, "sessionId"); mj_strv(&b, g->id);
        mj_key(&b, "inputBytes"); mj_intv(&b, g->sidecar_input_bytes);
        mj_key(&b, "boundaryComplete"); mj_boolv(&b, g->boundary_complete && !g->recovery_required);
    }
    mj_key(&b, "revision"); mj_intv(&b, g->revision);
    mj_key(&b, "frameCount"); mj_intv(&b, g->frame_count);
    mj_key(&b, "recordingGap"); mj_boolv(&b, g->recording_gap);
    mj_key(&b, "recordingOnly"); mj_boolv(&b, g->recording_only);
    mj_key(&b, "inventoryRev"); mj_intv(&b, g->inventory_rev);
    mj_key(&b, "nextDecision"); mj_intv(&b, g->next_decision);
    mj_key(&b, "nextRef"); mj_intv(&b, g->next_ref);
    mj_key(&b, "requests"); mj_arr(&b);
    {
        size_t kept = 0;
        for (e = g->requests; e && kept < 64; e = e->next) {
            if (!e->result) continue;
            kept++;
            mj_obj(&b);
            mj_key(&b, "rid"); mj_strv(&b, e->rid);
            mj_key(&b, "argsKey"); mj_strv(&b, e->args_key);
            mj_key(&b, "result"); mj_rawv(&b, e->result);
            mj_endobj(&b);
        }
    }
    mj_endarr(&b);
    mj_key(&b, "operation");
    if (g->have_operation) {
        if (g->boundary_complete && g->pending.waiting && g->operation.dec_pending != -2)
            pending_signature(g, g->operation.prompt_signature);
        mj_obj(&b);
        mj_key(&b, "action"); mj_strv(&b, g->operation.action);
        mj_key(&b, "args");
        mj_rawv(&b, g->operation.args_json[0] ? g->operation.args_json : "{}");
        mj_key(&b, "phase"); mj_strv(&b, g->operation.phase);
        mj_key(&b, "decisionId"); mj_strv(&b, g->operation.decision_id);
        mj_key(&b, "decKind"); mj_strv(&b, g->operation.dec_kind);
        mj_key(&b, "promptSignature"); mj_strv(&b, g->operation.prompt_signature);
        mj_key(&b, "decSynthetic");
        mj_boolv(&b, g->operation.dec_pending == -2);
        mj_key(&b, "keypos"); mj_intv(&b, g->operation.keypos);
        mj_key(&b, "cmdkey"); mj_intv(&b, g->operation.cmdkey);
        mj_key(&b, "dirCode"); mj_intv(&b, g->operation.dir_code);
        mj_key(&b, "itemLetter"); mj_intv(&b, g->operation.item_letter);
        mj_key(&b, "floorIndex"); mj_intv(&b, g->operation.floor_index);
        mj_key(&b, "floorObjectId"); mj_intv(&b, g->operation.floor_object_id);
        mj_key(&b, "selfAllowed"); mj_intv(&b, g->operation.self_ok);
        mj_key(&b, "letterAnswers"); mj_intv(&b, g->operation.letter_answers);
        mj_endobj(&b);
    } else {
        mj_nullv(&b);
    }
    mj_endobj(&b);
    ok = b.ok && mj_valid(b.buf) && fputs(b.buf, f) >= 0 && fflush(f) == 0 && fsync(fileno(f)) == 0;
    mj_free(&b);
    if (fclose(f)) ok = 0;
    if (!ok || rename(tmp, path)) { unlink(tmp); goto failed; }
    g->sidecar_present = 1;
    if (lstat(path, &g->sidecar_stat) || record_dir_sync(g)) goto failed;
    return 0;
changed:
    g->sidecar_corrupt = 1;
    snprintf(g->sidecar_error, sizeof g->sidecar_error, "semantic metadata changed outside its owner; no bytes were replaced");
    return -1;
failed:
    snprintf(g->sidecar_error, sizeof g->sidecar_error, "semantic metadata could not be durably committed; fix storage and resume");
    return -1;
}

static void
req_remember(game_t *g, const char *rid, const char *args_key,
             const char *result)
{
    req_entry_t *e = req_lookup(g, rid), *it;
    size_t kept = 0;
    if (!e) {
        e = calloc(1, sizeof *e);
        if (!e) return;
        e->rid = strdup(rid); e->args_key = strdup(args_key);
        if (!e->rid || !e->args_key) { free(e->rid); free(e->args_key); free(e); return; }
        e->next = g->requests; g->requests = e; g->nrequests++;
    }
    free(e->result); e->result = strdup(result);
    /* Keep recent responses hot; older receipts are read lazily from the
     * public checkpoint journal, while every reserved request id stays known. */
    for (it = g->requests; it; it = it->next) {
        if (it->result && ++kept > 64) { free(it->result); it->result = NULL; }
    }
    sidecar_save(g);
}

static req_entry_t *
req_lookup(game_t *g, const char *rid)
{
    req_entry_t *e;
    for (e = g->requests; e; e = e->next)
        if (!strcmp(e->rid, rid))
            return e;
    return NULL;
}

static void req_remember_nosave(game_t *g, const char *rid,
                              const char *args_key, const char *result);

static void
sidecar_load(game_t *g)
{
    char path[PATH_MAX], *text = NULL;
    FILE *f;
    struct stat before, after;
    size_t size;
    int fd, ok;
    char *canonical;
    const char *error = NULL;
    mj_val v, elt;
    if (sidecar_path(g, path, sizeof path)) goto corrupt;
    fd = record_regular(path, O_RDONLY);
    if (fd < 0) { if (errno == ENOENT) return; goto corrupt; }
    g->sidecar_present = 1;
    if (fstat(fd, &before) || before.st_size <= 0 || before.st_size > 64L * 1024 * 1024) { close(fd); goto corrupt; }
    size = (size_t) before.st_size;
    f = fdopen(fd, "r"); if (!f) { close(fd); goto corrupt; }
    text = malloc(size + 1);
    if (!text) { fclose(f); goto corrupt; }
    ok = fread(text, 1, size, f) == size && !ferror(f) &&
        !fstat(fileno(f), &after) && record_same(&before, &after);
    fclose(f); text[size] = 0;
    if (!ok || memchr(text, 0, size) || !mj_valid(text)) goto corrupt;
    canonical = mj_canonical((mj_val) { text });
    if (!canonical) goto corrupt;
    free(canonical);
    error = sidecar_validate(g, text);
    if (error) goto corrupt;
    g->sidecar_stat = before;
    if (mj_find(text, "inputBytes", &v)) mj_int(v, &g->sidecar_input_bytes);
    if (mj_find(text, "boundaryComplete", &v)) mj_bool(v, &g->boundary_complete);
    if (mj_find(text, "revision", &v)) {
        long long n;
        if (mj_int(v, &n))
            g->revision = n;
    }
    if (mj_find(text, "frameCount", &v)) {
        long long n;
        if (mj_int(v, &n)) g->frame_count = n;
    }
    if (mj_find(text, "recordingGap", &v)) mj_bool(v, &g->recording_gap);
    if (mj_find(text, "recordingOnly", &v)) {
        int flag = 0;
        if (mj_bool(v, &flag)) g->recording_only = flag;
    }
    if (mj_find(text, "inventoryRev", &v)) {
        long long n;
        if (mj_int(v, &n))
            g->inventory_rev = n;
    }
    if (mj_find(text, "nextDecision", &v)) {
        long long n;
        if (mj_int(v, &n))
            g->next_decision = n;
    }
    if (mj_find(text, "nextRef", &v)) {
        long long n;
        if (mj_int(v, &n))
            g->next_ref = n;
    }
    if (mj_find(text, "requests", &v)) {
        size_t len;
        const char *raw = mj_raw(v, &len);
        char *cpy = malloc(len + 1);
        if (!cpy) { error = "cannot load semantic receipts"; goto corrupt; }
        {
            mj_arr_it it;
            memcpy(cpy, raw, len);
            cpy[len] = '\0';
            memset(&it, 0, sizeof it);
            it.first = 1;
            while (mj_arr_next(cpy, &it, &elt)) {
                size_t elen;
                const char *eraw = mj_raw(elt, &elen);
                char *ecpy = malloc(elen + 1);
                mj_val rv, kv, sv;
                if (!ecpy) { free(cpy); error = "cannot load all semantic receipts"; goto corrupt; }
                memcpy(ecpy, eraw, elen);
                ecpy[elen] = '\0';
                if (mj_find(ecpy, "rid", &rv) && mj_find(ecpy, "argsKey", &kv) &&
                    mj_find(ecpy, "result", &sv)) {
                    char *rid = mj_str(rv), *ak = mj_str(kv);
                    size_t slen;
                    const char *sraw = mj_raw(sv, &slen);
                    char *res = malloc(slen + 1);
                    if (rid && ak && res) {
                        memcpy(res, sraw, slen);
                        res[slen] = '\0';
                        req_remember_nosave(g, rid, ak, res);
                    }
                    free(rid);
                    free(ak);
                    free(res);
                }
                free(ecpy);
            }
            free(cpy);
        }
    }
    if (mj_find(text, "operation", &v) && !mj_is_null(v)) {
        size_t len;
        const char *raw = mj_raw(v, &len);
        char *cpy = malloc(len + 1);
        if (!cpy) { error = "cannot load semantic operation"; goto corrupt; }
        {
            mj_val av, pv, dv, gv;
            memcpy(cpy, raw, len);
            cpy[len] = '\0';
            memset(&g->operation, 0, sizeof g->operation);
            if (mj_find(cpy, "action", &av)) {
                char *s = mj_str(av);
                if (s) {
                    snprintf(g->operation.action, sizeof g->operation.action, "%s", s);
                    free(s);
                }
            }
            if (mj_find(cpy, "args", &gv)) {
                size_t glen;
                const char *graw = mj_raw(gv, &glen);
                if (glen < sizeof g->operation.args_json) {
                    memcpy(g->operation.args_json, graw, glen);
                    g->operation.args_json[glen] = '\0';
                }
            }
            if (mj_find(cpy, "phase", &pv)) {
                char *s = mj_str(pv);
                if (s) {
                    snprintf(g->operation.phase, sizeof g->operation.phase, "%s", s);
                    free(s);
                }
            }
            if (mj_find(cpy, "decisionId", &dv)) {
                char *s = mj_str(dv);
                if (s) {
                    snprintf(g->operation.decision_id, sizeof g->operation.decision_id, "%s", s);
                    free(s);
                }
            }
            if (mj_find(cpy, "decKind", &dv)) {
                char *s = mj_str(dv);
                if (s) {
                    snprintf(g->operation.dec_kind, sizeof g->operation.dec_kind, "%s", s);
                    free(s);
                }
            }
            if (mj_find(cpy, "promptSignature", &dv)) {
                char *s = mj_str(dv);
                if (s) { snprintf(g->operation.prompt_signature, sizeof g->operation.prompt_signature, "%s", s); free(s); }
            }
            if (mj_find(cpy, "decSynthetic", &dv)) {
                int syn = 0;
                if (mj_bool(dv, &syn) && syn)
                    g->operation.dec_pending = -2;
            }
            {
                long long n;
                g->operation.dir_code = -1;
                g->operation.floor_index = -1;
                g->operation.cmdkey = -2;
                if (mj_find(cpy, "keypos", &dv) && mj_int(dv, &n)) g->operation.keypos = (int) n;
                if (mj_find(cpy, "cmdkey", &dv) && mj_int(dv, &n)) g->operation.cmdkey = (int) n;
                if (mj_find(cpy, "dirCode", &dv) && mj_int(dv, &n)) g->operation.dir_code = (int) n;
                if (mj_find(cpy, "itemLetter", &dv) && mj_int(dv, &n)) g->operation.item_letter = (char) n;
                if (mj_find(cpy, "floorIndex", &dv) && mj_int(dv, &n)) g->operation.floor_index = (int) n;
                if (mj_find(cpy, "floorObjectId", &dv) && mj_int(dv, &n)) g->operation.floor_object_id = n;
                if (mj_find(cpy, "selfAllowed", &dv) && mj_int(dv, &n)) g->operation.self_ok = (int) n;
                if (mj_find(cpy, "letterAnswers", &dv) && mj_int(dv, &n)) g->operation.letter_answers = (int) n;
            }
            g->have_operation = g->operation.action[0] != '\0';
            free(cpy);
        }
    }
    free(text);
    return;
corrupt:
    free(text); g->sidecar_present = 1; g->sidecar_corrupt = 1;
    snprintf(g->sidecar_error, sizeof g->sidecar_error, "%s", error ? error : "semantic metadata is unreadable, incomplete or invalid; original bytes were preserved");
}

/* req_remember without the save (sidecar_load replays many). */
static void
req_remember_nosave(game_t *g, const char *rid, const char *args_key,
                    const char *result)
{
    req_entry_t *e = malloc(sizeof *e);
    if (!e) { g->request_index_corrupt = 1; return; }
    e->rid = strdup(rid);
    e->args_key = strdup(args_key);
    e->result = result ? strdup(result) : NULL;
    e->next = g->requests;
    if (!e->rid || !e->args_key || (result && !e->result)) {
        g->request_index_corrupt = 1;
        free(e->rid);
        free(e->args_key);
        free(e->result);
        free(e);
        return;
    }
    /* The sidecar is newest-first; preserve that order on reload. */
    {
        req_entry_t **tail = &g->requests;
        while (*tail) tail = &(*tail)->next;
        e->next = NULL;
        *tail = e;
    }
    g->nrequests++;
}

/* Reload only after acquiring a run from another owner. Cached sidecars from
 * unsuccessful resume attempts must never overwrite newer revisions/receipts. */
static void
semantic_reload(game_t *g)
{
    req_entry_t *e;
    while ((e = g->requests) != NULL) {
        g->requests = e->next;
        free(e->rid); free(e->args_key); free(e->result); free(e);
    }
    g->nrequests = 0;
    g->request_index_corrupt = 0;
    g->revision = g->frame_count = 0;
    g->recording_ready = g->recording_gap = 0;
    g->recording_error[0] = 0;
    g->sidecar_present = g->sidecar_corrupt = g->recovery_required = g->input_ready = 0;
    g->sidecar_error[0] = g->input_error[0] = 0;
    g->sidecar_input_bytes = -1; g->boundary_complete = 1;
    g->next_decision = g->next_ref = 1;
    g->inventory_rev = -1;
    g->recording_only = 0;
    g->have_operation = 0;
    memset(&g->operation, 0, sizeof g->operation);
    g->operation.floor_index = g->operation.dir_code = -1;
    g->operation.cmdkey = -2;
    sidecar_load(g);
    if (!g->recording_only) req_restore_seen(g);
}

/* A durable request-id reservation precedes every engine-affecting request.
 * Recent receipts stay in the sidecar; older complete receipts are retrieved
 * from the public recording. A reserved id with no receipt is uncertain, not
 * permission to execute again. The small id index is never cache-evicted. */
static int
req_marker(FILE *f, const char *rid, const char *key)
{
    mj_Buf b;
    int ok;
    mj_init(&b); mj_obj(&b);
    mj_key(&b, "rid"); mj_strv(&b, rid);
    mj_key(&b, "argsKey"); mj_strv(&b, key);
    mj_endobj(&b);
    ok = b.ok && fputs(b.buf, f) >= 0 && fputc('\n', f) != EOF;
    mj_free(&b);
    return ok;
}

static void
req_restore_seen(game_t *g)
{
    char path[PATH_MAX], *line = NULL;
    size_t len = 0;
    int read_result;
    FILE *f;
    if (snprintf(path, sizeof path, "%s/requests.seen.jsonl", g->dir) >= (int) sizeof path) { g->request_index_corrupt = 1; return; }
    {
        int fd = record_regular(path, O_RDONLY);
        f = fd >= 0 ? fdopen(fd, "r") : NULL;
        if (fd >= 0 && !f) close(fd);
    }
    if (f) {
        while ((read_result = record_line(f, &line, &len)) == 1) {
            mj_val rv, kv;
            char *rid = NULL, *key = NULL;
            if (len > 8192 || !mj_valid(line) || line[len - 1] != '\n' || !mj_find(line, "rid", &rv) ||
                !mj_find(line, "argsKey", &kv) ||
                !(rid = mj_str(rv)) || !(key = mj_str(kv))) {
                g->request_index_corrupt = 1;
            } else {
                req_entry_t *e = req_lookup(g, rid);
                if (e && strcmp(e->args_key, key)) g->request_index_corrupt = 1;
                if (!e) req_remember_nosave(g, rid, key, NULL);
            }
            free(rid); free(key);
            free(line); line = NULL;
        }
        if (read_result < 0 || ferror(f)) g->request_index_corrupt = 1;
        free(line); fclose(f);
        return;
    }
    if (errno != ENOENT) { g->request_index_corrupt = 1; return; }
    /* Upgrade pre-index runs by learning ids from their existing public
     * receipts. No engine is executed and the archive is never rewritten. */
    if (snprintf(path, sizeof path, "%s/perceptions.jsonl", g->dir) >= (int) sizeof path) return;
    {
        int fd = record_regular(path, O_RDONLY);
        f = fd >= 0 ? fdopen(fd, "r") : NULL;
        if (fd >= 0 && !f) close(fd);
    }
    if (!f) return;
    {
    long long sequence = 0, turn, revision, through;
    int gap;
    while ((read_result = record_line(f, &line, &len)) == 1) {
        mj_val rv, idv;
        if (len > 8 * 1024 * 1024 || line[len - 1] != '\n' ||
            !record_validate(g, line, sequence++, &turn, &revision, &through, &gap)) {
            g->request_index_corrupt = 1; break;
        }
        char *request = NULL, *rid = NULL, *key = NULL;
        size_t n;
        mj_find(line, "request", &rv);
        {
            const char *raw = mj_raw(rv, &n);
            request = strndup(raw, n);
        }
        if (request && mj_find(request, "tool", &idv) && record_is(idv, "act") &&
            mj_find(request, "requestId", &idv)) rid = mj_str(idv);
        if (rid && !req_lookup(g, rid)) {
            mj_Buf b;
            mj_init(&b); args_key_of(request, &b);
            if (b.ok) key = mj_take(&b);
            mj_free(&b);
            if (key) req_remember_nosave(g, rid, key, NULL);
        }
        free(request); free(rid); free(key);
        free(line); line = NULL;
    }
    if (read_result < 0) g->request_index_corrupt = 1;
    }
    free(line); fclose(f);
}

static int
req_reserve(game_t *g, const char *rid, const char *key)
{
    char path[PATH_MAX];
    FILE *f;
    req_entry_t *e, *old;
    int exists, ok = 1;
    if (g->lease_fd < 0 || g->request_index_corrupt) { errno = EPERM; return -1; }
    if (req_lookup(g, rid)) return 0;
    if (snprintf(path, sizeof path, "%s/requests.seen.jsonl", g->dir) >= (int) sizeof path) return -1;
    exists = access(path, F_OK) == 0;
    e = calloc(1, sizeof *e);
    if (!e) return -1;
    e->rid = strdup(rid); e->args_key = strdup(key);
    if (!e->rid || !e->args_key) { free(e->rid); free(e->args_key); free(e); return -1; }
    {
        int fd = record_regular(path, O_WRONLY | O_APPEND | O_CREAT);
        f = fd >= 0 ? fdopen(fd, "a") : NULL;
        if (fd >= 0 && !f) close(fd);
    }
    if (!f) { free(e->rid); free(e->args_key); free(e); return -1; }
    if (!exists)
        for (old = g->requests; old; old = old->next)
            if (!req_marker(f, old->rid, old->args_key)) { ok = 0; break; }
    if (ok) ok = req_marker(f, rid, key);
    if (fflush(f) || fsync(fileno(f))) ok = 0;
    if (fclose(f)) ok = 0;
    if (ok && !exists) {
        int dfd = open(g->dir, O_RDONLY);
        if (dfd < 0) ok = 0;
        else { if (fsync(dfd)) ok = 0; close(dfd); }
    }
    if (!ok) {
        g->request_index_corrupt = 1;
        free(e->rid); free(e->args_key); free(e);
        return -1;
    }
    e->next = g->requests; g->requests = e; g->nrequests++;
    return 0;
}

static char *
req_saved_result(game_t *g, req_entry_t *e)
{
    char path[PATH_MAX], *line = NULL, *answer = NULL;
    size_t len = 0;
    long long sequence = 0, turn, revision, through;
    int gap, fd;
    FILE *f;
    if (e->result) return strdup(e->result);
    if (snprintf(path, sizeof path, "%s/perceptions.jsonl", g->dir) >= (int) sizeof path) return NULL;
    fd = record_regular(path, O_RDONLY);
    if (fd < 0) return NULL;
    f = fdopen(fd, "r");
    if (!f) { close(fd); return NULL; }
    while (record_line(f, &line, &len) == 1) {
        mj_val rv, idv, request;
        char *key = NULL;
        mj_Buf b;
        if (!record_validate(g, line, sequence++, &turn, &revision, &through, &gap)) break;
        if (!mj_find(line, "request", &request)) break;
        mj_init(&b); args_key_of(request.p, &b);
        if (b.ok) key = mj_take(&b);
        mj_free(&b);
        if (!key || strcmp(key, e->args_key)) { free(key); free(line); line = NULL; continue; }
        free(key);
        char *response, *rid = NULL;
        const char *raw;
        size_t n;
        if (!mj_find(request.p, "requestId", &idv) || !record_is(idv, e->rid) ||
            !mj_find(line, "response", &rv)) { free(line); line = NULL; continue; }
        raw = mj_raw(rv, &n); response = strndup(raw, n);
        if (response && mj_find(response, "requestId", &idv)) rid = mj_str(idv);
        if (rid && !strcmp(rid, e->rid)) {
            answer = response; response = NULL;
        }
        free(response); free(rid);
        if (answer) break;
        free(line); line = NULL;
    }
    free(line); fclose(f);
    return answer;
}

/* ---------------- events ---------------- */

static void
push_event(game_t *g, const char *json)
{
    event_t *e;
    if (g->nevents == MAX_EVENTS) {
        size_t i;
        free(g->events[0].json);
        for (i = 1; i < g->nevents; i++)
            g->events[i - 1] = g->events[i];
        g->nevents--;
    }
    if (g->nevents == g->event_cap) {
        size_t nc = g->event_cap ? g->event_cap * 2 : 64;
        event_t *nb = realloc(g->events, nc * sizeof *nb);
        if (!nb)
            return;
        g->events = nb;
        g->event_cap = nc;
    }
    e = &g->events[g->nevents++];
    e->seq = ++g->event_seq;
    e->json = strdup(json);
    if (!e->json)
        g->nevents--;
}

static void
push_saw(game_t *g, int x, int y, int glyph, int ch, int color)
{
    mj_Buf b;
    char mark[8];
    if (ch >= 32 && ch < 127) {
        mark[0] = (char) ch;
        mark[1] = '\0';
    } else {
        snprintf(mark, sizeof mark, "\\u%04x", ch & 0xffff);
    }
    mj_init(&b);
    mj_obj(&b);
    mj_key(&b, "type"); mj_strv(&b, "saw");
    mj_key(&b, "x"); mj_intv(&b, x);
    mj_key(&b, "y"); mj_intv(&b, y);
    mj_key(&b, "kind"); mj_strv(&b, band_kind(glyph));
    mj_key(&b, "mark"); mj_strv(&b, mark);
    mj_key(&b, "color"); mj_intv(&b, color);
    mj_endobj(&b);
    if (b.ok)
        push_event(g, b.buf);
    mj_free(&b);
}

static void
push_felt(game_t *g, const char *sense, const char *value)
{
    mj_Buf b;
    mj_init(&b);
    mj_obj(&b);
    mj_key(&b, "type"); mj_strv(&b, "felt");
    mj_key(&b, "sense"); mj_strv(&b, sense);
    mj_key(&b, "value"); mj_strv(&b, value);
    mj_endobj(&b);
    if (b.ok)
        push_event(g, b.buf);
    mj_free(&b);
}

static void
push_heard(game_t *g, const char *text)
{
    mj_Buf b;
    mj_init(&b);
    mj_obj(&b);
    mj_key(&b, "type"); mj_strv(&b, "heard");
    mj_key(&b, "text"); mj_strv(&b, text);
    mj_endobj(&b);
    if (b.ok)
        push_event(g, b.buf);
    mj_free(&b);
}

/* ---------------- tracked ingest ---------------- */

static menu_t *
menu_for(game_t *g, int window, int create)
{
    size_t i;
    for (i = 0; i < MAX_MENU_WINDOWS; i++)
        if (g->menus[i].used && g->menus[i].window == window)
            return &g->menus[i];
    if (!create)
        return NULL;
    for (i = 0; i < MAX_MENU_WINDOWS; i++)
        if (!g->menus[i].used) {
            g->menus[i].used = 1;
            g->menus[i].window = window;
            return &g->menus[i];
        }
    return NULL;
}

static void
menu_clear(menu_t *m)
{
    size_t i;
    for (i = 0; i < m->nitems; i++)
        free(m->items[i].text);
    free(m->items);
    free(m->prompt);
    memset(m, 0, sizeof *m);
}

/* Symbol values are from the vendored defsym.h, provided by the engine's
 * glyph_to_cmap on already perceived glyphs (not live hidden terrain). */
static terrain_t
terrain_from_cmap(int c)
{
    if (c >= 1 && c <= 11) return T_WALL;
    if (c >= 49 && c <= 73) return T_TRAP;
    switch (c) {
    case 0: case 20: return T_DARK;
    case 12: case 19: case 21: return T_FLOOR;
    case 13: case 14: return T_DOOR_OPEN;
    case 15: case 16: return T_DOOR_CLOSED;
    case 17: return T_BARS;
    case 18: return T_TREE;
    case 22: case 23: case 24: return T_CORRIDOR;
    case 25: case 27: case 29: case 31: return T_STAIRS_UP;
    case 26: case 28: case 30: case 32: return T_STAIRS_DOWN;
    case 33: return T_ALTAR;
    case 34: return T_GRAVE;
    case 35: return T_THRONE;
    case 36: return T_SINK;
    case 37: return T_FOUNTAIN;
    case 38: case 48: return T_WATER;
    case 39: return T_ICE;
    case 40: case 41: return T_LAVA;
    case 42: case 43: case 44: case 45: return T_BRIDGE;
    default: return T_UNKNOWN;
    }
}

/* Read non-mutating object perceptions emitted by the engine itself. */
static void
ingest_belongings(game_t *g, const char *params)
{
    mj_val v, el;
    long long branch = 0, level = 0, n;
    int known = 0, which;
    size_t i;
    if (mj_find(params, "branch", &v)) mj_int(v, &branch);
    if (mj_find(params, "level", &v)) mj_int(v, &level);
    snprintf(g->location_id, sizeof g->location_id, "level-%lld-%lld", branch, level);
    if (mj_find(params, "floorKnown", &v)) mj_bool(v, &known);
    if (mj_find(params, "x", &v) && mj_int(v, &n)) g->you_x = (int) n;
    if (mj_find(params, "y", &v) && mj_int(v, &n)) g->you_y = (int) n;
    g->have_you = 1;
    if (g->you_x >= 0 && g->you_x < MAP_W && g->you_y >= 0 && g->you_y < MAP_H &&
        mj_find(params, "hereCmap", &v) && mj_int(v, &n))
        g->terrain[g->you_y][g->you_x] = (unsigned char) terrain_from_cmap((int) n);
    g->structured_perception = 1;
    if (mj_find(params, "perceptionVersion", &v) && mj_int(v, &n) && n >= 1 && n <= 16)
        g->structured_perception = (int) n;
    g->perception_fresh = 1;
    for (i = 0; i < g->ninv; i++) free(g->inv[i].label);
    free(g->inv); g->inv = NULL; g->ninv = 0;
    for (i = 0; i < g->nfloor; i++) free(g->floor[i].label);
    free(g->floor); g->floor = NULL; g->nfloor = 0;
    for (which = 0; which < 2; which++) {
        mj_arr_it it = { 0 };
        char *array;
        const char *raw;
        size_t len;
        if (!mj_find(params, which ? "floor" : "inventory", &v)) continue;
        raw = mj_raw(v, &len); array = strndup(raw, len);
        if (!array) continue;
        it.first = 1;
        while (mj_arr_next(array, &it, &el)) {
            char *obj, *name = NULL, *category = NULL;
            long long id = 0, slot = 0, quantity = 1;
            raw = mj_raw(el, &len); obj = strndup(raw, len);
            if (!obj) break;
            if (mj_find(obj, "id", &v)) mj_int(v, &id);
            if (mj_find(obj, "slot", &v)) mj_int(v, &slot);
            if (mj_find(obj, "quantity", &v)) mj_int(v, &quantity);
            if (mj_find(obj, "label", &v)) name = mj_str(v);
            if (mj_find(obj, "class", &v)) category = mj_str(v);
            if (which) {
                floor_item_t *items = realloc(g->floor, (g->nfloor + 1) * sizeof *items);
                if (items) {
                    floor_item_t *item;
                    g->floor = items; item = &g->floor[g->nfloor++];
                    memset(item, 0, sizeof *item);
                    snprintf(item->ref, sizeof item->ref, "ground-%lld", id);
                    snprintf(item->category, sizeof item->category, "%s", category ? category : "object");
                    item->label = name; name = NULL;
                    item->quantity = (int) quantity;
                    item->object_id = id;
                }
            } else {
                inv_item_t *items = realloc(g->inv, (g->ninv + 1) * sizeof *items);
                if (items) {
                    inv_item_t *item;
                    g->inv = items; item = &g->inv[g->ninv++];
                    memset(item, 0, sizeof *item);
                    snprintf(item->ref, sizeof item->ref, "item-%lld", id);
                    snprintf(item->category, sizeof item->category, "%s", category ? category : "object");
                    item->label = name; name = NULL;
                    item->letter = (char) slot;
                    item->quantity = (int) quantity;
                    if (mj_find(obj, "armorAccessible", &v))
                        item->armor_access_known = mj_bool(v, &item->armor_accessible);
                    if (mj_find(obj, "usage", &v) && *v.p == '[') {
                        mj_arr_it uses = { 0 }; mj_val use; uses.first = 1;
                        item->usage_known = 1;
                        while (mj_arr_next(v.p, &uses, &use)) {
                            char *word = mj_str(use); size_t k;
                            for (k = 0; USAGE_NAMES[k]; k++)
                                if (word && !strcmp(word, USAGE_NAMES[k])) break;
                            if (!USAGE_NAMES[k]) item->usage_known = 0;
                            else item->usage |= 1U << k;
                            free(word);
                        }
                    }
                }
            }
            free(name); free(category); free(obj);
        }
        free(array);
    }
    g->inventory_rev = g->revision;
    g->floor_valid = known;
    g->floor_x = g->you_x; g->floor_y = g->you_y;
    snprintf(g->floor_level, sizeof g->floor_level, "%s", g->status[20] ? g->status[20] : "");
}

/* Parse one engine notification into tracked state. */
static void
ingest(game_t *g, const char *line)
{
    mj_val method_v, params_v;
    char *method = NULL;
    const char *params = "{}";
    char *owned_params = NULL;
    if (!mj_find(line, "method", &method_v))
        return;
    method = mj_str(method_v);
    if (!method)
        return;
    if (mj_find(line, "params", &params_v)) {
        size_t len;
        const char *raw = mj_raw(params_v, &len);
        owned_params = strndup(raw, len);
        if (owned_params) params = owned_params;
    }
    /* Post-mortem disclosure mutates known items and may redraw status.
     * Preserve the final gameplay perception during cold replay too. */
    if (g->terminal_kind[0] && (!strcmp(method, "perception") ||
        !strcmp(method, "snapshot") || !strcmp(method, "map_delta") ||
        !strcmp(method, "status_update") || !strcmp(method, "window_clear") ||
        !strcmp(method, "cursor"))) goto done;
    if (!strcmp(method, "perception")) {
        ingest_belongings(g, params);
    } else if (!strcmp(method, "snapshot") || !strcmp(method, "map_delta")) {
        mj_val cells_v, full_v;
        int full = 0;
        if (mj_find(params, "full", &full_v)) {
            int b;
            if (mj_bool(full_v, &b))
                full = b;
        }
        if (full) {
            memset(g->cells, 0, sizeof g->cells);
            memset(g->terrain, T_UNKNOWN, sizeof g->terrain);
        }
        if (mj_find(params, "cells", &cells_v)) {
            size_t len;
            const char *raw = mj_raw(cells_v, &len);
            char *cpy = malloc(len + 1);
            if (cpy) {
                mj_arr_it it;
                mj_val elt;
                memcpy(cpy, raw, len);
                cpy[len] = '\0';
                memset(&it, 0, sizeof it);
                it.first = 1;
                while (mj_arr_next(cpy, &it, &elt)) {
                    size_t elen;
                    const char *eraw = mj_raw(elt, &elen);
                    char *ecpy = malloc(elen + 1);
                    mj_val xv, yv;
                    long long x, y;
                    if (!ecpy)
                        break;
                    memcpy(ecpy, eraw, elen);
                    ecpy[elen] = '\0';
                    if (mj_find(ecpy, "x", &xv) && mj_int(xv, &x) &&
                        mj_find(ecpy, "y", &yv) && mj_int(yv, &y) &&
                        x >= 0 && x < MAP_W && y >= 0 && y < MAP_H) {
                        long long gg = 0, cc = 0, fc = 7;
                        mj_val gv2, cv2, fv2;
                        if (mj_find(ecpy, "glyph", &gv2))
                            mj_int(gv2, &gg);
                        if (mj_find(ecpy, "ttychar", &cv2))
                            mj_int(cv2, &cc);
                        if (mj_find(ecpy, "framecolor", &fv2))
                            mj_int(fv2, &fc);
                        g->cells[y][x].present = 1;
                        g->cells[y][x].glyph = (int) gg;
                        g->cells[y][x].ch = (int) cc;
                        g->cells[y][x].color = (int) fc;
                        {
                            mj_val tv;
                            long long symbol = -1, background = -1;
                            if (mj_find(ecpy, "cmap", &tv)) mj_int(tv, &symbol);
                            if (mj_find(ecpy, "backgroundCmap", &tv)) mj_int(tv, &background);
                            if (symbol >= 0)
                                g->terrain[y][x] = (unsigned char) terrain_from_cmap((int) symbol);
                            else if (background >= 0)
                                g->terrain[y][x] = (unsigned char) terrain_from_cmap((int) background);
                            else if (gg >= CMAP_LO && gg < STRANGE_LO) {
                                /* Legacy ports omit cmap. Decode their observed
                                 * glyph using the same vendored display.h layout,
                                 * not ambiguous display marks such as | and -. */
                                int legacy = gg == CMAP_LO ? 0 :
                                    gg < CMAP_LO + 56 ? 1 + ((int) gg - CMAP_LO - 1) % 11 :
                                    gg < CMAP_LO + 77 ? 12 + ((int) gg - CMAP_LO - 56) :
                                    gg < CMAP_LO + 82 ? 33 : 34 + ((int) gg - CMAP_LO - 82);
                                g->terrain[y][x] = (unsigned char) terrain_from_cmap(legacy);
                            }
                        }
                        if (gg >= NO_GLYPH_NUM - 2) {
                            g->cells[y][x].present = 0;
                            g->terrain[y][x] = T_UNKNOWN;
                        }
                        push_saw(g, (int) x, (int) y, (int) gg, (int) cc, (int) fc);
                    }
                    free(ecpy);
                }
                free(cpy);
            }
        }
    } else if (!strcmp(method, "status_update")) {
        mj_val fv, vv;
        long long f;
        char *value;
        if (mj_find(params, "field", &fv) && mj_int(fv, &f) && f == 22 &&
            mj_find(params, "condition", &vv)) {
            long long bits = 0;
            char text[32];
            mj_int(vv, &bits);
            snprintf(text, sizeof text, "%lld", bits);
            free(g->status[22]); g->status[22] = strdup(text);
            push_felt(g, "condition", text);
        } else if (mj_find(params, "field", &fv) && mj_int(fv, &f) &&
            f >= 0 && f < NSTATUS && mj_find(params, "value", &vv) &&
            (value = mj_str(vv)) != NULL) {
            free(g->status[f]);
            g->status[f] = value;
            if (f != 26)
                push_felt(g, VITAL_NAMES[f], value);
        }
    } else if (!strcmp(method, "message")) {
        mj_val tv;
        char *text;
        if (mj_find(params, "text", &tv) && (text = mj_str(tv)) != NULL) {
            free(g->messages[(g->msg_start + g->msg_count) % NMSG]);
            g->messages[(g->msg_start + g->msg_count) % NMSG] = text;
            if (g->msg_count < NMSG) {
                g->msg_count++;
            } else {
                g->msg_start = (g->msg_start + 1) % NMSG;
            }
            push_heard(g, text);
            /* Narration is not authoritative evidence of a terminal state. */
        }
    } else if (!strcmp(method, "menu_start")) {
        mj_val wv;
        long long w;
        if (mj_find(params, "window", &wv) && mj_int(wv, &w)) {
            menu_t *m = menu_for(g, (int) w, 1);
            if (m) {
                menu_clear(m);
                m->used = 1;
                m->window = (int) w;
            }
        }
    } else if (!strcmp(method, "menu_item")) {
        mj_val wv, iv, av, tv, gv;
        long long w, idx, accel = 0, glyph = NO_GLYPH_NUM;
        char *text = NULL;
        menu_t *m;
        if (!mj_find(params, "window", &wv) || !mj_int(wv, &w))
            goto done;
        if (!mj_find(params, "index", &iv) || !mj_int(iv, &idx))
            goto done;
        m = menu_for(g, (int) w, 1);
        if (!m)
            goto done;
        if (mj_find(params, "accel", &av))
            mj_int(av, &accel);
        if (mj_find(params, "text", &tv))
            text = mj_str(tv);
        if (mj_find(params, "glyph", &gv)) {
            /* menu rows carry glyph as a number or as an object
             * {"glyph":N,...}; map cells use the number form. */
            long long gg;
            if (mj_int(gv, &gg)) {
                glyph = gg;
            } else {
                size_t glen;
                const char *graw = mj_raw(gv, &glen);
                if (graw && glen > 2 && glen < 512) {
                    char gbuf[512];
                    mj_val inner;
                    memcpy(gbuf, graw, glen);
                    gbuf[glen] = '\0';
                    if (mj_find(gbuf, "glyph", &inner) &&
                        mj_int(inner, &gg))
                        glyph = gg;
                }
            }
        }
        if (m->nitems == m->cap) {
            size_t nc = m->cap ? m->cap * 2 : 16;
            menu_item_t *nb = realloc(m->items, nc * sizeof *nb);
            if (!nb) {
                free(text);
                goto done;
            }
            m->items = nb;
            m->cap = nc;
        }
        m->items[m->nitems].index = (int) idx;
        m->items[m->nitems].accel = (int) accel;
        m->items[m->nitems].glyph = (int) glyph;
        m->items[m->nitems].selectable = -1;
        m->items[m->nitems].object_id = 0;
        if (mj_find(params, "selectable", &av))
            mj_bool(av, &m->items[m->nitems].selectable);
        m->items[m->nitems].text = text ? text : strdup("");
        m->nitems++;
    } else if (!strcmp(method, "menu_object")) {
        mj_val v; long long w, idx, object; size_t k;
        menu_t *m;
        if (!mj_find(params, "window", &v) || !mj_int(v, &w) ||
            !mj_find(params, "index", &v) || !mj_int(v, &idx) ||
            !mj_find(params, "objectId", &v) || !mj_int(v, &object) || object <= 0 || object > 4294967295LL)
            goto done;
        m = menu_for(g, (int) w, 0);
        if (m) for (k = 0; k < m->nitems; k++)
            if (m->items[k].index == idx && menu_selectable(&m->items[k]))
                m->items[k].object_id = object;
    } else if (!strcmp(method, "menu_end")) {
        mj_val wv, pv;
        long long w;
        char *prompt = NULL;
        menu_t *m;
        if (!mj_find(params, "window", &wv) || !mj_int(wv, &w))
            goto done;
        m = menu_for(g, (int) w, 0);
        if (!m)
            goto done;
        if (mj_find(params, "prompt", &pv))
            prompt = mj_str(pv);
        free(m->prompt);
        m->prompt = prompt ? prompt : strdup("");
    } else if (!strcmp(method, "action_result")) {
        mj_val av, sv, tv;
        char *action = NULL, *status = NULL;
        long long turn;
        if (mj_find(params, "action", &av)) action = mj_str(av);
        if (mj_find(params, "status", &sv)) status = mj_str(sv);
        if (action && status && mj_find(params, "turn", &tv) && mj_int(tv, &turn) &&
            (!strcmp(status, "completed") || !strcmp(status, "interrupted"))) {
            mj_Buf b;
            mj_init(&b); mj_obj(&b);
            mj_key(&b, "type"); mj_strv(&b, "actionResult");
            mj_key(&b, "action"); mj_strv(&b, action);
            mj_key(&b, "status"); mj_strv(&b, status);
            mj_key(&b, "turn"); mj_intv(&b, turn);
            mj_endobj(&b);
            if (b.ok) push_event(g, b.buf);
            mj_free(&b);
        }
        free(action); free(status);
    } else if (!strcmp(method, "game_ended") && !g->terminal_kind[0]) {
        mj_val kv, cv, tv, hv;
        char *kind = NULL, *cause = NULL;
        long long turn, hp;
        if (mj_find(params, "kind", &kv)) kind = mj_str(kv);
        if (mj_find(params, "cause", &cv)) cause = mj_str(cv);
        if (kind && cause && mj_find(params, "turn", &tv) && mj_int(tv, &turn) && turn >= 0 &&
            mj_find(params, "health", &hv) && mj_int(hv, &hp) &&
            (!strcmp(kind, "death") || !strcmp(kind, "quit") ||
             !strcmp(kind, "escaped") || !strcmp(kind, "ascended") || !strcmp(kind, "engineError"))) {
            char number[32];
            mj_Buf b;
            snprintf(g->terminal_kind, sizeof g->terminal_kind, "%s", kind);
            snprintf(g->terminal_cause, sizeof g->terminal_cause, "%s", cause);
            g->terminal_turn = turn;
            snprintf(number, sizeof number, "%lld", hp);
            free(g->status[18]); g->status[18] = strdup(number);
            push_felt(g, VITAL_NAMES[18], number);
            snprintf(number, sizeof number, "%lld", turn);
            free(g->status[16]); g->status[16] = strdup(number);
            push_felt(g, VITAL_NAMES[16], number);
            mj_init(&b); mj_obj(&b);
            mj_key(&b, "type"); mj_strv(&b, "ended");
            mj_key(&b, "kind"); mj_strv(&b, kind);
            mj_key(&b, "cause"); mj_strv(&b, cause);
            mj_key(&b, "turn"); mj_intv(&b, turn);
            mj_endobj(&b);
            if (b.ok) push_event(g, b.buf);
            mj_free(&b);
        }
        free(kind); free(cause);
    } else if (!strcmp(method, "session_ended")) {
        mj_val rv;
        char *reason = NULL;
        g->ended = 1;
        if (mj_find(params, "reason", &rv))
            reason = mj_str(rv);
        snprintf(g->end_reason, sizeof g->end_reason, "%s",
                 reason ? reason : "");
        {
            char *msg = malloc(64 + (reason ? strlen(reason) : 0));
            if (msg) {
                snprintf(msg, 64 + (reason ? strlen(reason) : 0),
                         "-- session ended: %s --", reason ? reason : "?");
                free(g->messages[(g->msg_start + g->msg_count) % NMSG]);
                g->messages[(g->msg_start + g->msg_count) % NMSG] = msg;
                if (g->msg_count < NMSG) {
                    g->msg_count++;
                } else {
                    g->msg_start = (g->msg_start + 1) % NMSG;
                }
                push_heard(g, msg);
            }
        }
        free(reason);
    } else if (!strcmp(method, "window_create")) {
        mj_val tv, wv;
        long long t, w;
        if (mj_find(params, "type", &tv) && mj_int(tv, &t) && t == 3 &&
            mj_find(params, "window", &wv) && mj_int(wv, &w))
            g->map_win = (int) w;
    } else if (!strcmp(method, "window_clear")) {
        mj_val wv;
        long long w;
        if (mj_find(params, "window", &wv) && mj_int(wv, &w) && w == g->map_win) {
            memset(g->cells, 0, sizeof g->cells);
            memset(g->terrain, T_UNKNOWN, sizeof g->terrain);
        }
    } else if (!strcmp(method, "cursor")) {
        mj_val wv, xv, yv;
        long long w, x, y;
        if (mj_find(params, "window", &wv) && mj_int(wv, &w) && w == g->map_win &&
            mj_find(params, "x", &xv) && mj_int(xv, &x) &&
            mj_find(params, "y", &yv) && mj_int(yv, &y)) {
            g->you_x = (int) x;
            g->you_y = (int) y;
            g->have_you = 1;
        }
    }
done:
    free(owned_params);
    free(method);
}

/* ---------------- driver ---------------- */

static void
pending_clear(game_t *g)
{
    size_t i;
    free(g->pending.prompt);
    free(g->pending.choices);
    for (i = 0; i < g->pending.ncommands; i++)
        free(g->pending.commands[i]);
    free(g->pending.commands);
    memset(&g->pending, 0, sizeof g->pending);
}

static int
send_engine(game_t *g, const char *line)
{
    if (g->sidecar_corrupt || g->sidecar_error[0] || g->input_error[0] || g->recovery_required) { errno = EIO; return -1; }
    if (log_append(g, line) < 0)
        return -1;
    if (!g->terminal_kind[0]) g->perception_fresh = 0;
    return nh_session_write(g->eng, line);
}

/* Raw write: replay feeds and deterministic persist answers bypass the log. */
static int
send_raw(game_t *g, const char *line)
{
    if (!g->terminal_kind[0]) g->perception_fresh = 0;
    return nh_session_write(g->eng, line);
}

static void
blob_path(game_t *g, const char *key, char *out, size_t cap)
{
    size_t i;
    char safe[256];
    /* keys are engine-chosen; sanitize to [A-Za-z0-9_.-] */
    for (i = 0; i < sizeof safe - 1 && key[i]; i++) {
        char c = key[i];
        safe[i] = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.' ? c : '_';
    }
    safe[i] = '\0';
    snprintf(out, cap, "%s/blobs/%s", g->dir, safe);
}

/* base64 (persist blobs are binary save data, base64 on the wire). */
static const char B64A[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static char *
b64enc(const unsigned char *in, size_t n)
{
    char *out = malloc((n + 2) / 3 * 4 + 1);
    size_t i, o = 0;
    if (!out)
        return NULL;
    for (i = 0; i < n; i += 3) {
        unsigned v = (unsigned) in[i] << 16;
        int rem = (int) (n - i);
        if (rem > 1)
            v |= (unsigned) in[i + 1] << 8;
        if (rem > 2)
            v |= in[i + 2];
        out[o++] = B64A[(v >> 18) & 63];
        out[o++] = B64A[(v >> 12) & 63];
        out[o++] = rem > 1 ? B64A[(v >> 6) & 63] : '=';
        out[o++] = rem > 2 ? B64A[v & 63] : '=';
    }
    out[o] = '\0';
    return out;
}

static int
b64val(char c)
{
    if (c >= 'A' && c <= 'Z')
        return c - 'A';
    if (c >= 'a' && c <= 'z')
        return 26 + c - 'a';
    if (c >= '0' && c <= '9')
        return 52 + c - '0';
    if (c == '+')
        return 62;
    if (c == '/')
        return 63;
    return -1;
}

static unsigned char *
b64dec(const char *s, size_t *n_out)
{
    size_t n = strlen(s), i, o = 0;
    unsigned char *out;
    if (n % 4)
        return NULL;
    out = malloc(n / 4 * 3 + 1);
    if (!out)
        return NULL;
    for (i = 0; i < n; i += 4) {
        int a = b64val(s[i]), b = b64val(s[i + 1]);
        int c = s[i + 2] == '=' ? 0 : b64val(s[i + 2]);
        int d = s[i + 3] == '=' ? 0 : b64val(s[i + 3]);
        if (a < 0 || b < 0 || c < 0 || d < 0) {
            free(out);
            return NULL;
        }
        out[o++] = (unsigned char) ((a << 2) | (b >> 4));
        if (s[i + 2] != '=')
            out[o++] = (unsigned char) ((b << 4) | (c >> 2));
        if (s[i + 3] != '=')
            out[o++] = (unsigned char) ((c << 6) | d);
    }
    *n_out = o;
    return out;
}

/* Blob keys are engine-chosen: [A-Za-z0-9_.-]{1,128}. */
static int
valid_blob_key(const char *key)
{
    size_t i, n;
    if (!key)
        return 0;
    n = strlen(key);
    if (n == 0 || n > 128)
        return 0;
    for (i = 0; i < n; i++) {
        char c = key[i];
        if (!(c >= 'A' && c <= 'Z') && !(c >= 'a' && c <= 'z') &&
            !(c >= '0' && c <= '9') && c != '_' && c != '-' && c != '.')
            return 0;
    }
    return 1;
}

static void
persist_error(game_t *g, long long id, const char *msg)
{
    char line[512];
    mj_Buf b;
    mj_init(&b);
    mj_obj(&b);
    mj_key(&b, "message");
    mj_strv(&b, msg);
    mj_endobj(&b);
    snprintf(line, sizeof line,
             "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"error\":{\"code\":-32000,\"message\":%s}}",
             id, b.ok && b.buf ? b.buf : "\"error\"");
    mj_free(&b);
    send_raw(g, line);
}

/* Serve persist_* engine calls from disk (deterministic: never logged).
 * Wire shapes mirror bun_server/src/store.ts exactly. */
static void
serve_persist(game_t *g, long long id, const char *method, const char *params)
{
    mj_val kv, dv;
    char *key = NULL;
    if (mj_find(params, "key", &kv))
        key = mj_str(kv);
    if (!strcmp(method, "persist_put") || !strcmp(method, "persist_get")) {
        if (!valid_blob_key(key)) {
            persist_error(g, id, "bad blob key");
            free(key);
            return;
        }
    }
    if (!strcmp(method, "persist_put")) {
        char *b64 = NULL;
        char path[PATH_MAX], bd[PATH_MAX];
        FILE *f;
        if (mj_find(params, "data", &dv))
            b64 = mj_str(dv);
        if (b64) {
            size_t n;
            unsigned char *raw = b64dec(b64, &n);
            if (raw) {
                blob_path(g, key, path, sizeof path);
                snprintf(bd, sizeof bd, "%s/blobs", g->dir);
                mkdir_p(bd);
                f = fopen(path, "wb");
                if (f) {
                    fwrite(raw, 1, n, f);
                    fclose(f);
                }
                free(raw);
            }
        }
        free(b64);
        free(key);
        {
            char line[128];
            snprintf(line, sizeof line,
                     "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"ok\":true}}", id);
            send_raw(g, line);
        }
    } else if (!strcmp(method, "persist_get")) {
        char path[PATH_MAX];
        FILE *f = NULL;
        long size = 0;
        blob_path(g, key, path, sizeof path);
        f = fopen(path, "rb");
        if (f) {
            fseek(f, 0, SEEK_END);
            size = ftell(f);
            fseek(f, 0, SEEK_SET);
            if (size <= 0 || size >= (1 << 20)) {
                fclose(f);
                f = NULL;
            }
        }
        {
            mj_Buf b;
            char line[1 << 20];
            mj_init(&b);
            mj_obj(&b);
            mj_key(&b, "key");
            mj_strv(&b, key ? key : "");
            mj_key(&b, "data");
            if (f) {
                unsigned char *raw = malloc((size_t) size);
                char *enc = NULL;
                if (raw && fread(raw, 1, (size_t) size, f) == (size_t) size)
                    enc = b64enc(raw, (size_t) size);
                free(raw);
                fclose(f);
                if (enc) {
                    mj_strv(&b, enc);
                    free(enc);
                } else {
                    mj_nullv(&b);
                }
            } else {
                mj_nullv(&b);
            }
            mj_endobj(&b);
            snprintf(line, sizeof line,
                     "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":%s}",
                     id, b.ok && b.buf ? b.buf : "{}");
            mj_free(&b);
            free(key);
            send_raw(g, line);
        }
    } else if (!strcmp(method, "persist_list")) {
        char bd[PATH_MAX];
        DIR *d;
        mj_Buf b;
        char line[65536];
        snprintf(bd, sizeof bd, "%s/blobs", g->dir);
        mj_init(&b);
        mj_obj(&b);
        mj_key(&b, "keys");
        mj_arr(&b);
        d = opendir(bd);
        if (d) {
            struct dirent *e;
            while ((e = readdir(d)) != NULL) {
                if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, ".."))
                    continue;
                mj_strv(&b, e->d_name);
            }
            closedir(d);
        }
        mj_endarr(&b);
        mj_endobj(&b);
        snprintf(line, sizeof line,
                 "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":%s}",
                 id, b.ok && b.buf ? b.buf : "{\"keys\":[]}");
        mj_free(&b);
        free(key);
        send_raw(g, line);
    }
}

/* Answer narration pauses and display-only lists without bothering the
 * client; their content is already in the event stream. Suspended while
 * replaying (stored answers feed lockstep instead). Returns 1 when the
 * request was consumed here. */
static int
auto_answer(game_t *g, long long id, const char *kind, const char *params)
{
    char line[1024];
    if (g->replaying)
        return 0;
    if (!strcmp(kind, "ack") || !strcmp(kind, "msgmenu")) {
        snprintf(line, sizeof line,
                 "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{}}", id);
        return send_engine(g, line) < 0 ? -1 : 1;
    }
    if (!strcmp(kind, "menu")) {
        mj_val hv, wv;
        long long how = -1, w = -1;
        if (mj_find(params, "how", &hv))
            mj_int(hv, &how);
        if (how != 0)
            return 0;
        if (mj_find(params, "window", &wv))
            mj_int(wv, &w);
        {
            /* shown event: include the list content, then dismiss */
            menu_t *m = w >= 0 ? menu_for(g, (int) w, 0) : NULL;
            mj_Buf b;
            size_t i;
            mj_init(&b);
            mj_obj(&b);
            mj_key(&b, "type");
            mj_strv(&b, "shown");
            mj_key(&b, "about");
            mj_strv(&b, (m && m->prompt) ? m->prompt : "");
            mj_key(&b, "items");
            mj_arr(&b);
            if (m)
                for (i = 0; i < m->nitems; i++)
                    mj_strv(&b, m->items[i].text ? m->items[i].text : "");
            mj_endarr(&b);
            mj_endobj(&b);
            if (b.ok)
                push_event(g, b.buf);
            mj_free(&b);
            if (m) {
                menu_clear(m);
                m->used = 0;
            }
        }
        snprintf(line, sizeof line,
                 "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"picks\":[],\"counts\":[]}}",
                 id);
        return send_engine(g, line) < 0 ? -1 : 1;
    }
    return 0;
}

/* Fill pending from an input request's params. */
static void
pending_fill(game_t *g, long long id, const char *kind, const char *params)
{
    mj_val v;
    char *s;
    pending_clear(g);
    g->pending.waiting = 1;
    g->pending.id = id;
    snprintf(g->pending.kind, sizeof g->pending.kind, "%s", kind);
    if (mj_find(params, "prompt", &v) && (s = mj_str(v)) != NULL)
        g->pending.prompt = s;
    if (!strcmp(kind, "menu")) {
        long long w = -1, how = -1;
        if (mj_find(params, "window", &v))
            mj_int(v, &w);
        if (mj_find(params, "how", &v))
            mj_int(v, &how);
        g->pending.window = (int) w;
        g->pending.how = (int) how;
    } else if (!strcmp(kind, "yn")) {
        if (mj_find(params, "choices", &v) && (s = mj_str(v)) != NULL)
            g->pending.choices = s;
        else
            g->pending.choices = strdup("");
        if (mj_find(params, "default", &v)) {
            long long d;
            if (mj_int(v, &d))
                g->pending.def = (int) d;
        }
    } else if (!strcmp(kind, "extcmd")) {
        if (mj_find(params, "commands", &v)) {
            size_t len;
            const char *raw = mj_raw(v, &len);
            char *cpy = malloc(len + 1);
            if (cpy) {
                mj_arr_it it;
                mj_val elt;
                memcpy(cpy, raw, len);
                cpy[len] = '\0';
                memset(&it, 0, sizeof it);
                it.first = 1;
                while (mj_arr_next(cpy, &it, &elt)) {
                    char *cs = mj_str(elt);
                    if (!cs)
                        continue;
                    g->pending.commands = realloc(g->pending.commands,
                        (g->pending.ncommands + 1) * sizeof *g->pending.commands);
                    if (!g->pending.commands) {
                        free(cs);
                        break;
                    }
                    g->pending.commands[g->pending.ncommands++] = cs;
                }
                free(cpy);
            }
        }
    }
}

/* Read+ingest until an input request is pending (1), the engine ends (0),
 * or the timeout/error hits (-1). Auto-answers narration pauses inline. */
static long long
monotonic_ms(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (long long) t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static int
await_prompt(game_t *g, int timeout_ms)
{
    for (;;) {
        int remaining = timeout_ms;
        char *line;
        if (g->deadline_ms) {
            long long left = g->deadline_ms - monotonic_ms();
            if (left <= 0) { errno = ETIMEDOUT; return -1; }
            if (remaining < 0 || left < remaining) remaining = (int) left;
        }
        line = nh_session_read_line(g->eng, remaining);
        mj_val mv, idv, kv, pv;
        char *method = NULL;
        long long id = -1;
        if (!line) {
            if (nh_session_ended(g->eng)) {
                if (!g->ended && !g->terminal_kind[0])
                    snprintf(g->end_reason, sizeof g->end_reason, "engineError");
                g->ended = 1;
                return 0;
            }
            return -1;
        }
        if (mj_find(line, "method", &mv) && (method = mj_str(mv)) != NULL) {
            if (!strncmp(method, "persist_", 8)) {
                const char *params = "{}";
                if (mj_find(line, "id", &idv))
                    mj_int(idv, &id);
                if (mj_find(line, "params", &pv)) {
                    static char pbuf[65536];
                    size_t len;
                    const char *raw = mj_raw(pv, &len);
                    if (len < sizeof pbuf) {
                        memcpy(pbuf, raw, len);
                        pbuf[len] = '\0';
                        params = pbuf;
                    }
                }
                serve_persist(g, id, method, params);
                free(method);
                free(line);
                continue;
            }
            /* input request = method "input" with numeric id */
            if (!strcmp(method, "input") && mj_find(line, "id", &idv) &&
                mj_int(idv, &id)) {
                char kind[16] = "?";
                const char *params = "{}";
                if (mj_find(line, "params", &pv)) {
                    static char pbuf[65536];
                    size_t len;
                    const char *raw = mj_raw(pv, &len);
                    if (len < sizeof pbuf) {
                        memcpy(pbuf, raw, len);
                        pbuf[len] = '\0';
                        params = pbuf;
                    }
                    {
                        mj_val kv2;
                        char *ks = NULL;
                        if (mj_find(params, "kind", &kv2) && (ks = mj_str(kv2)) != NULL) {
                            snprintf(kind, sizeof kind, "%s", ks);
                            free(ks);
                        }
                    }
                }
                (void) kv;
                {
                    int automatic = auto_answer(g, id, kind, params);
                    if (automatic) {
                        free(method); free(line);
                        if (automatic < 0) return -1;
                        continue;
                    }
                }
                pending_fill(g, id, kind, params);
                free(method);
                free(line);
                return 1;
            }
            ingest(g, line);
            free(method);
            free(line);
            /* Life saving has already been ruled out. Optional post-game
             * disclosures need no invented answers; teardown closes the UI.
             * Historical answers still replay verbatim. */
            if (g->terminal_kind[0] && !g->replaying) {
                g->ended = 1;
                pending_clear(g);
                return 0;
            }
            continue;
        }
        free(line);
    }
}

/* ---------------- identity (engine order, upstream/src/role.c) ---------------- */

static const char *const ROLES[] = {
    "archeologist", "barbarian", "caveman", "healer", "knight",
    "monk", "priest", "rogue", "ranger", "samurai", "tourist",
    "valkyrie", "wizard",
};
static const char *const RACES[] = { "human", "elf", "dwarf", "gnome", "orc" };
static const char *const GENDERS[] = { "male", "female" };
static const char *const ALIGNS[] = { "lawful", "neutral", "chaotic" };

static int
name_index(const char *const *list, size_t n, const char *v)
{
    size_t i;
    char low[64], *p;
    if (!v)
        return -1;
    snprintf(low, sizeof low, "%s", v);
    for (p = low; *p; p++)
        *p = (char) tolower((unsigned char) *p);
    if (list == ALIGNS) {
        if (!strcmp(low, "law"))
            return 0;
        if (!strcmp(low, "balance"))
            return 1;
        if (!strcmp(low, "chaos"))
            return 2;
    }
    for (i = 0; i < n; i++)
        if (!strcmp(low, list[i]))
            return (int) i;
    return -1;
}

/* ---------------- lifecycle ---------------- */

struct nhx *
nhx_open(const char *engine_bin, const char *template_dir,
         const char *sessions_dir)
{
    nhx_t *x = calloc(1, sizeof *x);
    if (!x)
        return NULL;
    if (!engine_bin || !template_dir || !sessions_dir ||
        access(engine_bin, X_OK) != 0 || access(template_dir, R_OK) != 0 ||
        mkdir_p(sessions_dir) < 0) {
        free(x);
        errno = EINVAL;
        return NULL;
    }
    snprintf(x->engine_bin, sizeof x->engine_bin, "%s", engine_bin);
    snprintf(x->template_dir, sizeof x->template_dir, "%s", template_dir);
    snprintf(x->sessions_dir, sizeof x->sessions_dir, "%s", sessions_dir);
    /* Parity with the MCP server: skip the interactive tutorial prompt and
     * enable the in-game clock unless the caller chose its own options. */
    if (!getenv("NETHACKOPTIONS"))
        setenv("NETHACKOPTIONS", "!tutorial,time", 1);
    return x;
}

static void
game_free(game_t *g)
{
    size_t i;
    req_entry_t *e;
    if (g->eng) {
        if (!g->recording_only && (g->recovery_required || (g->pending.waiting &&
            (g->operation.decision_id[0] || (strcmp(g->pending.kind, "key") && strcmp(g->pending.kind, "poskey"))))))
            nh_session_abort(g->eng);
        else nh_session_close(g->eng);
    }
    lease_release(g);
    for (i = 0; i < NSTATUS; i++)
        free(g->status[i]);
    for (i = 0; i < NMSG; i++)
        free(g->messages[i]);
    for (i = 0; i < MAX_MENU_WINDOWS; i++)
        if (g->menus[i].used)
            menu_clear(&g->menus[i]);
    pending_clear(g);
    for (i = 0; i < g->nevents; i++)
        free(g->events[i].json);
    free(g->events);
    while ((e = g->requests) != NULL) {
        g->requests = e->next;
        free(e->rid);
        free(e->args_key);
        free(e->result);
        free(e);
    }
    for (i = 0; i < g->ninv; i++)
        free(g->inv[i].label);
    free(g->inv);
    for (i = 0; i < 128; i++)
        free(g->inv_label_by_letter[i]);
    for (i = 0; i < g->nfloor; i++)
        free(g->floor[i].label);
    free(g->floor);
    free(g);
}

void
nhx_close(nhx_t *x)
{
    game_t *g;
    if (!x)
        return;
    while ((g = x->games) != NULL) {
        x->games = g->next;
        game_free(g);
    }
    free(x);
}

void
nhx_free(char *s)
{
    free(s);
}

static game_t *
game_get(nhx_t *x, const char *id, int create)
{
    game_t *g;
    if (!valid_id(id))
        return NULL;
    for (g = x->games; g; g = g->next)
        if (!strcmp(g->id, id))
            return g;
    if (!create)
        return NULL;
    g = calloc(1, sizeof *g);
    if (!g)
        return NULL;
    snprintf(g->id, sizeof g->id, "%s", id);
    snprintf(g->dir, sizeof g->dir, "%s/%s", x->sessions_dir, id);
    snprintf(g->playground, sizeof g->playground, "%s/playground", g->dir);
    if (mkdir_p(g->dir) < 0) {
        free(g);
        return NULL;
    }
    {
        struct stat st;
        if (lstat(g->dir, &st) || !S_ISDIR(st.st_mode)) { free(g); return NULL; }
    }
    g->map_win = -1;
    g->lease_fd = -1;
    g->inventory_rev = -1;
    g->next_decision = 1;
    g->next_ref = 1;
    g->sidecar_input_bytes = -1; g->boundary_complete = 1;
    sidecar_load(g);
    g->next = x->games;
    x->games = g;
    return g;
}

/* Pin the exact engine executable used by a run. Existing sessions without
 * a pin inherit their original playground copy before it is cleaned. A
 * content-addressed cache avoids copying 12 MB per run. FNV is a cache key,
 * not an authentication primitive; the cache is local trusted storage. */
static int
pin_engine(nhx_t *x, game_t *g, char *pinned, size_t cap)
{
    char source[PATH_MAX], cache_dir[PATH_MAX], cached[PATH_MAX], temp[PATH_MAX];
    uint64_t hash = UINT64_C(14695981039346656037);
    unsigned char buf[65536];
    FILE *in, *out;
    size_t n, i;
    if (snprintf(pinned, cap, "%s/engine", g->dir) >= (int) cap) return -1;
    if (access(pinned, X_OK) == 0) return 0;
    if (snprintf(source, sizeof source, "%s/nethack", g->playground) >= (int) sizeof source) return -1;
    if (access(source, X_OK) != 0) snprintf(source, sizeof source, "%s", x->engine_bin);
    in = fopen(source, "rb");
    if (!in) return -1;
    while ((n = fread(buf, 1, sizeof buf, in)) > 0)
        for (i = 0; i < n; i++) { hash ^= buf[i]; hash *= UINT64_C(1099511628211); }
    if (ferror(in)) { fclose(in); return -1; }
    rewind(in);
    if (snprintf(cache_dir, sizeof cache_dir, "%s/.engines", x->sessions_dir) >= (int) sizeof cache_dir || mkdir_p(cache_dir) < 0) { fclose(in); return -1; }
    if (snprintf(cached, sizeof cached, "%s/%016llx", cache_dir, (unsigned long long) hash) >= (int) sizeof cached) { fclose(in); return -1; }
    if (access(cached, X_OK) != 0) {
        if (snprintf(temp, sizeof temp, "%s.tmp-%ld", cached, (long) getpid()) >= (int) sizeof temp) { fclose(in); return -1; }
        out = fopen(temp, "wb");
        if (!out) { fclose(in); return -1; }
        while ((n = fread(buf, 1, sizeof buf, in)) > 0)
            if (fwrite(buf, 1, n, out) != n) { fclose(in); fclose(out); unlink(temp); return -1; }
        if (ferror(in) || fflush(out) || fchmod(fileno(out), 0700) || fsync(fileno(out))) { fclose(in); fclose(out); unlink(temp); return -1; }
        if (fclose(out) || rename(temp, cached)) { fclose(in); unlink(temp); return -1; }
    }
    fclose(in);
    if (link(cached, pinned) < 0 && errno != EEXIST) return -1;
    return 0;
}

/* Fresh engine on a fresh playground copy. */
static int
spawn_game(nhx_t *x, game_t *g)
{
    char pinned[PATH_MAX];
    if (g->lease_fd < 0) { errno = EPERM; return -1; }
    if (pin_engine(x, g, pinned, sizeof pinned) < 0) return -1;
    if (g->eng) {
        nh_session_close(g->eng);
        g->eng = NULL;
    }
    if (nftw(g->playground, rm_cb, 16, FTW_DEPTH | FTW_PHYS) < 0 && errno != ENOENT)
        return -1;
    if (copy_tree(x->template_dir, g->playground) < 0)
        return -1;
    g->eng = nh_session_start_with_lease(pinned, g->playground, NULL, g->lease_fd);
    return g->eng ? 0 : -1;
}

/* Clear tracked perception (resume rebuilds it from replay). */
static void
tracked_clear(game_t *g)
{
    size_t i;
    memset(g->cells, 0, sizeof g->cells);
    memset(g->terrain, T_UNKNOWN, sizeof g->terrain);
    for (i = 0; i < NSTATUS; i++) {
        free(g->status[i]);
        g->status[i] = NULL;
    }
    for (i = 0; i < NMSG; i++) {
        free(g->messages[i]);
        g->messages[i] = NULL;
    }
    g->msg_start = g->msg_count = 0;
    g->terminal_kind[0] = g->terminal_cause[0] = '\0';
    g->terminal_turn = 0;
    g->location_id[0] = '\0';
    g->structured_perception = 0;
    g->perception_fresh = 0;
    for (i = 0; i < MAX_MENU_WINDOWS; i++)
        if (g->menus[i].used) {
            menu_clear(&g->menus[i]);
            g->menus[i].used = 0;
        }
    pending_clear(g);
    for (i = 0; i < g->nevents; i++)
        free(g->events[i].json);
    g->nevents = 0;
    g->map_win = -1;
    g->have_you = 0;
    g->ended = 0;
    g->end_reason[0] = '\0';
    for (i = 0; i < g->ninv; i++)
        free(g->inv[i].label);
    free(g->inv);
    g->inv = NULL;
    g->ninv = 0;
    for (i = 0; i < g->nfloor; i++)
        free(g->floor[i].label);
    free(g->floor);
    g->floor = NULL;
    g->nfloor = 0;
    g->floor_valid = 0;
}

/* ---------------- observation ---------------- */

static int
turn_of(game_t *g)
{
    if (g->status[16]) {
        char *e;
        long n = strtol(g->status[16], &e, 10);
        if (e != g->status[16])
            return (int) n;
    }
    return 0;
}

static const char *const HUNGER_MAP[][2] = {
    { "satiated", "satiated" }, { "not hungry", "not_hungry" },
    { "hungry", "hungry" }, { "weak", "weak" },
    { "fainting", "fainting" }, { "fainted", "fainted" },
    { NULL, NULL },
};

static const char *const BURDEN_MAP[][2] = {
    { "unencumbered", "unencumbered" }, { "burdened", "burdened" },
    { "stressed", "stressed" }, { "strained", "strained" },
    { "overtaxed", "overtaxed" }, { "overloaded", "overloaded" },
    { NULL, NULL },
};

static void
emit_lower_map(mj_Buf *b, const char *sense, const char *v,
               const char *const map[][2])
{
    char low[64], *p;
    size_t i;
    snprintf(low, sizeof low, "%s", v);
    for (p = low; *p; p++)
        *p = (char) tolower((unsigned char) *p);
    mj_key(b, sense);
    for (i = 0; map[i][0]; i++)
        if (!strcmp(low, map[i][0])) {
            mj_strv(b, map[i][1]);
            return;
        }
    mj_strv(b, low);
}

/* condition bitmask to words (BL_MASK_* in upstream/include/botl.h). */
static void
emit_condition(mj_Buf *b, const char *v)
{
    static const struct {
        long bit;
        const char *word;
    } conds[] = {
        { 0x1, "bareHands" }, { 0x2, "blind" }, { 0x4, "busy" },
        { 0x8, "confused" }, { 0x10, "deaf" }, { 0x20, "elfInIron" },
        { 0x40, "flying" }, { 0x80, "foodPoisoned" },
        { 0x100, "glowingHands" }, { 0x200, "grabbed" },
        { 0x400, "hallucinating" }, { 0x800, "held" },
        { 0x1000, "onIce" }, { 0x2000, "inLava" },
        { 0x4000, "levitating" }, { 0x8000, "paralyzed" },
        { 0x10000, "riding" }, { 0x20000, "sleeping" },
        { 0x40000, "slimed" }, { 0x80000, "slippery" },
        { 0x100000, "petrifying" }, { 0x200000, "strangled" },
        { 0x400000, "stunned" }, { 0x800000, "submerged" },
        { 0x1000000, "terminallyIll" }, { 0x2000000, "tethered" },
        { 0x4000000, "trapped" }, { 0x8000000, "unconscious" },
        { 0x10000000, "limping" }, { 0x20000000, "grasping" },
    };
    char *e;
    long bits = strtol(v, &e, 10);
    size_t i;
    mj_key(b, "condition");
    if (e == v) {
        mj_strv(b, v);
        return;
    }
    mj_arr(b);
    if (bits) {
        for (i = 0; i < sizeof conds / sizeof conds[0]; i++)
            if (bits & conds[i].bit)
                mj_strv(b, conds[i].word);
    }
    mj_endarr(b);
}

static int
all_digits(const char *s)
{
    size_t i;
    if (!s || !*s)
        return 0;
    for (i = 0; s[i]; i++)
        if (s[i] < '0' || s[i] > '9')
            return 0;
    return 1;
}

static void
emit_vitals(game_t *g, mj_Buf *b)
{
    int f;
    mj_key(b, "vitals");
    mj_obj(b);
    for (f = 0; f < NSTATUS; f++) {
        const char *sense = VITAL_NAMES[f];
        const char *v = g->status[f];
        if (!v || !strcmp(sense, "version"))
            continue;
        if (!strcmp(sense, "hunger")) {
            emit_lower_map(b, sense, v, HUNGER_MAP);
        } else if (!strcmp(sense, "burden")) {
            emit_lower_map(b, sense, v, BURDEN_MAP);
        } else if (!strcmp(sense, "condition")) {
            emit_condition(b, v);
        } else if (!strcmp(sense, "depth")) {
            mj_key(b, sense);
            mj_strv(b, v[0] == 'D' && v[1] == 'l' ? v + 5 : v);
        } else if (!strcmp(sense, "gold") || !strcmp(sense, "energy") ||
            !strcmp(sense, "maxEnergy") || !strcmp(sense, "level") ||
            !strcmp(sense, "armor") || !strcmp(sense, "turn") ||
            !strcmp(sense, "health") || !strcmp(sense, "maxHealth") ||
            !strcmp(sense, "experience")) {
            mj_key(b, sense);
            if (all_digits(v))
                mj_intv(b, atoll(v));
            else
                mj_strv(b, v);
        } else {
            mj_key(b, sense);
            mj_strv(b, v);
        }
    }
    mj_endobj(b);
}

static void
emit_location(game_t *g, mj_Buf *b)
{
    const char *desc = g->status[20] ? g->status[20] : "unknown";
    char id[128], *w = id, *e = id + sizeof id - 1;
    const char *p;
    mj_key(b, "location");
    mj_obj(b);
    mj_key(b, "id");
    strcpy(id, "level-");
    w += 6;
    for (p = desc; *p && w < e; p++) {
        if ((*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9'))
            *w++ = *p;
        else if (*p >= 'A' && *p <= 'Z')
            *w++ = (char) (*p - 'A' + 'a');
        else if (w > id + 6 && w[-1] != '-')
            *w++ = '-';
    }
    while (w > id + 6 && w[-1] == '-')
        w--;
    *w = '\0';
    mj_strv(b, g->location_id[0] ? g->location_id : id);
    mj_key(b, "depthLabel");
    mj_strv(b, desc);
    mj_endobj(b);
}

static void
emit_world(game_t *g, mj_Buf *b)
{
    int x, y;
    mj_key(b, "world");
    mj_arr(b);
    for (y = 0; y < MAP_H; y++)
        for (x = 0; x < MAP_W; x++) {
            cell_t *c = &g->cells[y][x];
            int glyph, band;
            char mark[8];
            int is_you;
            if (!c->present || (!c->glyph && !c->ch))
                continue;
            glyph = c->glyph;
            if (glyph < ALLY_LO)
                band = 0;               /* creature */
            else if (glyph < INVIS_LO)
                band = 1;               /* ally */
            else if (glyph < BODY_LO)
                band = 0;
            else if (glyph < RIDDEN_LO)
                band = 2;               /* remains */
            else if (glyph < OBJ_LO)
                band = 0;
            else if (glyph < CMAP_LO)
                band = 3;               /* object */
            else if (glyph < STRANGE_LO)
                band = 4;               /* terrain */
            else if (glyph < EFFECT_LO)
                continue;               /* transient */
            else
                band = 3;
            if (c->ch >= 32 && c->ch < 127) {
                mark[0] = (char) c->ch;
                mark[1] = '\0';
            } else {
                snprintf(mark, sizeof mark, "\\u%04x", c->ch & 0xffff);
            }
            is_you = g->have_you && x == g->you_x && y == g->you_y;
            mj_obj(b);
            mj_key(b, "x"); mj_intv(b, x);
            mj_key(b, "y"); mj_intv(b, y);
            mj_key(b, "terrain"); mj_obj(b);
            mj_key(b, "type");
            mj_strv(b, TERRAIN_NAMES[g->terrain[y][x] <= T_BRIDGE ? g->terrain[y][x] : T_UNKNOWN]);
            mj_key(b, "knowledge"); mj_strv(b, "remembered");
            mj_endobj(b);
            if (is_you) {
                mj_key(b, "occupant"); mj_obj(b);
                mj_key(b, "kind"); mj_strv(b, "self");
                mj_key(b, "mark"); mj_strv(b, mark);
                mj_endobj(b);
            } else if (band == 0 || band == 1) {
                mj_key(b, "occupant"); mj_obj(b);
                mj_key(b, "kind"); mj_strv(b, band ? "ally" : "creature");
                mj_key(b, "mark"); mj_strv(b, mark);
                mj_key(b, "color"); mj_intv(b, c->color);
                mj_endobj(b);
            } else if (band == 2 || band == 3) {
                mj_key(b, "objects"); mj_arr(b);
                mj_obj(b);
                mj_key(b, "mark"); mj_strv(b, mark);
                mj_key(b, "color"); mj_intv(b, c->color);
                mj_endobj(b);
                mj_endarr(b);
            }
            mj_endobj(b);
        }
    mj_endarr(b);
}

static void
emit_inventory(game_t *g, mj_Buf *b)
{
    size_t i;
    mj_key(b, "inventory");
    mj_arr(b);
    for (i = 0; i < g->ninv; i++) {
        mj_obj(b);
        mj_key(b, "id"); mj_strv(b, g->inv[i].ref);
        mj_key(b, "label"); mj_strv(b, g->inv[i].label);
        mj_key(b, "location");
        mj_strv(b, g->inv[i].location ? "here" : "inventory");
        mj_key(b, "quantity"); mj_intv(b, g->inv[i].quantity);
        mj_key(b, "category"); mj_strv(b, g->inv[i].category[0] ? g->inv[i].category : "unknown");
        if (g->inv[i].usage_known) {
            size_t k;
            mj_key(b, "usage"); mj_arr(b);
            for (k = 0; USAGE_NAMES[k]; k++)
                if (g->inv[i].usage & (1U << k)) mj_strv(b, USAGE_NAMES[k]);
            mj_endarr(b);
        }
        mj_endobj(b);
    }
    mj_endarr(b);
    mj_key(b, "inventoryKnown");
    mj_boolv(b, g->inventory_rev >= 0);
    {
        int equipment_known = g->structured_perception >= 2 && g->inventory_rev >= 0;
        const char *freshness = g->perception_fresh ? "current" : "lastKnown";
        for (i = 0; i < g->ninv; i++) if (!g->inv[i].usage_known) equipment_known = 0;
        mj_key(b, "perception"); mj_obj(b);
        mj_key(b, "version"); mj_intv(b, g->structured_perception);
        mj_key(b, "inventory"); mj_strv(b, g->inventory_rev >= 0 ? freshness : "unknown");
        mj_key(b, "here"); mj_strv(b, g->floor_valid ? freshness : "unknown");
        mj_key(b, "equipment"); mj_strv(b, equipment_known ? freshness : "unknown");
        mj_endobj(b);
    }
}

/* Last 10, newest last (design "heard" reads oldest-first). */
static void
emit_heard_chrono(game_t *g, mj_Buf *b)
{
    size_t i, n = g->msg_count > 10 ? 10 : g->msg_count;
    size_t base = g->msg_count > 10 ? g->msg_count - 10 : 0;
    mj_key(b, "heard");
    mj_arr(b);
    for (i = 0; i < n; i++)
        mj_strv(b, g->messages[(g->msg_start + base + i) % NMSG] ?
                g->messages[(g->msg_start + base + i) % NMSG] : "");
    mj_endarr(b);
}

static void
emit_provenance(game_t *g, mj_Buf *b)
{
    if (!g->recording_only) return;
    mj_key(b, "provenance"); mj_obj(b);
    mj_key(b, "kind"); mj_strv(b, "reconstruction");
    mj_key(b, "sourceSessionId"); mj_strv(b, g->reconstruction_source);
    mj_key(b, "verification"); mj_strv(b, "unverified");
    mj_key(b, "readOnly"); mj_boolv(b, 1);
    mj_key(b, "inputFingerprint"); mj_strv(b, g->reconstruction_input_hash);
    mj_key(b, "engineFingerprint"); mj_strv(b, g->reconstruction_engine_hash);
    mj_key(b, "nhdatFingerprint"); mj_strv(b, g->reconstruction_data_hash);
    mj_key(b, "answersConsumed"); mj_intv(b, g->reconstruction_step);
    mj_key(b, "answersTotal"); mj_intv(b, g->reconstruction_total);
    mj_key(b, "complete"); mj_boolv(b, g->reconstruction_step == g->reconstruction_total);
    mj_key(b, "note");
    mj_strv(b, "Rebuilt from stored inputs using the source engine and data. Input ids matched, but original observations, calendar and runtime options were not captured; this is not a verified original recording. Legacy item/terrain knowledge may be incomplete.");
    mj_endobj(b);
}

static void
emit_observation(game_t *g, mj_Buf *b)
{
    mj_key(b, "observation");
    mj_obj(b);
    mj_key(b, "turn"); mj_intv(b, turn_of(g));
    emit_location(g, b);
    mj_key(b, "you");
    if (g->have_you) {
        mj_obj(b);
        mj_key(b, "x"); mj_intv(b, g->you_x);
        mj_key(b, "y"); mj_intv(b, g->you_y);
        mj_endobj(b);
    } else {
        mj_nullv(b);
    }
    emit_vitals(g, b);
    emit_inventory(g, b);
    mj_key(b, "here"); mj_obj(b);
    mj_key(b, "known"); mj_boolv(b, g->floor_valid);
    mj_key(b, "items"); mj_arr(b);
    {
        size_t i;
        for (i = 0; g->floor_valid && i < g->nfloor; i++) {
            mj_obj(b);
            mj_key(b, "id"); mj_strv(b, g->floor[i].ref);
            mj_key(b, "label"); mj_strv(b, g->floor[i].label ? g->floor[i].label : "object");
            mj_key(b, "location"); mj_strv(b, "here");
            mj_key(b, "category"); mj_strv(b, g->floor[i].category);
            mj_key(b, "quantity"); mj_intv(b, g->floor[i].quantity);
            mj_endobj(b);
        }
    }
    mj_endarr(b); mj_endobj(b);
    emit_world(g, b);
    emit_heard_chrono(g, b);
    mj_endobj(b);
}

/* ---------------- decisions ---------------- */

/* Offer id for the current prompt. Reused while the same engine
 * prompt is re-read (get_state must not churn ids); minted otherwise.
 * Sidecars persist next_decision so ids survive resume. */
static const char *
offer_id(game_t *g, const char *kind)
{
    if (g->operation.decision_id[0] &&
        g->operation.dec_pending == g->pending.id &&
        !strcmp(g->operation.dec_kind, kind))
        return g->operation.decision_id;
    snprintf(g->operation.decision_id, sizeof g->operation.decision_id,
             "decision-%lld", g->next_decision++);
    snprintf(g->operation.dec_kind, sizeof g->operation.dec_kind, "%s", kind);
    g->operation.dec_pending = g->pending.id;
    g->have_operation = 1;
    return g->operation.decision_id;
}

/* Is this yn prompt a yes/no confirmation? Structural: every choice char
 * is y/n-ish. Anything else is a selection among letters. */
static int
yn_is_confirm(const char *choices)
{
    const char *p;
    if (!choices || !*choices)
        return 0;
    for (p = choices; *p; p++) {
        if (*p == 'y' || *p == 'n' || *p == 'Y' || *p == 'N' ||
            *p == 'q' || *p == 'Q' || *p == ' ' || *p == '\x1b')
            continue;
        return 0;
    }
    return 1;
}

/* Forward declarations for driver helpers defined further below. */
static int is_direction_prompt(const char *prompt);
static int is_quantity_prompt(const char *prompt);
static int emit_text_decision(game_t *g, mj_Buf *b, char *kind_out,
                              size_t kind_cap);
static int move_code(const char *dir);

/* Emit the pending prompt as a typed decision. want_item: the in-flight
 * operation is resolving an item (menu options become item refs).
 * Returns 1 with *kind_out set when offerable, 0 otherwise. */
static int
emit_decision(game_t *g, mj_Buf *b, int want_item, char *kind_out, size_t kind_cap)
{
    size_t i;
    if (!g->pending.waiting)
        return 0;
    if (!strcmp(g->pending.kind, "menu")) {
        menu_t *m = menu_for(g, g->pending.window, 0);
        size_t nsel = 0;
        if (!m)
            return 0;
        for (i = 0; i < m->nitems; i++)
            if (menu_selectable(&m->items[i]))
                nsel++;
        mj_key(b, "decision");
        mj_obj(b);
        mj_key(b, "id");
        mj_strv(b, offer_id(g, want_item ? "item" : "choice"));
        mj_key(b, "kind");
        mj_strv(b, want_item ? "item" : "choice");
        snprintf(kind_out, kind_cap, "%s", want_item ? "item" : "choice");
        mj_key(b, "action");
        mj_strv(b, g->operation.action[0] ? g->operation.action : "act");
        if ((m->prompt && m->prompt[0]) ||
            (g->pending.prompt && g->pending.prompt[0])) {
            mj_key(b, "about");
            mj_strv(b, (m->prompt && m->prompt[0]) ? m->prompt : g->pending.prompt);
        }
        mj_key(b, "cancellable");
        mj_boolv(b, 1);
        if (g->pending.how == 2) {
            mj_key(b, "selection");
            mj_obj(b);
            mj_key(b, "min"); mj_intv(b, nsel ? 1 : 0); /* no selection uses explicit cancel */
            mj_key(b, "max"); mj_intv(b, (long long) nsel);
            mj_endobj(b);
        }
        mj_key(b, "options");
        mj_arr(b);
        for (i = 0; i < m->nitems; i++) {
            if (!menu_selectable(&m->items[i]))
                continue;               /* header row: shown, not offered */
            mj_obj(b);
            mj_key(b, "id"); mj_intv(b, m->items[i].index);
            mj_key(b, "label"); mj_strv(b, m->items[i].text ? m->items[i].text : "");
            mj_endobj(b);
        }
        mj_endarr(b);
        mj_endobj(b);
        return 1;
    }
    if (!strcmp(g->pending.kind, "yn") &&
        (!g->pending.choices || !g->pending.choices[0])) {
        /* Bare prompts: directions are targets (handled below); counts
         * ride text; yes/no defaults are boolean confirmations. */
        if (is_quantity_prompt(g->pending.prompt))
            return emit_text_decision(g, b, kind_out, kind_cap);
        if (g->pending.def == 'y' || g->pending.def == 'Y' ||
            g->pending.def == 'n' || g->pending.def == 'N') {
            mj_key(b, "decision");
            mj_obj(b);
            mj_key(b, "id");
            mj_strv(b, offer_id(g, "confirmation"));
            mj_key(b, "kind");
            mj_strv(b, "confirmation");
            snprintf(kind_out, kind_cap, "%s", "confirmation");
            mj_key(b, "action");
            mj_strv(b, g->operation.action[0] ? g->operation.action : "act");
            if (g->pending.prompt && g->pending.prompt[0]) {
                mj_key(b, "about");
                mj_strv(b, g->pending.prompt);
            }
            mj_key(b, "cancellable");
            mj_boolv(b, 1);
            mj_endobj(b);
            return 1;
        }
        if (is_direction_prompt(g->pending.prompt)) {
            mj_key(b, "decision"); mj_obj(b);
            mj_key(b, "id"); mj_strv(b, offer_id(g, "target"));
            mj_key(b, "kind"); mj_strv(b, "target");
            snprintf(kind_out, kind_cap, "%s", "target");
            mj_key(b, "action"); mj_strv(b, g->operation.action);
            mj_key(b, "about"); mj_strv(b, g->pending.prompt);
            mj_key(b, "allowedTargets"); mj_arr(b);
            if (g->operation.self_ok) mj_strv(b, "self");
            mj_strv(b, "direction"); mj_endarr(b);
            mj_key(b, "cancellable"); mj_boolv(b, 1);
            mj_endobj(b);
            return 1;
        }
        return 0;       /* unknown input stays unsupported, never guessed */
    }
    if (!strcmp(g->pending.kind, "yn")) {
        const char *ch = g->pending.choices ? g->pending.choices : "";
        if (!*ch)
            return 0;                   /* letter-point: only flows may offer it */
        mj_key(b, "decision");
        mj_obj(b);
        mj_key(b, "id");
        if (yn_is_confirm(ch)) {
            mj_strv(b, offer_id(g, "confirmation"));
            mj_key(b, "kind");
            mj_strv(b, "confirmation");
            snprintf(kind_out, kind_cap, "confirmation");
        } else {
            mj_strv(b, offer_id(g, "choice"));
            mj_key(b, "kind");
            mj_strv(b, "choice");
            snprintf(kind_out, kind_cap, "choice");
            mj_key(b, "options");
            mj_arr(b);
            for (i = 0; ch[i]; i++) {
                char label[8]; size_t k;
                snprintf(label, sizeof label, "%c", ch[i]);
                /* The bound ring-put-on flow uses rightleftchars. Present
                 * its semantic choice, not a terminal-letter instruction. */
                if ((!strcmp(ch, "rl") || !strcmp(ch, "lr")) &&
                    (!strcmp(g->operation.action, "equip") || !strcmp(g->operation.action, "wear")))
                    for (k = 0; k < g->ninv; k++)
                        if (g->inv[k].letter == g->operation.item_letter && !strcmp(g->inv[k].category, "ring"))
                            snprintf(label, sizeof label, "%s", ch[i] == 'r' ? "Right" : "Left");
                mj_obj(b);
                mj_key(b, "id"); mj_intv(b, (long long) i);
                mj_key(b, "label"); mj_strv(b, label);
                mj_endobj(b);
            }
            mj_endarr(b);
        }
        mj_key(b, "action");
        mj_strv(b, g->operation.action[0] ? g->operation.action : "act");
        if (g->pending.prompt && g->pending.prompt[0]) {
            mj_key(b, "about");
            mj_strv(b, g->pending.prompt);
        }
        mj_key(b, "cancellable");
        mj_boolv(b, 1);
        mj_endobj(b);
        return 1;
    }
    if (!strcmp(g->pending.kind, "getlin")) {
        mj_key(b, "decision");
        mj_obj(b);
        mj_key(b, "id");
        mj_strv(b, offer_id(g, "text"));
        mj_key(b, "kind");
        mj_strv(b, "text");
        snprintf(kind_out, kind_cap, "text");
        mj_key(b, "action");
        mj_strv(b, g->operation.action[0] ? g->operation.action : "act");
        if (g->pending.prompt && g->pending.prompt[0]) {
            mj_key(b, "about");
            mj_strv(b, g->pending.prompt);
        }
        mj_key(b, "cancellable");
        mj_boolv(b, 1);
        mj_endobj(b);
        return 1;
    }
    if (!strcmp(g->pending.kind, "extcmd")) {
        mj_key(b, "decision");
        mj_obj(b);
        mj_key(b, "id");
        mj_strv(b, offer_id(g, "choice"));
        mj_key(b, "kind");
        mj_strv(b, "choice");
        snprintf(kind_out, kind_cap, "choice");
        mj_key(b, "action");
        mj_strv(b, g->operation.action[0] ? g->operation.action : "act");
        if (g->pending.prompt && g->pending.prompt[0]) {
            mj_key(b, "about");
            mj_strv(b, g->pending.prompt);
        }
        mj_key(b, "cancellable");
        mj_boolv(b, 1);
        mj_key(b, "options");
        mj_arr(b);
        for (i = 0; i < g->pending.ncommands; i++) {
            mj_obj(b);
            mj_key(b, "id"); mj_intv(b, (long long) i);
            mj_key(b, "label"); mj_strv(b, g->pending.commands[i]);
            mj_endobj(b);
        }
        mj_endarr(b);
        mj_endobj(b);
        return 1;
    }
    if (!strcmp(g->pending.kind, "poskey")) {
        /* A mid-flow position prompt with no tracked entities: the only
         * answerable vocabulary here is an adjacent direction. At rest
         * (no operation) the prompt takes fresh acts, not replies. A
         * synthetic listing stands untouched: it holds no engine prompt
         * and must survive reads and rejected answers. */
        if (!g->have_operation)
            return 0;
        if (g->operation.dec_pending == -2)
            return 0;
        mj_key(b, "decision");
        mj_obj(b);
        mj_key(b, "id");
        mj_strv(b, offer_id(g, "target"));
        mj_key(b, "kind");
        mj_strv(b, "target");
        snprintf(kind_out, kind_cap, "%s", "target");
        mj_key(b, "action");
        mj_strv(b, g->operation.action[0] ? g->operation.action : "act");
        mj_key(b, "allowedTargets");
        mj_arr(b);
        mj_strv(b, "direction");
        mj_endarr(b);
        mj_key(b, "cancellable");
        mj_boolv(b, 1);
        mj_endobj(b);
        return 1;
    }
    if (!strcmp(g->pending.kind, "yn") && g->pending.choices &&
        !g->pending.choices[0] &&
        is_direction_prompt(g->pending.prompt)) {
        /* getdir-style direction question: a direction, never a letter.
         * Synthetic listings are never overwritten by resting prompts. */
        int self = g->operation.self_ok;
        if (!g->have_operation)
            return 0;
        if (g->operation.dec_pending == -2)
            return 0;
        mj_key(b, "decision");
        mj_obj(b);
        mj_key(b, "id");
        mj_strv(b, offer_id(g, "target"));
        mj_key(b, "kind");
        mj_strv(b, "target");
        snprintf(kind_out, kind_cap, "%s", "target");
        mj_key(b, "action");
        mj_strv(b, g->operation.action[0] ? g->operation.action : "act");
        if (g->pending.prompt && g->pending.prompt[0]) {
            mj_key(b, "about");
            mj_strv(b, g->pending.prompt);
        }
        mj_key(b, "allowedTargets");
        mj_arr(b);
        if (self)
            mj_strv(b, "self");
        mj_strv(b, "direction");
        mj_endarr(b);
        mj_key(b, "cancellable");
        mj_boolv(b, 1);
        mj_endobj(b);
        return 1;
    }
    return 0;
}

/* Translate one replyTo answer into an engine result line.
 * Returns malloc'd line, or NULL with *err set (no engine touch). */
static int
reply_character(char *line, size_t cap, char character)
{
    char text[2] = { character, 0 };
    mj_Buf b;
    int ok;
    mj_init(&b); mj_obj(&b);
    mj_key(&b, "answer"); mj_strv(&b, text);
    mj_endobj(&b);
    ok = b.ok && b.buf && strlen(b.buf) < cap;
    if (ok) snprintf(line, cap, "%s", b.buf);
    mj_free(&b);
    return ok;
}

static char *
translate_reply(game_t *g, const char *dec_kind, const char *args,
                const char **err)
{
    mj_val v;
    char line[1024];
    char *s;
    if (mj_find(args, "cancel", &v)) {
        int c = 0;
        mj_bool(v, &c);
        if (c) {
            if (!strcmp(g->pending.kind, "menu"))
                snprintf(line, sizeof line, "{\"picks\":[],\"counts\":[]}");
            else if (!strcmp(g->pending.kind, "yn"))
                snprintf(line, sizeof line, "{\"answer\":\"\\u001b\"}");
            else if (!strcmp(g->pending.kind, "extcmd"))
                snprintf(line, sizeof line, "{\"index\":-1}");
            else if (!strcmp(g->pending.kind, "getlin"))
                snprintf(line, sizeof line, "{\"line\":\"\"}");
            else if (!strcmp(g->pending.kind, "poskey"))
                snprintf(line, sizeof line, "{\"key\":27}");
            else {
                *err = "nothing to turn away from";
                return NULL;
            }
            goto wrap;
        }
    }
    if (!strcmp(dec_kind, "confirmation")) {
        int c = 0;
        if (!mj_find(args, "confirm", &v) || !mj_bool(v, &c)) {
            *err = "confirmation needs {confirm:true|false}";
            return NULL;
        }
        snprintf(line, sizeof line, "{\"answer\":\"%s\"}", c ? "y" : "n");
        goto wrap;
    }
    if (!strcmp(dec_kind, "text")) {
        if (!mj_find(args, "text", &v) || (s = mj_str(v)) == NULL) {
            *err = "text decision needs {text:...}";
            return NULL;
        }
        if (!strcmp(g->pending.kind, "yn")) {
            /* Single-character engine prompt (counts): first char only. */
            if (!s[0]) {
                free(s);
                *err = "text decision needs a character";
                return NULL;
            }
            if (!reply_character(line, sizeof line, s[0])) {
                free(s); *err = "unencodable character"; return NULL;
            }
            free(s);
            goto wrap;
        }
        {
            mj_Buf b;
            mj_init(&b);
            mj_obj(&b);
            mj_key(&b, "line");
            mj_strv(&b, s);
            mj_endobj(&b);
            free(s);
            if (!b.ok || !b.buf) {
                mj_free(&b);
                *err = "unencodable text";
                return NULL;
            }
            snprintf(line, sizeof line, "%s", b.buf);
            mj_free(&b);
            goto wrap;
        }
    }
    if (!strcmp(dec_kind, "choice") || !strcmp(dec_kind, "item")) {
        /* {choose: index | [indices]} over the listed option ids */
        long long idx[64];
        size_t nidx = 0;
        if (mj_find(args, "choose", &v)) {
            size_t len;
            const char *raw = mj_raw(v, &len);
            if (*raw == '[') {
                char *cpy = malloc(len + 1);
                if (cpy) {
                    mj_arr_it it;
                    mj_val elt;
                    memcpy(cpy, raw, len);
                    cpy[len] = '\0';
                    memset(&it, 0, sizeof it);
                    it.first = 1;
                    while (mj_arr_next(cpy, &it, &elt) && nidx < 64) {
                        long long n;
                        if (mj_int(elt, &n))
                            idx[nidx++] = n;
                    }
                    free(cpy);
                }
            } else {
                long long n;
                if (mj_int(v, &n))
                    idx[nidx++] = n;
            }
        }
        if (!strcmp(g->pending.kind, "menu")) {
            menu_t *m = menu_for(g, g->pending.window, 0);
            size_t menu_n = m ? m->nitems : 0;
            size_t i;
            mj_Buf b;
            if (!nidx) {
                *err = "choice needs {choose:index}";
                return NULL;
            }
            if (g->pending.how != 2 && nidx > 1) {
                *err = "this decision takes a single index";
                return NULL;
            }
            for (i = 0; i < nidx; i++) {
                size_t k;
                int ok = 0;
                for (k = 0; k < menu_n; k++)
                    if (m->items[k].index == idx[i] &&
                        menu_selectable(&m->items[k]))
                        ok = 1;
                if (!ok) {
                    *err = "choice out of range or not offered";
                    return NULL;
                }
            }
            mj_init(&b);
            mj_obj(&b);
            mj_key(&b, "picks");
            mj_arr(&b);
            for (i = 0; i < nidx; i++)
                mj_intv(&b, idx[i]);
            mj_endarr(&b);
            mj_key(&b, "counts");
            mj_arr(&b);
            mj_endarr(&b);
            mj_endobj(&b);
            if (!b.ok || !b.buf) {
                mj_free(&b);
                *err = "unencodable choice";
                return NULL;
            }
            snprintf(line, sizeof line, "%s", b.buf);
            mj_free(&b);
            if (m) {
                menu_clear(m);
                m->used = 0;
            }
            goto wrap;
        }
        if (!strcmp(g->pending.kind, "yn")) {
            const char *ch = g->pending.choices ? g->pending.choices : "";
            if (nidx != 1 || idx[0] < 0 || idx[0] >= (long long) strlen(ch)) {
                *err = "choice out of range";
                return NULL;
            }
            if (!reply_character(line, sizeof line, ch[idx[0]])) {
                *err = "unencodable character"; return NULL;
            }
            goto wrap;
        }
        if (!strcmp(g->pending.kind, "extcmd")) {
            if (nidx != 1 || idx[0] < 0 || (size_t) idx[0] >= g->pending.ncommands) {
                *err = "choice out of range";
                return NULL;
            }
            snprintf(line, sizeof line, "{\"index\":%lld}", idx[0]);
            goto wrap;
        }
        *err = "nothing to decide";
        return NULL;
    }
    if (!strcmp(dec_kind, "target")) {
        /* {target:"self"} or {target:{"direction":"south"}}. Entity and
         * position targets are rejected before any engine input. */
        int code = -1;
        if (!mj_find(args, "target", &v)) {
            *err = "target decision needs {target:...}";
            return NULL;
        }
        {
            size_t len;
            const char *raw = mj_raw(v, &len);
            if (raw && len > 1 && *raw == '{') {
                char *cpy = malloc(len + 1);
                mj_val dv, pv, ev;
                char *dstr = NULL;
                if (!cpy) {
                    *err = "out of memory";
                    return NULL;
                }
                memcpy(cpy, raw, len);
                cpy[len] = '\0';
                if (mj_find(cpy, "position", &pv) ||
                    mj_find(cpy, "entity", &ev)) {
                    free(cpy);
                    *err = "this action takes directions or self, not positions or entities";
                    return NULL;
                }
                if (mj_find(cpy, "direction", &dv))
                    dstr = mj_str(dv);
                free(cpy);
                if (!dstr) {
                    *err = "target needs {\"direction\":\"south\"} or \"self\"";
                    return NULL;
                }
                code = move_code(dstr);
                free(dstr);
                if (code < 0) {
                    *err = "unknown direction: north/south/east/west/northeast/northwest/southeast/southwest/up/down";
                    return NULL;
                }
            } else {
                char *t = mj_str(v);
                if (!t || strcmp(t, "self")) {
                    free(t);
                    *err = "target must be \"self\" or {\"direction\":...}";
                    return NULL;
                }
                free(t);
                if (!g->operation.self_ok) {
                    *err = "this action cannot target self";
                    return NULL;
                }
                code = 46;      /* self at a direction prompt: '.' */
            }
        }
        if (!strcmp(g->pending.kind, "yn")) {
            char ch = (char) code;
            if (ch < 32 || ch > 126) {
                *err = "that direction has no key";
                return NULL;
            }
            snprintf(line, sizeof line, "{\"answer\":\"%c\"}", ch);
            goto wrap;
        }
        if (!strcmp(g->pending.kind, "poskey")) {
            snprintf(line, sizeof line, "{\"key\":%d}", code);
            goto wrap;
        }
        *err = "nothing to aim at right now";
        return NULL;
    }
    *err = "unknown decision kind";
    return NULL;
wrap:
    {
        char *out = malloc(strlen(line) + 64);
        if (!out) {
            *err = "out of memory";
            return NULL;
        }
        snprintf(out, strlen(line) + 64,
                 "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":%s}",
                 g->pending.id, line);
        return out;
    }
}

/* ---------------- envelope ---------------- */

static void emit_end(game_t *g, mj_Buf *b);

static void
emit_events_window(game_t *g, mj_Buf *b, long long from)
{
    size_t i;
    mj_key(b, "events");
    mj_arr(b);
    for (i = 0; i < g->nevents; i++)
        if (g->events[i].seq > from)
            mj_rawv(b, g->events[i].json);
    mj_endarr(b);
}

/* Full response envelope. want_decision>0 emits the pending prompt as a
 * typed decision (want_item selects item vs choice menus). */
static char *
envelope(game_t *g, const char *req_id,
         const char *action, const char *status, const char *reason,
         int turns_elapsed, int pos_changed,
         const char **effects, int neffects,
         long long ev_from, int want_decision, int want_item,
         const char *err_code, const char *err_msg)
{
    mj_Buf b;
    int i;
    char dec_kind[16] = "";
    if (g->recovery_required || g->sidecar_corrupt || g->sidecar_error[0] || g->input_error[0]) want_decision = 0;
    if (g->ended || g->terminal_kind[0]) {
        want_decision = 0;
        if (g->terminal_kind[0] && !strcmp(status, "needsChoice")) status = "completed";
    }
    if (!err_code && (!strcmp(g->terminal_kind, "engineError") ||
        (g->ended && !strcmp(g->end_reason, "engineError")))) {
        status = "unknown"; reason = err_code = "engineError";
        err_msg = "engine terminated without a successful game result";
        want_decision = 0;
    }
    mj_init(&b);
    mj_obj(&b);
    mj_key(&b, "sessionId"); mj_strv(&b, g->id);
    mj_key(&b, "requestId");
    if (req_id)
        mj_strv(&b, req_id);
    else
        mj_nullv(&b);
    mj_key(&b, "revision"); mj_intv(&b, g->revision);
    mj_key(&b, "outcome"); mj_obj(&b);
    mj_key(&b, "action"); mj_strv(&b, action);
    mj_key(&b, "status"); mj_strv(&b, status);
    if (reason) {
        mj_key(&b, "reason"); mj_strv(&b, reason);
    }
    mj_key(&b, "turnsElapsed"); mj_intv(&b, turns_elapsed);
    mj_key(&b, "positionChanged"); mj_boolv(&b, pos_changed);
    mj_key(&b, "effects"); mj_arr(&b);
    for (i = 0; i < neffects; i++)
        mj_strv(&b, effects[i]);
    mj_endarr(&b);
    mj_endobj(&b);
    emit_observation(g, &b);
    emit_provenance(g, &b);
    emit_events_window(g, &b, ev_from);
    if (want_decision && g->pending.waiting &&
        emit_decision(g, &b, want_item, dec_kind, sizeof dec_kind)) {
        sidecar_save(g);        /* next_decision counter */
    } else {
        mj_key(&b, "decision"); mj_nullv(&b);
    }
    mj_key(&b, "ended"); mj_boolv(&b, g->ended || g->terminal_kind[0]);
    emit_end(g, &b);
    if (err_code) {
        mj_key(&b, "error"); mj_obj(&b);
        mj_key(&b, "code"); mj_strv(&b, err_code);
        mj_key(&b, "message"); mj_strv(&b, err_msg ? err_msg : "");
        mj_endobj(&b);
    }
    mj_endobj(&b);
    return mj_take(&b);
}

/* Rejections before (or without) engine input are blocked with the
 * reason named; genuinely uncertain executions stay unknown. */
static int
code_is_unknown(const char *code)
{
    return !strcmp(code, "engineTimeout") || !strcmp(code, "engineBusy") ||
        !strcmp(code, "engineError") || !strcmp(code, "outOfMemory") ||
        !strcmp(code, "incompleteRequest") || !strcmp(code, "recoveryRequired");
}

static char *
envelope_error(game_t *g, const char *req_id, const char *action,
               const char *code, const char *msg)
{
    return envelope(g, req_id, action ? action : "act",
                    code_is_unknown(code) ? "unknown" : "blocked", code,
                    0, 0, NULL, 0, g->event_seq, 1, 0, code, msg);
}

/* ---------------- inventory refresh (zero-turn peek) ---------------- */

/* Parse a leading "<n> " count ("6 uncursed apples" -> 6). */
static int
leading_count(const char *label)
{
    char *e;
    long n = strtol(label, &e, 10);
    if (e != label && *e == ' ')
        return (int) n;
    return 1;
}

/* Snapshot known inventory via a zero-turn menu peek. Only when no
 * operation is in flight and the engine awaits a resting prompt: every
 * main-loop key read arrives as poskey (core readchar funnels through
 * nh_poskey), and a {"key"} answer is honored as that keystroke.
 * Returns 1 on success. */
static int
refresh_inventory(nhx_t *x, game_t *g)
{
    char line[128];
    int r;
    size_t i;
    (void) x;
    if (g->structured_perception) {
        g->inventory_rev = g->revision;
        return 1;
    }
    /* A synthetic listing decision holds no engine prompt, so peeks stay
     * legal while one stands (dec_pending == -2). */
    if ((g->have_operation && g->operation.dec_pending != -2) ||
        g->ended || !g->pending.waiting)
        return 0;
    if (strcmp(g->pending.kind, "key") && strcmp(g->pending.kind, "poskey"))
        return 0;
    snprintf(line, sizeof line,
             "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"key\":105}}",
             g->pending.id);
    if (send_engine(g, line) < 0)
        return 0;
    pending_clear(g);
    r = await_prompt(g, ACT_TIMEOUT_MS);
    if (r != 1 || strcmp(g->pending.kind, "menu")) {
        /* unexpected: leave whatever prompt stands */
        return 0;
    }
    {
        menu_t *m = menu_for(g, g->pending.window, 0);
        size_t n = 0, k;
        for (i = 0; i < g->ninv; i++)
            free(g->inv[i].label);
        free(g->inv);
        g->inv = NULL;
        g->ninv = 0;
        if (m) {
            for (k = 0; k < m->nitems; k++)
                if (m->items[k].glyph != NO_GLYPH_NUM && m->items[k].accel > 0)
                    n++;
            g->inv = calloc(n ? n : 1, sizeof *g->inv);
            if (g->inv) {
                for (k = 0; k < m->nitems; k++) {
                    inv_item_t *it;
                    unsigned char slot;
                    if (m->items[k].glyph == NO_GLYPH_NUM || m->items[k].accel <= 0)
                        continue;
                    it = &g->inv[g->ninv++];
                    /* Refs are stable per inventory slot: the same letter
                     * keeps the same ref across refreshes. Stale reuse is
                     * caught by comparing against the label snapshot. */
                    snprintf(it->ref, sizeof it->ref, "item-%c",
                             (char) m->items[k].accel);
                    it->letter = (char) m->items[k].accel;
                    it->label = strdup(m->items[k].text ? m->items[k].text : "");
                    it->location = 0;
                    it->quantity = leading_count(it->label ? it->label : "");
                    it->glyph = m->items[k].glyph;
                    slot = (unsigned char) it->letter;
                    free(g->inv_label_by_letter[slot]);
                    g->inv_label_by_letter[slot] =
                        strdup(it->label ? it->label : "");
                }
            }
            menu_clear(m);
            m->used = 0;
        }
    }
    snprintf(line, sizeof line,
             "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"picks\":[],\"counts\":[]}}",
             g->pending.id);
    if (send_engine(g, line) < 0)
        return 0;
    pending_clear(g);
    r = await_prompt(g, ACT_TIMEOUT_MS);
    if (r != 1)
        return 0;
    g->inventory_rev = g->revision;
    sidecar_save(g);
    return 1;
}

/* ---------------- action driver: knowledge, items, targets ---------------- */

/* Reset the standing operation for a fresh action. Engine-affecting fields
 * start empty; the reply path fills them before driving. */
static void
op_start(game_t *g, const char *action)
{
    memset(&g->operation, 0, sizeof g->operation);
    snprintf(g->operation.action, sizeof g->operation.action, "%s", action);
    g->operation.floor_index = -1;
    g->operation.dir_code = -1;
    g->operation.cmdkey = -2;
    g->have_operation = 0;
}

/* Lowercase copy for perceived-label matching. */
static void
norm_label(const char *in, char *out, size_t cap)
{
    size_t i = 0;
    if (!in)
        in = "";
    while (*in && i + 1 < cap) {
        char c = *in++;
        out[i++] = (char) tolower((unsigned char) c);
    }
    out[i] = '\0';
}

static int
label_has(const char *label, const char *word)
{
    char buf[256], w[64];
    norm_label(label, buf, sizeof buf);
    norm_label(word, w, sizeof w);
    return strstr(buf, w) != NULL;
}

/* Whole-word match for short stubs ("pie" must not fire on "pieces"). */
static int
label_has_word(const char *label, const char *word)
{
    char buf[256], w[64];
    size_t wl;
    char *hit;
    norm_label(label, buf, sizeof buf);
    norm_label(word, w, sizeof w);
    wl = strlen(w);
    if (!wl)
        return 0;
    for (hit = strstr(buf, w); hit; hit = strstr(hit + 1, w)) {
        int left = hit == buf || (!isalnum((unsigned char) hit[-1]) &&
                                  hit[-1] != '-');
        int right = !hit[wl] || (!isalnum((unsigned char) hit[wl]) &&
                                 hit[wl] != '-') ||
            (hit[wl] == 's' &&
             (!hit[wl + 1] || !isalnum((unsigned char) hit[wl + 1])));
        if (left && right)
            return 1;
    }
    return 0;
}

static int
label_has_any(const char *label, const char *const *words)
{
    size_t i;
    for (i = 0; words[i]; i++) {
        if (strlen(words[i]) <= 3) {
            if (label_has_word(label, words[i]))
                return 1;
        } else if (label_has_word(label, words[i])) {
            return 1;
        }
    }
    return 0;
}

static const char *const FOOD_WORDS[] = {
    "ration", "apple", "carrot", "banana", "orange", "pear", "melon",
    "mango", "kelp", "tripe", "egg", "corpse", "meat", "pizza", "pie",
    "sandwich", "bread", "cracker", "cookie", "pancake", "candy",
    "royal jelly", "mushroom", "berry", "berries", "fruit", "food",
    "eucalyptus", "wolfsbane", "garlic", "lembas", "cram", "wafer",
    "gunyoki", "pumpkin", "peanut", "omelette", "lichen", "kobold",
    NULL
};

static const char *const TOOL_WORDS[] = {
    "key", "whistle", "pick-axe", "lantern", "lamp", "stethoscope",
    "bag", "sack", "horn", "harp", "drum", "flute", "lyre", "opener",
    "leash", "saddle", "mirror", "lens", "towel", "blindfold", "candle",
    "candelabrum", "figurine", "chest", "box", "oilskin", "hook",
    NULL
};

static const char *const ARMOR_WORDS[] = {
    "helmet", "helm", "cap", "boots", "gloves", "gauntlets", "cloak",
    "shield", "armor", "mail", "shirt", "robe", "suit", "jacket",
    "shoes", "t-shirt", "saddle", NULL
};

/* Eligibility is judged on perceived label text only: never on hidden
 * engine state (curse, enchantment, poison, corpse age). */
static int
eligible_for(const char *action, const char *label)
{
    if (!strcmp(action, "eat"))
        return label_has_any(label, FOOD_WORDS);
    if (!strcmp(action, "drink"))
        return label_has(label, "potion");
    if (!strcmp(action, "zap"))
        return label_has(label, "wand");
    if (!strcmp(action, "read"))
        return label_has(label, "scroll") || label_has(label, "spellbook");
    if (!strcmp(action, "equip") || !strcmp(action, "wear") ||
        !strcmp(action, "remove") || !strcmp(action, "takeoff"))
        return label_has_any(label, ARMOR_WORDS) ||
            label_has(label, "ring") || label_has(label, "amulet");
    if (!strcmp(action, "apply"))
        return label_has_any(label, TOOL_WORDS);
    /* wield, drop, pickup: any known item may be offered; the engine
     * validates applicability and the driver reports the outcome. */
    return 1;
}

static int
eligible_item(const char *action, const char *label, const char *category)
{
    if (!category || !*category) return eligible_for(action, label);
    if (!strcmp(action, "eat")) return !strcmp(category, "food");
    if (!strcmp(action, "drink")) return !strcmp(category, "potion");
    if (!strcmp(action, "zap")) return !strcmp(category, "wand");
    if (!strcmp(action, "read")) return !strcmp(category, "scroll") || !strcmp(category, "spellbook");
    if (!strcmp(action, "equip") || !strcmp(action, "wear") || !strcmp(action, "remove") || !strcmp(action, "takeoff"))
        return !strcmp(category, "armor") || !strcmp(category, "ring") || !strcmp(category, "amulet");
    if (!strcmp(action, "apply")) return !strcmp(category, "tool");
    return 1;
}

static int
equipment_action(const char *action)
{
    return !strcmp(action, "equip") || !strcmp(action, "wear") ||
        !strcmp(action, "remove") || !strcmp(action, "takeoff");
}

static int
equipment_key(const char *action, const char *category)
{
    int removing = !strcmp(action, "remove") || !strcmp(action, "takeoff");
    if (!strcmp(category, "armor")) return removing ? 'T' : 'W';
    if (!strcmp(category, "ring") || !strcmp(category, "amulet")) return removing ? 'R' : 'P';
    return -1; /* Never infer an equipment route from a display name. */
}

static int
eligible_carried(game_t *g, const char *action, const inv_item_t *item)
{
    if (equipment_action(action)) {
        int removing = !strcmp(action, "remove") || !strcmp(action, "takeoff");
        if (equipment_key(action, item->category) < 0 || !g->perception_fresh || !item->usage_known) return 0;
        if (removing && !strcmp(item->category, "armor")) {
            if (item->armor_access_known) {
                if (!item->armor_accessible) return 0;
            } else {
                /* Older pins can auto-select the outermost armor. With more
                 * than one worn piece, no layer/row may stand in for our item. */
                size_t i, count = 0;
                for (i = 0; i < g->ninv; i++)
                    if (!strcmp(g->inv[i].category, "armor") && (g->inv[i].usage & 1U)) count++;
                if (count > 1) return 0;
            }
        }
        return removing ? !!(item->usage & 1U) : !(item->usage & 1U); /* engine-issued worn */
    }
    return eligible_item(action, item->label, item->category);
}

static int
action_uses_floor(const char *action)
{
    return !strcmp(action, "eat") || !strcmp(action, "pickup");
}

/* Refresh known inventory when it is stale and the engine awaits a plain
 * move key. Returns 1 when inventory is known afterwards. */
static int
ensure_inventory(nhx_t *x, game_t *g)
{
    (void) x;
    if (g->inventory_rev >= 0)
        return 1;
    if (refresh_inventory(x, g))
        return 1;
    return g->inventory_rev >= 0;
}

/* Zero-turn floor peek via the pickup menu. Captures perceived labels and
 * engine indices, dismisses without taking anything, and returns to the
 * move prompt. Invalidated by any position change or item flow. */
static int
ensure_floor(nhx_t *x, game_t *g)
{
    (void) x;
    /* Never issue pickup to inspect. The engine publishes perceived floor
     * contents without spending time; old engines retain unknown floor. */
    return g->floor_valid;
}

/* Offer ids for synthetic decisions (no engine prompt held). */
static const char *
offer_synth_id(game_t *g, const char *kind)
{
    if (g->have_operation && g->operation.dec_pending == -2 &&
        g->operation.decision_id[0] && !strcmp(g->operation.dec_kind, kind))
        return g->operation.decision_id;
    snprintf(g->operation.decision_id, sizeof g->operation.decision_id,
             "decision-%lld", g->next_decision++);
    snprintf(g->operation.dec_kind, sizeof g->operation.dec_kind, "%s", kind);
    g->operation.dec_pending = -2;
    g->have_operation = 1;
    return g->operation.decision_id;
}

/* One item candidate: perceived label plus where it is. */
typedef struct {
    char ref[24];
    const char *label;
    int location;               /* 0 inventory, 1 here */
    int quantity;
} cand_t;

static size_t
collect_candidates(game_t *g, const char *action, cand_t *out, size_t cap)
{
    size_t n = 0, i;
    for (i = 0; strcmp(action, "pickup") && i < g->ninv && n < cap; i++) {
        const char *label = g->inv[i].label ? g->inv[i].label : "";
        if (!eligible_carried(g, action, &g->inv[i]))
            continue;
        snprintf(out[n].ref, sizeof out[n].ref, "%s", g->inv[i].ref);
        out[n].label = label;
        out[n].location = 0;
        out[n].quantity = g->inv[i].quantity;
        n++;
    }
    if (action_uses_floor(action)) {
        for (i = 0; i < g->nfloor && n < cap; i++) {
            const char *label = g->floor[i].label ? g->floor[i].label : "";
            if (!eligible_item(action, label, g->floor[i].category))
                continue;
            snprintf(out[n].ref, sizeof out[n].ref, "%s", g->floor[i].ref);
            out[n].label = label;
            out[n].location = 1;
            out[n].quantity = g->floor[i].quantity;
            n++;
        }
    }
    return n;
}

/* Resolve an {item} argument against known candidates.
 * 0 = resolved (op->item_letter or op->floor_index set),
 * 1 = no usable item given (caller should offer candidates),
 * -1 = noMatch, -2 = ambiguous. ecode/emsg set on negative returns. */
static int
resolve_item_arg(nhx_t *x, game_t *g, const char *action, const char *args,
                 const char **ecode, const char **emsg)
{
    mj_val v;
    cand_t pool[128];
    size_t npool, i;
    if (action_uses_floor(action))
        ensure_floor(x, g);
    if (!ensure_inventory(x, g)) {
        *ecode = "inventoryUnknown";
        *emsg = "inventory is not known and the world is busy";
        return -1;
    }
    if (equipment_action(action)) {
        int known = g->structured_perception && g->perception_fresh;
        for (i = 0; i < g->ninv; i++) if (!g->inv[i].usage_known) known = 0;
        if (!known) {
            *ecode = "equipmentKnowledgeUnavailable";
            *emsg = "current item class and physical use are required; no equipment was guessed";
            return -1;
        }
    }
    npool = collect_candidates(g, action, pool, sizeof pool / sizeof pool[0]);
    if (!npool) {
        *ecode = "unavailable";
        *emsg = "no perceived items are available for this action";
        return -1;
    }
    if (!mj_find(args, "item", &v) || mj_is_null(v))
        return 1;
    {
        size_t len;
        const char *raw = mj_raw(v, &len);
        if (raw && len > 1 && *raw == '{') {
            /* {"id":"item-a"} reference form */
            char *cpy = malloc(len + 1);
            mj_val idv;
            char *id = NULL;
            int rc = -1;
            if (!cpy) {
                *ecode = "outOfMemory";
                *emsg = "out of memory";
                return -1;
            }
            memcpy(cpy, raw, len);
            cpy[len] = '\0';
            if (mj_find(cpy, "id", &idv))
                id = mj_str(idv);
            if (!id) {
                free(cpy);
                *ecode = "badItem";
                *emsg = "item needs {id:...} or a name";
                return -1;
            }
            for (i = 0; strcmp(action, "pickup") && i < g->ninv; i++) {
                if (!strcmp(id, g->inv[i].ref) && eligible_carried(g, action, &g->inv[i])) {
                    g->operation.item_letter = g->inv[i].letter;
                    g->operation.floor_index = -1;
                    g->operation.floor_object_id = 0;
                    rc = 0;
                    break;
                }
            }
            if (rc && g->floor_valid && action_uses_floor(action)) {
                for (i = 0; i < g->nfloor; i++) {
                    if (!strcmp(id, g->floor[i].ref) && eligible_item(action, g->floor[i].label, g->floor[i].category)) {
                        g->operation.item_letter = 0;
                        g->operation.floor_index = (int) i;
                        g->operation.floor_object_id = g->floor[i].object_id;
                        rc = 0;
                        break;
                    }
                }
            }
            if (rc) {
                *ecode = "staleReference";
                *emsg = "that item is no longer available for this action";
            }
            free(id);
            free(cpy);
            if (rc) {
                if (*ecode == NULL) {
                    *ecode = "noMatch";
                    *emsg = "no such item among the known candidates";
                }
                return -1;
            }
            return 0;
        }
    }
    {
        /* name form: deterministic normalized matching over perceived labels */
        char *name = mj_str(v);
        char q[128];
        size_t hits[128];
        size_t nhits = 0;
        if (!name) {
            *ecode = "badItem";
            *emsg = "item must be a name or {id:...}";
            return -1;
        }
        norm_label(name, q, sizeof q);
        free(name);
        if (!q[0])
            return 1;
        for (i = 0; i < npool && nhits < 128; i++) {
            char lab[256];
            norm_label(pool[i].label, lab, sizeof lab);
            if (strstr(lab, q))
                hits[nhits++] = i;
        }
        if (!nhits) {
            *ecode = "noMatch";
            *emsg = "no known item matches that name";
            return -1;
        }
        if (nhits > 1) {
            *ecode = "ambiguous";
            *emsg = "several known items match; choose one";
            return -2;
        }
        if (pool[hits[0]].location == 0) {
            for (i = 0; i < g->ninv; i++)
                if (!strcmp(g->inv[i].ref, pool[hits[0]].ref)) {
                    g->operation.item_letter = g->inv[i].letter;
                    g->operation.floor_index = -1;
                    g->operation.floor_object_id = 0;
                    return 0;
                }
            *ecode = "staleReference";
            *emsg = "that item is no longer carried";
            return -1;
        }
        {
            size_t fi;
            for (fi = 0; fi < g->nfloor; fi++)
                if (!strcmp(pool[hits[0]].ref, g->floor[fi].ref)) break;
            if (fi >= g->nfloor) {
                *ecode = "staleReference";
                *emsg = "that ground item is no longer here";
                return -1;
            }
            g->operation.item_letter = 0;
            g->operation.floor_index = (int) fi;
            g->operation.floor_object_id = g->floor[fi].object_id;
            return 0;
        }
    }
}

/* A bare-yn prompt asking for a direction ("In what direction?", "Zap in
 * which direction?", ...). Letter and quantity prompts look different. */
static int
is_direction_prompt(const char *prompt)
{
    char buf[256];
    if (!prompt)
        return 0;
    norm_label(prompt, buf, sizeof buf);
    return strstr(buf, "direction") != NULL;
}

static int
is_letter_prompt(const char *prompt)
{
    char buf[256];
    if (!prompt)
        return 0;
    norm_label(prompt, buf, sizeof buf);
    return strstr(buf, "what do you want to") != NULL;
}

static int
is_quantity_prompt(const char *prompt)
{
    char buf[128];
    if (!prompt)
        return 0;
    norm_label(prompt, buf, sizeof buf);
    return strstr(buf, "how many") != NULL;
}

/* Command key per scripted action; -1 = zero-turn query. */
static int
cmdkey_of(const char *action)
{
    if (!strcmp(action, "search"))
        return 115;
    if (!strcmp(action, "kick"))
        return 4;
    if (!strcmp(action, "open"))
        return 111;
    if (!strcmp(action, "close"))
        return 99;
    if (!strcmp(action, "pickup"))
        return 44;
    if (!strcmp(action, "eat"))
        return 101;
    if (!strcmp(action, "drink"))
        return 113;
    if (!strcmp(action, "wield"))
        return 119;
    if (!strcmp(action, "equip") || !strcmp(action, "wear"))
        return 87;
    if (!strcmp(action, "remove") || !strcmp(action, "takeoff"))
        return 84;
    if (!strcmp(action, "read"))
        return 114;
    if (!strcmp(action, "apply"))
        return 97;
    if (!strcmp(action, "drop"))
        return 100;
    if (!strcmp(action, "zap"))
        return 122;
    if (!strcmp(action, "pray"))
        return 35;
    return -2;                  /* not scripted */
}

static int
action_takes_item(const char *action)
{
    return !strcmp(action, "eat") || !strcmp(action, "drink") ||
        !strcmp(action, "wield") || !strcmp(action, "equip") ||
        !strcmp(action, "wear") || !strcmp(action, "remove") ||
        !strcmp(action, "takeoff") || !strcmp(action, "read") ||
        !strcmp(action, "apply") || !strcmp(action, "drop") ||
        !strcmp(action, "zap") || !strcmp(action, "pickup");
}

/* Send one key answer to a key/poskey prompt. */
static int
answer_key(game_t *g, long long id, int code)
{
    char line[128];
    snprintf(line, sizeof line,
             "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"key\":%d}}",
             id, code);
    return send_engine(g, line);
}

/* Heard-message patterns, matched case-insensitively on new narration.
 * Effects describe what actually happened; blocked patterns mark a failed
 * attempt (reported with honest turn cost, never as a wall bump). */
static const char *const FX_ATTACKED[] = {
    "you hit", "you miss", "you kill", "you destroy", "you smite",
    "you bash", "you strike", "you punch", "you stab", "you slash",
    "you whack", "you swing", NULL
};

static const char *const FX_MENACE[] = {
    "the door opens", "open the door", "break open", "crashes open",
    "you open the door", NULL
};

static const char *const FX_SWAP[] = {
    "swap places", "exchange places", "displace", NULL
};

static const char *const FX_BUMP[] = {
    "bump into", "ouch", NULL
};

static const char *const FX_DOWN[] = {
    "go down", "climb down", "descend the stairs", "descend", NULL
};

static const char *const FX_UP[] = {
    "go up", "climb up", "ascend the stairs", "ascend", NULL
};

static const char *const FX_EAT[] = {
    "you eat", "finish eating", "you consume", "you devour", NULL
};

static const char *const FX_DRINK[] = {
    "you drink", "you quaff", "gulp", NULL
};

static const char *const FX_WEAR[] = {
    "you put on", "you are now wearing", "you wear", NULL
};

static const char *const FX_WIELD[] = {
    "wield", NULL
};

static const char *const FX_REMOVE[] = {
    "you take off", "you remove", NULL
};

static const char *const FX_READ[] = {
    "you read", "as you read", NULL
};

static const char *const FX_DROP[] = {
    "you drop", NULL
};

static const char *const FX_PICK[] = {
    "you pick up", "you catch", "you gather", NULL
};

static const char *const FX_KICK[] = {
    "you kick", "as you kick", NULL
};

static const char *const FX_PRAY[] = {
    "you pray", "begin praying", "you kneel", NULL
};

static const char *const FX_BLOCKED[] = {
    "can't", "cannot", "never mind", "locked", "nothing here",
    "don't have that", "no stairs", "not possible", "futile",
    "resists", "to no avail", "you stop", NULL
};

static int
heard_has(game_t *g, size_t start0, size_t count0,
          const char *const *words)
{
    size_t i, k;
    (void) count0;
    /* start0 is the event sequence before this operation. Unlike ring size,
     * it advances after the recent-message buffer fills. */
    for (k = 0; k < g->nevents; k++) {
        mj_val v;
        char *text;
        int found = 0;
        if (g->events[k].seq <= (long long) start0 ||
            !mj_find(g->events[k].json, "text", &v)) continue;
        text = mj_str(v);
        if (!text) continue;
        for (i = 0; words[i]; i++)
            if (label_has(text, words[i])) { found = 1; break; }
        free(text);
        if (found) return 1;
    }
    return 0;
}

/* Invalidate floor knowledge when the explorer left the peek square. */
static void
floor_track(game_t *g)
{
    if (!g->floor_valid)
        return;
    if (!g->have_you || g->you_x != g->floor_x || g->you_y != g->floor_y ||
        !g->status[20] || strcmp(g->status[20], g->floor_level))
        g->floor_valid = 0;
}

/* Bump the revision once per accepted interaction boundary. */
static void
bump_once(game_t *g, int *flag)
{
    if (*flag)
        return;
    *flag = 1;
    g->revision++;
    sidecar_save(g);
}

/* A structured engine result takes priority over narration heuristics. */
static int
activity_result_since(game_t *g, long long from, const char *action)
{
    size_t i;
    int result = 0;
    for (i = 0; i < g->nevents; i++) {
        mj_val v;
        char *type = NULL, *name = NULL, *status = NULL;
        if (g->events[i].seq <= from) continue;
        if (mj_find(g->events[i].json, "type", &v)) type = mj_str(v);
        if (type && !strcmp(type, "actionResult")) {
            if (mj_find(g->events[i].json, "action", &v)) name = mj_str(v);
            if (mj_find(g->events[i].json, "status", &v)) status = mj_str(v);
            if (name && status && !strcmp(name, action))
                result = !strcmp(status, "interrupted") ? 2 : 1;
        }
        free(type); free(name); free(status);
    }
    return result;
}

/* Settle a driven action at a resting key prompt (or the end). Reads the
 * new narration for honest effects, refreshes item knowledge after item
 * flows, and reports blocked when the attempt observably failed. */
static char *
drive_settle(nhx_t *x, game_t *g, const char *req_id,
             int turn0, int you0_x, int you0_y, int had_you,
             long long ev_from, size_t msg_start0, size_t msg_count0,
             int cancelled)
{
    const char *action = g->operation.action;
    const char *fx[14];
    char resolved[256];
    int nfx = 0;
    int turn1 = turn_of(g);
    int pos_changed = 0;
    int blocked = 0;
    int activity = activity_result_since(g, ev_from, action);
    const char *reason = NULL;
    if (g->have_you && had_you &&
        (g->you_x != you0_x || g->you_y != you0_y))
        pos_changed = 1;
    else if (g->have_you != had_you)
        pos_changed = 1;
    if (pos_changed && nfx < 14)
        fx[nfx++] = "moved";
    if (heard_has(g, msg_start0, msg_count0, FX_ATTACKED) && nfx < 14)
        fx[nfx++] = "attacked";
    if (heard_has(g, msg_start0, msg_count0, FX_MENACE) && nfx < 14)
        fx[nfx++] = "openedDoor";
    if (heard_has(g, msg_start0, msg_count0, FX_SWAP) && nfx < 14)
        fx[nfx++] = "swappedPlaces";
    if (heard_has(g, msg_start0, msg_count0, FX_BUMP) && nfx < 14)
        fx[nfx++] = "bumpedWall";
    if (heard_has(g, msg_start0, msg_count0, FX_DOWN) && nfx < 14)
        fx[nfx++] = "descendedStairs";
    if (heard_has(g, msg_start0, msg_count0, FX_UP) && nfx < 14)
        fx[nfx++] = "climbedStairs";
    if (((activity == 1 && !strcmp(action, "eat")) ||
         heard_has(g, msg_start0, msg_count0, FX_EAT)) && nfx < 14)
        fx[nfx++] = "consumedItem";
    if (activity == 2 && nfx < 14) fx[nfx++] = "activityInterrupted";
    if (heard_has(g, msg_start0, msg_count0, FX_DRINK) && nfx < 14)
        fx[nfx++] = "drank";
    if (heard_has(g, msg_start0, msg_count0, FX_WEAR) && nfx < 14)
        fx[nfx++] = "woreItem";
    if (heard_has(g, msg_start0, msg_count0, FX_WIELD) && nfx < 14)
        fx[nfx++] = "wieldedItem";
    if (heard_has(g, msg_start0, msg_count0, FX_REMOVE) && nfx < 14)
        fx[nfx++] = "removedItem";
    if (heard_has(g, msg_start0, msg_count0, FX_READ) && nfx < 14)
        fx[nfx++] = "readItem";
    if (heard_has(g, msg_start0, msg_count0, FX_DROP) && nfx < 14)
        fx[nfx++] = "droppedItem";
    if (heard_has(g, msg_start0, msg_count0, FX_PICK) && nfx < 14)
        fx[nfx++] = "pickedUp";
    if ((!strcmp(action, "kick") ||
         heard_has(g, msg_start0, msg_count0, FX_KICK)) && nfx < 14)
        fx[nfx++] = "kicked";
    if (heard_has(g, msg_start0, msg_count0, FX_PRAY) && nfx < 14)
        fx[nfx++] = "prayed";
    if (!strcmp(action, "search") && nfx < 14)
        fx[nfx++] = "searched";
    if (g->operation.item_letter && nfx < 14) {
        size_t i;
        for (i = 0; i < g->ninv; i++)
            if (g->inv[i].letter == g->operation.item_letter &&
                g->inv[i].label) {
                snprintf(resolved, sizeof resolved, "resolved:%s",
                         g->inv[i].label);
                fx[nfx++] = resolved;
                break;
            }
    }
    if (g->operation.fail_code[0])
        blocked = 1;
    else if (heard_has(g, msg_start0, msg_count0, FX_BLOCKED)) {
        static const char *const locked[] = { "door is locked", NULL };
        blocked = 1;
        reason = heard_has(g, msg_start0, msg_count0, locked) ? "lockedDoor" : "notPossible";
    }
    if (activity) {
        blocked = 0;
        reason = activity == 2 ? "activityStopped" : NULL;
    }
    if (!cancelled && !blocked && !strcmp(action, "move") &&
        !pos_changed && turn1 == turn0 && !nfx) {
        blocked = 1;
        reason = "noProgress";
    }
    if (!g->structured_perception && (action_takes_item(action) || !strcmp(action, "search"))) {
        /* Older engines cannot publish current belongings at a boundary. */
        g->inventory_rev = -1;
        g->floor_valid = 0;
        if (g->pending.waiting && !strcmp(g->pending.kind, "key"))
            refresh_inventory(x, g);
    }
    g->have_operation = 0;
    g->operation.decision_id[0] = '\0';
    sidecar_save(g);
    if (g->operation.fail_code[0])
        return envelope(g, req_id, action,
                        cancelled ? "cancelled" : "blocked",
                        g->operation.fail_code,
                        turn1 - turn0, pos_changed, fx, nfx, ev_from,
                        0, 0, g->operation.fail_code, g->operation.fail_msg);
    return envelope(g, req_id, action,
                    activity == 2 ? "interrupted" : cancelled ? "cancelled" : (blocked ? "blocked" : "completed"),
                    reason, turn1 - turn0, pos_changed, fx, nfx, ev_from,
                    0, 0, NULL, NULL);
}

/* Suspend a driven action on a typed engine decision. The operation keeps
 * the script position so the reply continues exactly once. */
static char *
drive_suspend(game_t *g, const char *req_id,
              int turn0, int you0_x, int you0_y, int had_you,
              long long ev_from)
{
    const char *action = g->operation.action;
    int turn1 = turn_of(g);
    int pos_changed = 0;
    if (g->have_you && had_you &&
        (g->you_x != you0_x || g->you_y != you0_y))
        pos_changed = 1;
    else if (g->have_you != had_you)
        pos_changed = 1;
    g->have_operation = 1;
    sidecar_save(g);
    return envelope(g, req_id, action, "needsChoice", NULL,
                    turn1 - turn0, pos_changed, NULL, 0, ev_from,
                    1, 0, NULL, NULL);
}

/* Abort the scripted flow at a prompt we cannot continue: dismiss that
 * prompt without choosing, then settle as blocked at the resting key. */
static int
drive_abort(game_t *g, const char *code, const char *msg)
{
    char line[160];
    snprintf(g->operation.fail_code, sizeof g->operation.fail_code,
             "%s", code);
    snprintf(g->operation.fail_msg, sizeof g->operation.fail_msg,
             "%s", msg);
    if (!strcmp(g->pending.kind, "menu"))
        snprintf(line, sizeof line,
                 "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"picks\":[],\"counts\":[]}}",
                 g->pending.id);
    else if (!strcmp(g->pending.kind, "yn"))
        snprintf(line, sizeof line,
                 "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"answer\":\"\\u001b\"}}",
                 g->pending.id);
    else if (!strcmp(g->pending.kind, "extcmd"))
        snprintf(line, sizeof line,
                 "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"index\":-1}}",
                 g->pending.id);
    else if (!strcmp(g->pending.kind, "poskey"))
        snprintf(line, sizeof line,
                 "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"key\":27}}",
                 g->pending.id);
    else
        return 1;               /* key prompt: settle directly */
    if (send_engine(g, line) < 0)
        return 0;
    pending_clear(g);
    return 1;
}

/* Bind only the chosen perceived object's engine identity. Sorting, naming,
 * prices and accelerators cannot select another object. Older pins without a
 * binding fail explicitly; no label/ordinal fallback. */
static int
drive_pickup_menu(game_t *g)
{
    menu_t *m = menu_for(g, g->pending.window, 0);
    size_t k;
    long long want = g->operation.floor_object_id;
    char line[1024];
    mj_Buf b;
    int idx = -1, bindings = 0, matches = 0;
    if (want <= 0) return -1;
    if (m) for (k = 0; k < m->nitems; k++) {
        if (!menu_selectable(&m->items[k])) continue;
        bindings += m->items[k].object_id > 0;
        if (m->items[k].object_id == want) { idx = m->items[k].index; matches++; }
    }
    if (!bindings) return -1;
    if (idx < 0 || matches != 1) return 0;
    menu_clear(m); m->used = 0;
    mj_init(&b);
    mj_obj(&b);
    mj_key(&b, "picks");
    mj_arr(&b);
    mj_intv(&b, idx);
    mj_endarr(&b);
    mj_key(&b, "counts");
    mj_arr(&b);
    mj_endarr(&b);
    mj_endobj(&b);
    if (!b.ok || !b.buf) {
        mj_free(&b);
        return 0;
    }
    snprintf(line, sizeof line,
             "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":%s}",
             g->pending.id, b.buf);
    mj_free(&b);
    if (send_engine(g, line) < 0)
        return -2;
    pending_clear(g);
    return 1;
}

/* Drive one scripted action to its next resting point. The command key,
 * letters, directions, and confirmations are answered inline; anything
 * needing a real choice suspends with a typed decision. Bounded: at most
 * 12 engine answers per call, then the standing offer is reported. */
static char *
drive_loop(nhx_t *x, game_t *g, const char *req_id,
           int turn0, int you0_x, int you0_y, int had_you,
           long long ev_from, int *bumped, int cancelled)
{
    const char *action = g->operation.action;
    int cmd = g->operation.cmdkey != -2 ? g->operation.cmdkey
        : cmdkey_of(action);
    size_t msg_start0 = (size_t) ev_from, msg_count0 = g->msg_count;
    int step;
    (void) x;
    if (!g->operation.keypos && equipment_action(action)) {
        size_t i;
        for (i = 0; i < g->ninv; i++)
            if (g->inv[i].letter == g->operation.item_letter && eligible_carried(g, action, &g->inv[i])) break;
        if (i == g->ninv)
            return envelope_error(g, req_id, action, "equipmentKnowledgeUnavailable", "chosen equipment is not currently available; no substitute was selected");
        cmd = g->operation.cmdkey = equipment_key(action, g->inv[i].category);
    }
    /* The engine holds an unanswered resting prompt: answer it first.
     * Awaiting before sending would hang until the timeout, since the
     * engine emits nothing new while its prompt stands. */
    if (g->pending.waiting &&
        (!strcmp(g->pending.kind, "key") ||
         !strcmp(g->pending.kind, "poskey")) &&
        g->operation.keypos == 0 && cmd >= 0) {
        if (answer_key(g, g->pending.id, cmd) < 0)
            return envelope_error(g, req_id, action, "engineError",
                                  "write failed");
        pending_clear(g);
        g->operation.keypos = 1;
        bump_once(g, bumped);
    }
    for (step = 0; step < 12; step++) {
        int r = await_prompt(g, ACT_TIMEOUT_MS);
        if (r < 0)
            return envelope_error(g, req_id, action, "engineTimeout",
                                  "the engine stopped answering");
        floor_track(g);
        if (g->ended || r == 0)
            return drive_settle(x, g, req_id, turn0, you0_x, you0_y,
                                had_you, ev_from, msg_start0, msg_count0,
                                cancelled);
        if (!strcmp(g->pending.kind, "key") ||
            !strcmp(g->pending.kind, "poskey")) {
            if (g->operation.keypos == 0 && cmd >= 0) {
                if (answer_key(g, g->pending.id, cmd) < 0)
                    return envelope_error(g, req_id, action, "engineError",
                                          "write failed");
                pending_clear(g);
                g->operation.keypos = 1;
                bump_once(g, bumped);
                continue;
            }
            return drive_settle(x, g, req_id, turn0, you0_x, you0_y,
                                had_you, ev_from, msg_start0, msg_count0,
                                cancelled);
        }
        if (!strcmp(g->pending.kind, "menu")) {
            if (!strcmp(action, "pickup") &&
                g->operation.floor_index >= 0) {
                int picked = drive_pickup_menu(g);
                if (picked == 1) continue;
                if (picked == -2) return envelope_error(g, req_id, action, "engineError", "write failed");
                if (!drive_abort(g, picked < 0 ? "itemMappingUnavailable" : "staleReference",
                                 picked < 0 ? "this pinned engine did not bind the offered objects; no item was guessed" : "the chosen object is not uniquely offered here"))
                    return envelope_error(g, req_id, action, "engineError",
                                          "write failed");
                continue;
            }
            if (g->operation.item_letter && action_takes_item(action)) {
                menu_t *m = menu_for(g, g->pending.window, 0);
                size_t k;
                int idx = -1;
                if (m) {
                    for (k = 0; k < m->nitems; k++)
                        if (m->items[k].accel ==
                            (int) g->operation.item_letter) {
                            idx = m->items[k].index;
                            break;
                        }
                    menu_clear(m);
                    m->used = 0;
                }
                if (idx >= 0) {
                    char line[256];
                    snprintf(line, sizeof line,
                             "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"picks\":[%d],\"counts\":[]}}",
                             g->pending.id, idx);
                    if (send_engine(g, line) < 0)
                        return envelope_error(g, req_id, action,
                                              "engineError", "write failed");
                    pending_clear(g);
                    bump_once(g, bumped);
                    continue;
                }
                if (!drive_abort(g, "noMatch",
                                 "the world did not offer that item"))
                    return envelope_error(g, req_id, action, "engineError",
                                          "write failed");
                continue;
            }
            return drive_suspend(g, req_id, turn0, you0_x, you0_y,
                                 had_you, ev_from);
        }
        if (!strcmp(g->pending.kind, "yn")) {
            int bare = !g->pending.choices || !g->pending.choices[0];
            char line[256];
            if (bare && is_direction_prompt(g->pending.prompt)) {
                if (g->operation.dir_code >= 0) {
                    snprintf(line, sizeof line,
                             "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"answer\":\"%c\"}}",
                             g->pending.id,
                             (char) g->operation.dir_code);
                    if (send_engine(g, line) < 0)
                        return envelope_error(g, req_id, action,
                                              "engineError", "write failed");
                    pending_clear(g);
                    bump_once(g, bumped);
                    continue;
                }
                return drive_suspend(g, req_id, turn0, you0_x, you0_y,
                                     had_you, ev_from);
            }
            if (bare && is_letter_prompt(g->pending.prompt) &&
                g->operation.item_letter &&
                g->operation.letter_answers < 2) {
                snprintf(line, sizeof line,
                         "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"answer\":\"%c\"}}",
                         g->pending.id, g->operation.item_letter);
                if (send_engine(g, line) < 0)
                    return envelope_error(g, req_id, action, "engineError",
                                          "write failed");
                pending_clear(g);
                g->operation.letter_answers++;
                bump_once(g, bumped);
                continue;
            }
            if (bare && is_letter_prompt(g->pending.prompt)) {
                /* No resolved letter, or the world keeps asking: never
                 * guess slots and never spin. */
                if (!drive_abort(g, "noMatch",
                                 "the world asked for an item with no selection"))
                    return envelope_error(g, req_id, action, "engineError",
                                          "write failed");
                continue;
            }
            if (bare && !strcmp(action, "eat") &&
                g->operation.floor_index >= 0 &&
                g->pending.prompt &&
                (label_has(g->pending.prompt, "eat it") ||
                 (label_has(g->pending.prompt, "here") &&
                  label_has(g->pending.prompt, "eat")))) {
                /* Floor-food confirmation merely continues the explicit
                 * selection; danger warnings carry choices and surface. */
                snprintf(line, sizeof line,
                         "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"answer\":\"y\"}}",
                         g->pending.id);
                if (send_engine(g, line) < 0)
                    return envelope_error(g, req_id, action, "engineError",
                                          "write failed");
                pending_clear(g);
                bump_once(g, bumped);
                continue;
            }
            if (bare && (g->pending.def == 'y' || g->pending.def == 'Y' ||
                         g->pending.def == 'n' || g->pending.def == 'N')) {
                /* A bare prompt with a yes/no default (quest-style):
                 * a boolean confirmation, never a letter. */
                return drive_suspend(g, req_id, turn0, you0_x, you0_y,
                                     had_you, ev_from);
            }
            if (bare && is_quantity_prompt(g->pending.prompt)) {
                /* Count prompts are single characters engine-side; the
                 * text decision carries them without letter leakage. */
                return drive_suspend(g, req_id, turn0, you0_x, you0_y,
                                     had_you, ev_from);
            }
            if (bare) {
                if (!drive_abort(g, "unknownPrompt",
                                 "the world asked something unanswerable"))
                    return envelope_error(g, req_id, action, "engineError",
                                          "write failed");
                continue;
            }
            if (yn_is_confirm(g->pending.choices))
                return drive_suspend(g, req_id, turn0, you0_x, you0_y,
                                     had_you, ev_from);
            return drive_suspend(g, req_id, turn0, you0_x, you0_y,
                                 had_you, ev_from);
        }
        if (!strcmp(g->pending.kind, "extcmd")) {
            if (!strcmp(action, "pray")) {
                size_t i;
                long found = -1;
                for (i = 0; i < g->pending.ncommands; i++)
                    if (!strcmp(g->pending.commands[i], "pray")) {
                        found = (long) i;
                        break;
                    }
                if (found >= 0) {
                    char line[256];
                    snprintf(line, sizeof line,
                             "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"index\":%ld}}",
                             g->pending.id, found);
                    if (send_engine(g, line) < 0)
                        return envelope_error(g, req_id, action,
                                              "engineError", "write failed");
                    pending_clear(g);
                    bump_once(g, bumped);
                    continue;
                }
                if (!drive_abort(g, "unsupportedAction",
                                 "prayer is not available here"))
                    return envelope_error(g, req_id, action, "engineError",
                                          "write failed");
                continue;
            }
            return drive_suspend(g, req_id, turn0, you0_x, you0_y,
                                 had_you, ev_from);
        }
        if (!strcmp(g->pending.kind, "getlin"))
            return drive_suspend(g, req_id, turn0, you0_x, you0_y,
                                 had_you, ev_from);
        if (!drive_abort(g, "unknownPrompt",
                         "the world asked something unanswerable"))
            return envelope_error(g, req_id, action, "engineError",
                                  "write failed");
    }
    return envelope_error(g, req_id, action, "engineBusy",
                          "the action did not settle; answer the standing offer");
}

/* Quantity and other single-character text answers ride the text
 * decision; getlin takes the full line. */
static int
emit_text_decision(game_t *g, mj_Buf *b, char *kind_out, size_t kind_cap)
{
    mj_key(b, "decision");
    mj_obj(b);
    mj_key(b, "id");
    mj_strv(b, offer_id(g, "text"));
    mj_key(b, "kind");
    mj_strv(b, "text");
    snprintf(kind_out, kind_cap, "%s", "text");
    mj_key(b, "action");
    mj_strv(b, g->operation.action[0] ? g->operation.action : "act");
    if (g->pending.prompt && g->pending.prompt[0]) {
        mj_key(b, "about");
        mj_strv(b, g->pending.prompt);
    }
    mj_key(b, "cancellable");
    mj_boolv(b, 1);
    mj_endobj(b);
    return 1;
}

/* Item candidates as a synthetic decision: no engine prompt is held, so
 * listing costs no turn and no revision. */
static int
emit_item_decision(game_t *g, mj_Buf *b, const char *action)
{
    cand_t pool[128];
    size_t n, i;
    const char *about = "Choose an item";
    if (!strcmp(action, "eat"))
        about = "Choose something to eat";
    else if (!strcmp(action, "drink"))
        about = "Choose something to drink";
    else if (!strcmp(action, "zap"))
        about = "Choose a wand to zap";
    else if (!strcmp(action, "wield"))
        about = "Choose something to wield";
    else if (!strcmp(action, "equip") || !strcmp(action, "wear"))
        about = "Choose something to wear";
    else if (!strcmp(action, "remove") || !strcmp(action, "takeoff"))
        about = "Choose something to take off";
    else if (!strcmp(action, "read"))
        about = "Choose something to read";
    else if (!strcmp(action, "apply"))
        about = "Choose something to apply";
    else if (!strcmp(action, "drop"))
        about = "Choose something to drop";
    else if (!strcmp(action, "pickup"))
        about = "Choose something to pick up";
    n = collect_candidates(g, action, pool, sizeof pool / sizeof pool[0]);
    mj_key(b, "decision");
    mj_obj(b);
    mj_key(b, "id");
    mj_strv(b, offer_synth_id(g, "item"));
    mj_key(b, "kind");
    mj_strv(b, "item");
    mj_key(b, "action");
    mj_strv(b, action);
    mj_key(b, "about");
    mj_strv(b, about);
    mj_key(b, "selection");
    mj_obj(b);
    mj_key(b, "min"); mj_intv(b, 1);
    mj_key(b, "max"); mj_intv(b, 1);
    mj_endobj(b);
    mj_key(b, "cancellable");
    mj_boolv(b, 1);
    mj_key(b, "options");
    mj_arr(b);
    for (i = 0; i < n; i++) {
        mj_obj(b);
        mj_key(b, "id"); mj_strv(b, pool[i].ref);
        mj_key(b, "label"); mj_strv(b, pool[i].label);
        mj_key(b, "location");
        mj_strv(b, pool[i].location ? "here" : "inventory");
        mj_key(b, "quantity"); mj_intv(b, pool[i].quantity);
        mj_endobj(b);
    }
    mj_endarr(b);
    mj_endobj(b);
    return 1;
}

/* Envelope for synthetic (engine-free) outcomes: listings, miss reports.
 * No turn passes and the revision does not move. */
static char *
envelope_synth(game_t *g, const char *req_id, const char *action,
               const char *status, long long ev_from, int want_item,
               const char *err_code, const char *err_msg)
{
    mj_Buf b;
    if (g->recovery_required || g->sidecar_corrupt || g->sidecar_error[0] || g->input_error[0]) want_item = 0;
    char dec_kind[16] = "";
    mj_init(&b);
    mj_obj(&b);
    mj_key(&b, "sessionId"); mj_strv(&b, g->id);
    mj_key(&b, "requestId");
    if (req_id)
        mj_strv(&b, req_id);
    else
        mj_nullv(&b);
    mj_key(&b, "revision"); mj_intv(&b, g->revision);
    mj_key(&b, "outcome"); mj_obj(&b);
    mj_key(&b, "action"); mj_strv(&b, action);
    mj_key(&b, "status"); mj_strv(&b, status);
    if (err_code) {
        mj_key(&b, "reason"); mj_strv(&b, err_code);
    }
    mj_key(&b, "turnsElapsed"); mj_intv(&b, 0);
    mj_key(&b, "positionChanged"); mj_boolv(&b, 0);
    mj_key(&b, "effects"); mj_arr(&b);
    mj_endarr(&b);
    mj_endobj(&b);
    emit_observation(g, &b);
    emit_events_window(g, &b, ev_from);
    if (want_item && emit_item_decision(g, &b, g->operation.action[0] ? g->operation.action : action)) {
        snprintf(dec_kind, sizeof dec_kind, "%s", "item");
        sidecar_save(g);
    } else {
        mj_key(&b, "decision"); mj_nullv(&b);
    }
    mj_key(&b, "ended"); mj_boolv(&b, g->ended || g->terminal_kind[0]);
    emit_end(g, &b);
    if (err_code) {
        mj_key(&b, "error"); mj_obj(&b);
        mj_key(&b, "code"); mj_strv(&b, err_code);
        mj_key(&b, "message"); mj_strv(&b, err_msg ? err_msg : "");
        mj_endobj(&b);
    }
    (void) dec_kind;
    mj_endobj(&b);
    return mj_take(&b);
}

/* ---------------- actions ---------------- */

static int
move_code(const char *dir)
{
    static const struct {
        const char *name;
        int code;
    } moves[] = {
        { "north", 107 }, { "n", 107 }, { "south", 106 }, { "s", 106 },
        { "west", 104 }, { "w", 104 }, { "east", 108 }, { "e", 108 },
        { "northwest", 121 }, { "nw", 121 }, { "northeast", 117 }, { "ne", 117 },
        { "southwest", 98 }, { "sw", 98 }, { "southeast", 110 }, { "se", 110 },
        { "up", 60 }, { "down", 62 },
    };
    size_t i;
    if (!dir)
        return -1;
    for (i = 0; i < sizeof moves / sizeof moves[0]; i++)
        if (!strcmp(dir, moves[i].name))
            return moves[i].code;
    return -1;
}

/* Canonical args key for idempotency (fixed field order per action). */
static void
args_key_of(const char *args, mj_Buf *b)
{
    static const char *const fields[] = {
        "action", "direction", "target", "item", "replyTo", "confirm",
        "choose", "text", "cancel", "quantity", NULL
    };
    mj_val v;
    size_t i;
    mj_obj(b);
    for (i = 0; fields[i]; i++) {
        char *canonical;
        if (!mj_find(args, fields[i], &v)) continue;
        canonical = mj_canonical(v);
        if (!canonical) { b->ok = 0; break; }
        mj_key(b, fields[i]);
        mj_rawv(b, canonical);
        free(canonical);
    }
    mj_endobj(b);
}

/* ---------------- tools ---------------- */

static void
gen_session_id(char *out, size_t cap)
{
    static unsigned counter = 0;
    unsigned long t = (unsigned long) time(NULL);
    uint32_t entropy = (uint32_t) clock() ^ (uint32_t) getpid();
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd >= 0) { ssize_t n = read(fd, &entropy, sizeof entropy); (void) n; close(fd); }
    snprintf(out, cap, "g-%lx-%x-%x-%08x", t, (unsigned) getpid(), counter++, entropy);
}

static int
identity_index(const char *args, const char *field, const char *const *list,
               size_t n, int *present)
{
    mj_val v;
    long long num;
    char *s;
    *present = 0;
    if (!mj_find(args, field, &v) || mj_is_null(v))
        return -1;
    if (mj_int(v, &num)) {
        if (num < 0 || num >= (long long) n)
            return -2;
        *present = 1;
        return (int) num;
    }
    if ((s = mj_str(v)) != NULL) {
        int idx = name_index(list, n, s);
        free(s);
        if (idx < 0)
            return -2;
        *present = 1;
        return idx;
    }
    return -2;
}

static char *
run_new_game(nhx_t *x, const char *args, const char *req_id)
{
    char id[65];
    game_t *g;
    mj_val v;
    char *s;
    long long seed = -1;
    int has_seed = 0;
    int role = -1, race = -1, gender = -1, align = -1;
    int prole = 0, prace = 0, pgender = 0, palign = 0;
    char *name = NULL;
    mj_Buf pb;
    char line[1024];
    int r;
    long long ev_from;
    if (mj_find(args, "sessionId", &v) && (s = mj_str(v)) != NULL) {
        if (!valid_id(s)) {
            free(s);
            return fail_envelope("", req_id, "badSessionId", "bad session id");
        }
        snprintf(id, sizeof id, "%s", s);
        free(s);
    } else {
        gen_session_id(id, sizeof id);
    }
    if (mj_find(args, "name", &v) && !mj_is_null(v)) {
        name = mj_str(v);
        if (!name)
            return fail_envelope(id, req_id, "badIdentity", "bad name");
    }
    if (mj_find(args, "seed", &v) && !mj_is_null(v)) {
        if (!mj_int(v, &seed))
            return fail_envelope(id, req_id, "badIdentity", "bad seed");
        has_seed = 1;
    }
    if (!has_seed) {
        uint32_t entropy = (uint32_t) time(NULL) ^ (uint32_t) getpid();
        int fd = open("/dev/urandom", O_RDONLY);
        if (fd >= 0) { ssize_t got = read(fd, &entropy, sizeof entropy); (void) got; close(fd); }
        seed = (long long) entropy;
        has_seed = 1; /* explicit in the input log, so omitted seeds replay */
    }
    role = identity_index(args, "role", ROLES, 13, &prole);
    race = identity_index(args, "race", RACES, 5, &prace);
    gender = identity_index(args, "gender", GENDERS, 2, &pgender);
    align = identity_index(args, "align", ALIGNS, 3, &palign);
    if (role == -2 || race == -2 || gender == -2 || align == -2) {
        free(name);
        return fail_envelope(id, req_id, "badIdentity",
                             "role archeologist..wizard, race human..orc, gender male/female, align lawful/neutral/chaotic");
    }
    g = game_get(x, id, 1);
    if (!g) {
        free(name);
        return fail_envelope(id, req_id, "noGame", "cannot create session");
    }
    if (g->recording_only) { free(name); return fail_envelope(id, req_id, "readOnlyRecording", "a reconstructed recording cannot be used as a live world"); }
    if (g->sidecar_present || g->sidecar_error[0]) { free(name); return fail_envelope(id, req_id, "sessionExists", "this id contains semantic metadata; it cannot be replaced with a new game"); }
    if (lease_acquire(g) < 0) { free(name); return lease_error(g, req_id); }
    /* Never truncate an existing run merely because a caller reused an id. */
    {
        char history[PATH_MAX];
        struct stat st;
        if (snprintf(history, sizeof history, "%s/input.log.jsonl", g->dir) >= (int) sizeof history ||
            (stat(history, &st) == 0 && st.st_size > 0)) {
            free(name);
            return fail_envelope(id, req_id, "sessionExists", "this world already exists; resume it instead");
        }
    }
    {
        char archive[PATH_MAX]; struct stat st;
        snprintf(archive, sizeof archive, "%s/perceptions.jsonl", g->dir);
        if (!lstat(archive, &st)) {
            free(name);
            return fail_envelope(id, req_id, "sessionExists", "a checkpoint journal already exists; never replace it with a new game");
        }
    }
    if (record_prepare(g, 1)) { free(name); return fail_envelope(id, req_id, "recordingUnavailable", g->recording_error); }
    /* fresh world: reset semantic state and history */
    if (g->eng) {
        nh_session_close(g->eng);
        g->eng = NULL;
    }
    tracked_clear(g);
    g->revision = 0;
    g->boundary_complete = 0; g->recovery_required = 0; g->sidecar_input_bytes = 0; g->input_ready = 0;
    g->have_operation = 0;
    g->operation.decision_id[0] = '\0';
    g->next_decision = 1;
    g->next_ref = 1;
    g->inventory_rev = -1;
    {
        req_entry_t *e;
        while ((e = g->requests) != NULL) {
            g->requests = e->next;
            free(e->rid);
            free(e->args_key);
            free(e->result);
            free(e);
        }
        g->nrequests = 0;
    }
    {
        char path[PATH_MAX];
        FILE *f;
        snprintf(path, sizeof path, "%s/input.log.jsonl", g->dir);
        {
            int fd = record_regular(path, O_WRONLY | O_CREAT | O_EXCL);
            if (fd < 0) { free(name); return fail_envelope(id, req_id, "storageError", "cannot create a new input journal without replacing existing bytes"); }
            f = fdopen(fd, "w");
            if (!f) { close(fd); free(name); return fail_envelope(id, req_id, "storageError", "cannot create input journal"); }
            { int ok = fsync(fd) == 0; if (fclose(f)) ok = 0;
              if (!ok || record_dir_sync(g)) { free(name); return fail_envelope(id, req_id, "storageError", "cannot commit new input journal"); }
            }
        }
    }
    if (sidecar_save(g)) { free(name); return fail_envelope(id, req_id, "metadataUnavailable", g->sidecar_error); }
    if (spawn_game(x, g) < 0) {
        free(name);
        return fail_envelope(id, req_id, "engineError", "cannot start engine");
    }
    if (send_engine(g, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"0.1\"}}") < 0) {
        free(name);
        return fail_envelope(id, req_id, "engineError", "initialize failed");
    }
    mj_init(&pb);
    mj_obj(&pb);
    if (has_seed) {
        mj_key(&pb, "seed");
        mj_intv(&pb, seed);
    }
    if (name) {
        mj_key(&pb, "name");
        mj_strv(&pb, name);
    }
    if (prole) {
        mj_key(&pb, "role");
        mj_intv(&pb, role);
    }
    if (prace) {
        mj_key(&pb, "race");
        mj_intv(&pb, race);
    }
    if (pgender) {
        mj_key(&pb, "gender");
        mj_intv(&pb, gender);
    }
    if (palign) {
        mj_key(&pb, "align");
        mj_intv(&pb, align);
    }
    mj_endobj(&pb);
    snprintf(line, sizeof line,
             "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"new_game\",\"params\":%s}",
             pb.ok && pb.buf ? pb.buf : "{}");
    mj_free(&pb);
    free(name);
    ev_from = g->event_seq;
    if (send_engine(g, line) < 0)
        return fail_envelope(id, req_id, "engineError", "new_game failed");
    r = await_prompt(g, ACT_TIMEOUT_MS);
    if (r < 0)
        return fail_envelope(id, req_id, "engineTimeout", "no prompt after new_game");
    {
        /* Startup identity: "Shall I pick ... for you?" takes 'a' to let
         * the world pick everything (deterministic under the seed) and
         * start at once. Anything else stands as a typed decision. */
        int tries;
        for (tries = 0; tries < 4 && r == 1; tries++) {
            if (strcmp(g->pending.kind, "yn") || !g->pending.prompt ||
                !label_has(g->pending.prompt, "pick"))
                break;
            snprintf(line, sizeof line,
                     "{\"jsonrpc\":\"2.0\",\"id\":%lld,\"result\":{\"answer\":\"a\"}}",
                     g->pending.id);
            if (send_engine(g, line) < 0)
                break;
            pending_clear(g);
            r = await_prompt(g, ACT_TIMEOUT_MS);
        }
        if (r < 0)
            return fail_envelope(id, req_id, "engineTimeout",
                                 "no prompt after new_game");
    }
    if (r == 0 || g->ended) {
        g->have_operation = 0;
        sidecar_save(g);
        return envelope(g, req_id, "new_game", "completed", NULL, 0, 0,
                        NULL, 0, ev_from, 0, 0, NULL, NULL);
    }
    /* establish known inventory while the deed slot is free */
    refresh_inventory(x, g);
    if (!strcmp(g->pending.kind, "key") || !strcmp(g->pending.kind, "poskey")) {
        return envelope(g, req_id, "new_game", "completed", NULL, 0, 0,
                        NULL, 0, ev_from, 0, 0, NULL, NULL);
    }
    snprintf(g->operation.action, sizeof g->operation.action, "new_game");
    g->have_operation = 1;
    sidecar_save(g);
    return envelope(g, req_id, "new_game", "needsChoice", NULL, 0, 0,
                    NULL, 0, ev_from, 1, 0, NULL, NULL);
}

static char *
run_get_state(nhx_t *x, game_t *g, const char *req_id)
{
    (void) x;
    if (!g->eng && !(g->ended && strcmp(g->end_reason, "saved")))
        return fail_envelope(g->id, req_id, "noGame", "no live engine; resume first");
    if (g->eng && !g->ended && nh_session_ended(g->eng)) {
        g->ended = 1;
        snprintf(g->end_reason, sizeof g->end_reason, "engineError");
    }
    if (g->recovery_required)
        return envelope_error(g, req_id, "get_state", "recoveryRequired", "semantic boundary is unresolved; no answer was inferred");
    /* Read-only: return the standing offer without changing its identity. */
    if (!g->ended && g->have_operation && g->operation.dec_pending == -2)
        return envelope_synth(g, req_id, "get_state", "completed",
                              g->event_seq, 1, NULL, NULL);
    return envelope(g, req_id, "get_state", "completed", NULL, 0, 0,
                    NULL, 0, g->event_seq, g->have_operation, 0, NULL, NULL);
}

static char *
run_resume(nhx_t *x, game_t *g, const char *req_id)
{
    size_t nlog = 0, i;
    char **log = NULL;
    long long ev_from;
    int recover;
    const char *code = "replayMismatch", *message = "stored answers did not match the pinned engine";
    int acquired = lease_acquire(g);
    if (acquired < 0) return lease_error(g, req_id);
    if (acquired) semantic_reload(g);
    if (g->recording_only)
        return fail_envelope(g->id, req_id, "readOnlyRecording", "this is a derived recording, not a live world; use the read-only archive viewer");
    if (g->sidecar_corrupt || !g->sidecar_present)
        return fail_envelope(g->id, req_id, "metadataUnavailable", g->sidecar_error[0] ? g->sidecar_error : "semantic metadata is missing; it was not reset or invented");
    log = log_read(g, &nlog);
    if (!log || nlog < 2) {
        for (i = 0; i < nlog; i++) free(log[i]);
        free(log);
        return fail_envelope(g->id, req_id, "inputHistoryError", g->input_error[0] ? g->input_error : "no complete initialization to resume");
    }
    if (record_prepare(g, 1)) {
        for (i = 0; i < nlog; i++) free(log[i]);
        free(log);
        return fail_envelope(g->id, req_id, "recordingUnavailable", g->recording_error);
    }
    if (g->sidecar_input_bytes > g->input_bytes) {
        for (i = 0; i < nlog; i++) free(log[i]);
        free(log);
        return fail_envelope(g->id, req_id, "inputHistoryError", "input journal is shorter than the semantic checkpoint; no engine was started");
    }
    recover = g->recovery_required || !g->boundary_complete ||
        (g->sidecar_input_bytes >= 0 && g->sidecar_input_bytes != g->input_bytes);
    if (g->sidecar_error[0]) {
        g->sidecar_error[0] = 0; /* Explicit warm recovery may commit intact RAM state. */
        if (sidecar_save(g)) {
            for (i = 0; i < nlog; i++) free(log[i]);
            free(log);
            return fail_envelope(g->id, req_id, "metadataUnavailable", g->sidecar_error);
        }
    }
    if (g->eng) { nh_session_abort(g->eng); g->eng = NULL; }
    tracked_clear(g);
    if (spawn_game(x, g) < 0) { code = "engineError"; message = "cannot start pinned engine"; goto replay_failed; }
    ev_from = g->event_seq;
    g->replaying = 1;
    g->deadline_ms = monotonic_ms() + 120000;
    if (send_raw(g, log[0]) || send_raw(g, log[1])) goto replay_failed;
    for (i = 2; ; i++) {
        int r = await_prompt(g, ACT_TIMEOUT_MS);
        if (r < 0) { code = "replayTimeout"; message = "pinned replay did not reach a bounded input point"; goto replay_failed; }
        if (i == nlog) break;
        if (r != 1 || !input_matches_prompt(g, log[i]) || recon_unsafe_answer(g, log[i])) goto replay_failed;
        if (send_raw(g, log[i])) goto replay_failed;
        pending_clear(g);
    }
    g->replaying = 0; g->deadline_ms = 0;
    for (i = 0; i < nlog; i++) free(log[i]);
    free(log); log = NULL;
    if (g->terminal_kind[0]) {
        g->ended = 1;
        pending_clear(g);
        g->have_operation = 0;
    }
    if (g->have_operation && g->operation.dec_pending != -2 &&
        g->pending.waiting) {
        /* Rebind only the same logical prompt. A changed kind or captured
         * context is uncertainty, never permission to invent a new offer. */
        const char *dk = g->operation.dec_kind;
        const char *pk = g->pending.kind;
        int fits = (!strcmp(dk, "choice") &&
                    (!strcmp(pk, "menu") || !strcmp(pk, "yn") ||
                     !strcmp(pk, "extcmd"))) ||
            (!strcmp(dk, "confirmation") && !strcmp(pk, "yn")) ||
            (!strcmp(dk, "text") &&
             (!strcmp(pk, "getlin") || !strcmp(pk, "yn"))) ||
            (!strcmp(dk, "target") &&
             (!strcmp(pk, "yn") || !strcmp(pk, "poskey")));
        if (fits && g->operation.prompt_signature[0]) {
            char signature[32]; pending_signature(g, signature);
            fits = !strcmp(signature, g->operation.prompt_signature);
        }
        if (fits) g->operation.dec_pending = g->pending.id;
        else recover = 1;
    }
    if (recover) {
        g->recovery_required = 1; g->boundary_complete = 0; g->have_operation = 0;
        return envelope_error(g, req_id, "resume", "recoveryRequired", "input history extends beyond a verified semantic boundary, or the pending context changed; no new answers were invented");
    }
    refresh_inventory(x, g);
    if (g->have_operation && g->operation.dec_pending == -2)
        return envelope_synth(g, req_id, "resume", "completed", ev_from, 1, NULL, NULL);
    if (g->ended || !g->pending.waiting) {
        g->have_operation = g->have_operation && g->pending.waiting;
        sidecar_save(g);
        return envelope(g, req_id, "resume", "completed", NULL, 0, 0,
                        NULL, 0, ev_from, g->pending.waiting ? 1 : 0, 0,
                        NULL, NULL);
    }
    if (!strcmp(g->pending.kind, "key") || !strcmp(g->pending.kind, "poskey")) {
        return envelope(g, req_id, "resume", "completed", NULL, 0, 0,
                        NULL, 0, ev_from, 0, 0, NULL, NULL);
    }
    sidecar_save(g);
    return envelope(g, req_id, "resume", "needsChoice", NULL, 0, 0,
                    NULL, 0, ev_from, 1, 0, NULL, NULL);
replay_failed:
    g->replaying = 0; g->deadline_ms = 0;
    for (i = 0; i < nlog; i++) free(log[i]);
    free(log);
    if (g->eng) { nh_session_abort(g->eng); g->eng = NULL; }
    tracked_clear(g);
    snprintf(g->input_error, sizeof g->input_error, "%s", message);
    return fail_envelope(g->id, req_id, code, message);
}

static char *
run_end(nhx_t *x, game_t *g, const char *req_id)
{
    (void) x;
    if (!g->eng)
        return fail_envelope(g->id, req_id, "noGame", "this bridge has no live world to leave");
    if (g->eng) {
        if (g->recovery_required || (g->pending.waiting &&
            (g->operation.decision_id[0] || (strcmp(g->pending.kind, "key") && strcmp(g->pending.kind, "poskey")))))
            nh_session_abort(g->eng);
        else nh_session_close(g->eng);
        g->eng = NULL;
    }
    if (!g->ended)
        snprintf(g->end_reason, sizeof g->end_reason, "%s", "saved");
    g->ended = 1;
    pending_clear(g);
    sidecar_save(g);
    return envelope(g, req_id, "end_session", "completed", NULL, 0, 0,
                    NULL, 0, g->event_seq, 0, 0, NULL, NULL);
}

/* Optional {target} for directional actions. Absent stays absent
 * (dir_code -1); "self" becomes '.' (46); positions and entities are
 * rejected before any engine input. Returns 0 ok, -1 with ecode/emsg. */
static int
parse_target_arg(game_t *g, const char *args, int self_allowed,
                 const char **ecode, const char **emsg)
{
    mj_val v;
    g->operation.dir_code = -1;
    if (!mj_find(args, "target", &v) || mj_is_null(v))
        return 0;
    {
        size_t len;
        const char *raw = mj_raw(v, &len);
        if (raw && len > 1 && *raw == '{') {
            char *cpy = malloc(len + 1);
            mj_val dv, pv, ev;
            char *dstr = NULL;
            int ok = 0;
            if (!cpy) {
                *ecode = "outOfMemory";
                *emsg = "out of memory";
                return -1;
            }
            memcpy(cpy, raw, len);
            cpy[len] = '\0';
            if (mj_find(cpy, "position", &pv) ||
                mj_find(cpy, "entity", &ev)) {
                free(cpy);
                *ecode = "invalidTarget";
                *emsg = "this action takes directions or self, not positions or entities";
                return -1;
            }
            if (mj_find(cpy, "direction", &dv))
                dstr = mj_str(dv);
            free(cpy);
            if (!dstr) {
                *ecode = "invalidTarget";
                *emsg = "target needs {\"direction\":\"south\"} or \"self\"";
                return -1;
            }
            {
                int code = move_code(dstr);
                free(dstr);
                if (code < 0) {
                    *ecode = "invalidTarget";
                    *emsg = "unknown direction: north/south/east/west/northeast/northwest/southeast/southwest/up/down";
                    return -1;
                }
                g->operation.dir_code = code;
                ok = 1;
            }
            return ok ? 0 : -1;
        }
    }
    {
        char *t = mj_str(v);
        if (!t || strcmp(t, "self")) {
            free(t);
            *ecode = "invalidTarget";
            *emsg = "target must be \"self\" or {\"direction\":...}";
            return -1;
        }
        free(t);
        if (!self_allowed) {
            *ecode = "invalidTarget";
            *emsg = "this action cannot target self";
            return -1;
        }
        g->operation.dir_code = 46;
        return 0;
    }
}

/* Scripted named actions: zero-turn queries plus the key-driven flows.
 * All validation happens before the first engine write; listings cost
 * no turn and no revision. */
static char *
run_scripted(nhx_t *x, game_t *g, const char *action, const char *args,
             const char *req_id)
{
    int turn0 = turn_of(g);
    int you0_x = g->you_x, you0_y = g->you_y, had_you = g->have_you;
    long long ev_from = g->event_seq;
    int bumped = 0;
    mj_val v;
    const char *ecode = NULL, *emsg = NULL;
    op_start(g, action);
    if (strlen(args) + 1 < sizeof g->operation.args_json)
        snprintf(g->operation.args_json, sizeof g->operation.args_json,
                 "%s", args);
    else
        snprintf(g->operation.args_json, sizeof g->operation.args_json, "{}");
    if (!strcmp(action, "inventory")) {
        if (!ensure_inventory(x, g))
            return envelope_error(g, req_id, action, "inventoryUnknown",
                                  "the world is busy; retry");
        return envelope(g, req_id, action, "completed", NULL, 0, 0,
                        NULL, 0, ev_from, 0, 0, NULL, NULL);
    }
    if (!strcmp(action, "inspect")) {
        char *t = NULL;
        const char *fx[1];
        int nfx = 0;
        const char *code = NULL, *msg = NULL;
        if (mj_find(args, "target", &v) && !mj_is_null(v)) {
            size_t len;
            const char *raw = mj_raw(v, &len);
            if (raw && len > 1 && *raw == '{') {
                code = "invalidTarget";
                msg = "inspect takes \"self\" or \"here\"";
            } else {
                t = mj_str(v);
            }
        }
        if (!code && !t)
            t = strdup("self");
        if (!code) {
            if (!t) {
                code = "invalidTarget";
                msg = "inspect takes \"self\" or \"here\"";
            } else if (!strcmp(t, "self")) {
                fx[0] = "inspectedSelf";
                nfx = 1;
            } else if (!strcmp(t, "here")) {
                fx[0] = "inspectedHere";
                nfx = 1;
            } else {
                code = "invalidTarget";
                msg = "inspect takes \"self\" or \"here\"";
            }
        }
        free(t);
        if (code)
            return envelope_error(g, req_id, action, code, msg);
        return envelope(g, req_id, action, "completed", NULL, 0, 0,
                        fx, nfx, ev_from, 0, 0, NULL, NULL);
    }
    if (!strcmp(action, "climb")) {
        char *d = NULL;
        int code = -1;
        if (mj_find(args, "direction", &v) && (d = mj_str(v)) != NULL) {
            if (!strcmp(d, "down"))
                code = 62;
            else if (!strcmp(d, "up"))
                code = 60;
            free(d);
        }
        if (code < 0)
            return envelope_error(g, req_id, action, "badAction",
                                  "climb needs {direction:up|down}");
        g->operation.cmdkey = code;
        return drive_loop(x, g, req_id, turn0, you0_x, you0_y, had_you,
                          ev_from, &bumped, 0);
    }
    if (!strcmp(action, "kick") || !strcmp(action, "open") ||
        !strcmp(action, "close")) {
        if (parse_target_arg(g, args, 0, &ecode, &emsg) < 0)
            return envelope_error(g, req_id, action, ecode, emsg);
        return drive_loop(x, g, req_id, turn0, you0_x, you0_y, had_you,
                          ev_from, &bumped, 0);
    }
    if (!strcmp(action, "zap")) {
        int rc;
        g->operation.self_ok = 1;
        if (parse_target_arg(g, args, 1, &ecode, &emsg) < 0)
            return envelope_error(g, req_id, action, ecode, emsg);
        rc = resolve_item_arg(x, g, action, args, &ecode, &emsg);
        if (rc == 1 || rc == -2)
            return envelope_synth(g, req_id, action, "needsChoice",
                                  ev_from, 1, NULL, NULL);
        if (rc < 0)
            return envelope_synth(g, req_id, action, "blocked",
                                  ev_from, 0, ecode, emsg);
        return drive_loop(x, g, req_id, turn0, you0_x, you0_y, had_you,
                          ev_from, &bumped, 0);
    }
    if (action_takes_item(action)) {
        int rc;
        int want_item = 1;
        if (!strcmp(action, "pickup") &&
            (!mj_find(args, "item", &v) || mj_is_null(v)))
            want_item = 0;      /* take-all: the ',' key means gather */
        if (want_item) {
            rc = resolve_item_arg(x, g, action, args, &ecode, &emsg);
            if (rc == 1 || rc == -2)
                return envelope_synth(g, req_id, action, "needsChoice",
                                      ev_from, 1, NULL, NULL);
            if (rc < 0)
                return envelope_synth(g, req_id, action, "blocked",
                                      ev_from, 0, ecode, emsg);
        }
        return drive_loop(x, g, req_id, turn0, you0_x, you0_y, had_you,
                          ev_from, &bumped, 0);
    }
    if (!strcmp(action, "pray") || !strcmp(action, "search"))
        return drive_loop(x, g, req_id, turn0, you0_x, you0_y, had_you,
                          ev_from, &bumped, 0);
    if (!strcmp(action, "cast"))
        return envelope_error(g, req_id, action, "unsupportedAction",
                              "spellcasting is not bound yet");
    if (!strcmp(action, "engrave"))
        return envelope_error(g, req_id, action, "unsupportedAction",
                              "engraving is not bound yet");
    if (!strcmp(action, "unlock"))
        return envelope_error(g, req_id, action, "unsupportedAction",
                              "unlock via apply with a key toward the door");
    if (!strcmp(action, "attack"))
        return envelope_error(g, req_id, action, "unsupportedAction",
                              "attack by moving into a hostile creature");
    if (!strcmp(action, "swap"))
        return envelope_error(g, req_id, action, "unsupportedAction",
                              "swap places by moving into an ally");
    return envelope_error(g, req_id, action, "unsupportedAction",
                          "unknown action");
}

/* Answer the standing decision and settle (bounded chain). */
static char *
run_reply(nhx_t *x, game_t *g, const char *args, const char *req_id,
          int turn0, int you0_x, int you0_y, int had_you, long long ev_from)
{
    mj_val v;
    char *reply_to = NULL;
    const char *err = NULL;
    char *ans_line;
    int cancelled = 0;
    (void) x;
    if (!mj_find(args, "replyTo", &v) || (reply_to = mj_str(v)) == NULL)
        return envelope_error(g, req_id, "act", "invalidAnswer", "replyTo required");
    if (!g->have_operation || strcmp(g->operation.decision_id, reply_to)) {
        free(reply_to);
        return envelope_error(g, req_id, "act", "staleDecision",
                              "that offer expired; answer the current decision");
    }
    /* Synthetic listings hold no engine prompt (dec_pending == -2): the
     * branch below validates the resting prompt itself. Engine-bound
     * offers must sit on the live prompt. */
    if (g->operation.dec_pending != -2 &&
        (g->operation.dec_pending != g->pending.id || !g->pending.waiting)) {
        free(reply_to);
        return envelope_error(g, req_id, "act", "staleDecision",
                              "that offer expired; answer the current decision");
    }
    free(reply_to);
    /* A well-shaped answer must still address the actual standing kind.
     * This check is after receipt lookup, so completed replies remain retryable. */
    if (!mj_find(args, "cancel", &v)) {
        const char *field = !strcmp(g->operation.dec_kind, "confirmation") ? "confirm" :
            !strcmp(g->operation.dec_kind, "target") ? "target" :
            !strcmp(g->operation.dec_kind, "text") ? "text" :
            !strcmp(g->operation.dec_kind, "item") && g->operation.dec_pending == -2 ? "item" : "choose";
        if (!mj_find(args, field, &v))
            return g->operation.dec_pending == -2 ?
                envelope_synth(g, req_id, "act", "blocked", ev_from, 1, "invalidAnswer", "answer does not match the standing decision kind") :
                envelope_error(g, req_id, "act", "invalidAnswer", "answer does not match the standing decision kind");
        if (!strcmp(field, "text") && !strcmp(g->pending.kind, "yn")) {
            char *text = mj_str(v);
            int one = text && strlen(text) == 1;
            free(text);
            if (!one) return envelope_error(g, req_id, "act", "invalidAnswer", "this prompt takes exactly one character, not truncated text");
        }
    }
    if (mj_find(args, "cancel", &v)) {
        int c = 0;
        if (mj_bool(v, &c) && c)
            cancelled = 1;
    }
    if (g->operation.dec_pending == -2) {
        /* Synthetic item listing: no engine prompt is held. The world
         * must still hold no decision, or the offer went stale. */
        const char *ecode = NULL, *emsg = NULL;
        int rc;
        if (g->pending.waiting && strcmp(g->pending.kind, "key") &&
            strcmp(g->pending.kind, "poskey"))
            return envelope_error(g, req_id, "act", "staleDecision",
                                  "the world moved on; answer the current decision");
        if (cancelled) {
            const char *action =
                g->operation.action[0] ? g->operation.action : "act";
            g->have_operation = 0;
            g->operation.decision_id[0] = '\0';
            sidecar_save(g);
            return envelope_synth(g, req_id, action, "cancelled",
                                  ev_from, 0, NULL, NULL);
        }
        if (strcmp(g->operation.dec_kind, "item"))
            return envelope_error(g, req_id, "act", "invalidAnswer",
                                  "that offer takes no reply");
        if (!mj_find(args, "item", &v) || mj_is_null(v))
            return envelope_error(g, req_id, "act", "invalidAnswer",
                                  "item decisions need {item:...} or {cancel:true}");
        rc = resolve_item_arg(x, g, g->operation.action, args,
                              &ecode, &emsg);
        if (rc == 1 || rc == -2)
            return envelope_synth(g, req_id, g->operation.action,
                                  "needsChoice", ev_from, 1, NULL, NULL);
        if (rc < 0)
            return envelope_synth(g, req_id, g->operation.action,
                                  "blocked", ev_from, 0, ecode, emsg);
        {
            int bumped = 0;
            return drive_loop(x, g, req_id, turn0, you0_x, you0_y,
                              had_you, ev_from, &bumped, 0);
        }
    }
    ans_line = translate_reply(g, g->operation.dec_kind, args, &err);
    if (!ans_line)
        return envelope_error(g, req_id, "act", "invalidAnswer", err);
    if (send_engine(g, ans_line) < 0) {
        free(ans_line);
        return envelope_error(g, req_id, "act", "engineError", "write failed");
    }
    free(ans_line);
    pending_clear(g);
    {
        /* The reply continues the standing operation exactly once: the
         * driver answers whatever follows until the next rest point. */
        int bumped = 0;
        bump_once(g, &bumped);
        return drive_loop(x, g, req_id, turn0, you0_x, you0_y, had_you,
                          ev_from, &bumped, cancelled);
    }
}

static char *
run_act(nhx_t *x, game_t *g, const char *args, const char *req_id)
{
    mj_val v;
    char *action = NULL, *req_dup = NULL;
    long long exp_rev = -1;
    char *out = NULL;
    if (g->sidecar_corrupt)
        return envelope_error(g, req_id, "act", "metadataUnavailable", g->sidecar_error);
    if (!mj_find(args, "action", &v) || (action = mj_str(v)) == NULL) {
        /* Replies continue the standing operation: no fresh action needed. */
        mj_val rv;
        if (!mj_find(args, "replyTo", &rv))
            return fail_envelope(g->id, req_id, "badAction", "act needs {action:...}");
        action = strdup(g->have_operation && g->operation.action[0] ?
                        g->operation.action : "act");
        if (!action)
            return fail_envelope(g->id, req_id, "outOfMemory", "out of memory");
    }
    if (mj_find(args, "requestId", &v) && (req_dup = mj_str(v)) != NULL) {
        req_entry_t *e;
        mj_Buf kb;
        char *key;
        mj_init(&kb);
        args_key_of(args, &kb);
        key = mj_take(&kb);
        mj_free(&kb);
        e = req_lookup(g, req_dup);
        if (e) {
            int same = !strcmp(e->args_key, key ? key : "");
            free(key);
            if (same) {
                char *res = req_saved_result(g, e);
                if (!res)
                    res = envelope_error(g, req_id, action, "incompleteRequest",
                        "this request was reserved but has no recoverable receipt; inspect the resumed world, do not resend it as a new request automatically");
                free(action);
                free(req_dup);
                return res;
            }
            free(action);
            free(req_dup);
            return envelope_error(g, req_id, "act", "requestConflict",
                                  "requestId reused with different arguments");
        }
        free(key);
    }
    if (g->sidecar_error[0] || g->input_error[0] || g->recovery_required || !g->boundary_complete) {
        const char *code = g->sidecar_error[0] ? "metadataUnavailable" : g->input_error[0] ? "inputHistoryError" : "recoveryRequired";
        out = envelope_error(g, req_id, action, code, "storage or semantic boundary is unresolved; no new input was sent");
        free(action); free(req_dup); return out;
    }
    /* A fatal action's receipt survives engine teardown. */
    if (g->eng && !g->ended && nh_session_ended(g->eng)) {
        g->ended = 1;
        snprintf(g->end_reason, sizeof g->end_reason, "engineError");
    }
    if (g->ended || !g->eng) {
        const char *code = !strcmp(g->end_reason, "saved") ? "noGame" :
            g->ended ? (!strcmp(g->end_reason, "engineError") ? "engineError" : "gameEnded") : "noGame";
        char *error = envelope_error(g, req_id, action, code, "no live world; inspect its final observation or resume saved play");
        free(action); free(req_dup);
        return error;
    }
    if (g->request_index_corrupt) {
        char *error = envelope_error(g, req_id, action, "storageError", "request journal is incomplete or corrupt; no new command was sent");
        free(action); free(req_dup);
        return error;
    }
    if (mj_find(args, "expectedRevision", &v)) {
        long long n;
        if (mj_int(v, &n))
            exp_rev = n;
    }
    if (exp_rev >= 0 && exp_rev != g->revision) {
        char *out = envelope_error(g, req_id, action, "staleRevision", "revision moved; read again");
        free(action);
        free(req_dup);
        return out;
    }
    if (record_prepare(g, 1) || g->recording_gap) {
        char *error = envelope_error(g, req_id, action, "recordingUnavailable",
            g->recording_error[0] ? g->recording_error : "an unrecorded boundary requires resume before another deed; history will retain a gap notice");
        free(action); free(req_dup);
        return error;
    }
    {
        int previous = g->boundary_complete;
        g->boundary_complete = 0;
        if (sidecar_save(g)) {
            g->boundary_complete = previous;
            out = envelope_error(g, req_id, action, "metadataUnavailable", g->sidecar_error);
            free(action); free(req_dup); return out;
        }
    }
    if (req_dup) {
        mj_Buf b;
        char *key;
        int reserved;
        mj_init(&b); args_key_of(args, &b);
        key = b.ok ? mj_take(&b) : NULL;
        mj_free(&b);
        reserved = key ? req_reserve(g, req_dup, key) : -1;
        free(key);
        if (reserved < 0) {
            out = envelope_error(g, req_id, action, "storageError", "request identity could not be committed; no command was sent");
            free(action); free(req_dup);
            return out;
        }
    }
    {
        int turn0 = turn_of(g);
        int you0_x = g->you_x, you0_y = g->you_y, had_you = g->have_you;
        long long ev_from = g->event_seq;
        /* continuation of a standing offer */
        if (mj_find(args, "replyTo", &v)) {
            out = run_reply(x, g, args, req_dup ? req_dup : req_id, turn0,
                            you0_x, you0_y, had_you, ev_from);
            goto remember;
        }
        /* fresh deeds need a free prompt */
        if (g->pending.waiting && strcmp(g->pending.kind, "key") &&
            strcmp(g->pending.kind, "poskey")) {
            out = envelope_error(g, req_id, action, "pendingDecision",
                                 "answer or cancel the standing decision first");
            goto remember;
        }
        /* no decision stands: drop any stale operation record */
        g->have_operation = 0;
        g->operation.decision_id[0] = '\0';
        if (!strcmp(action, "move") || !strcmp(action, "wait")) {
            char *dir = NULL;
            int code = 46, bumped = 0;
            if (mj_find(args, "target", &v) || mj_find(args, "item", &v)) {
                out = envelope_error(g, req_id, action, "invalidTarget",
                                     "move takes direction; wait takes no target or item");
                goto remember;
            }
            if (!strcmp(action, "move")) {
                if (mj_find(args, "direction", &v)) dir = mj_str(v);
                code = move_code(dir); free(dir);
                if (code < 0) {
                    out = envelope_error(g, req_id, action, "badAction", "move needs a compass direction");
                    goto remember;
                }
            }
            op_start(g, action);
            g->operation.cmdkey = code;
            out = drive_loop(x, g, req_id, turn0, you0_x, you0_y, had_you,
                             ev_from, &bumped, 0);
            goto remember;
        }
        if (!strcmp(action, "search") || !strcmp(action, "climb") ||
            !strcmp(action, "kick") || !strcmp(action, "open") ||
            !strcmp(action, "close") || !strcmp(action, "pickup") ||
            !strcmp(action, "eat") || !strcmp(action, "drink") ||
            !strcmp(action, "wield") || !strcmp(action, "equip") ||
            !strcmp(action, "wear") || !strcmp(action, "remove") ||
            !strcmp(action, "takeoff") || !strcmp(action, "read") ||
            !strcmp(action, "apply") || !strcmp(action, "drop") ||
            !strcmp(action, "zap") || !strcmp(action, "pray") ||
            !strcmp(action, "inventory") || !strcmp(action, "inspect")) {
            out = run_scripted(x, g, action, args, req_dup ? req_dup : req_id);
            goto remember;
        }
        out = envelope_error(g, req_id, action, "unsupportedAction",
                             "this build moves, waits, climbs, kicks, opens, picks up, eats, drinks, wields, wears, reads, applies, drops, zaps, prays, searches, inspects, and answers; spellcasting and engraving are not bound yet");
    remember:
        if (req_dup && out) {
            mj_Buf kb;
            char *key;
            mj_init(&kb);
            args_key_of(args, &kb);
            key = mj_take(&kb);
            mj_free(&kb);
            req_remember(g, req_dup, key ? key : "", out);
            free(key);
        }
        free(action);
        free(req_dup);
        return out;
    }
}

static char *
nhx_dispatch(nhx_t *x, const char *request_json)
{
    mj_val v;
    char *tool = NULL, *sid = NULL, *req_id = NULL;
    char *out;
    game_t *g;
    if (!x || !request_json)
        return NULL;
    if (!mj_find(request_json, "tool", &v) || (tool = mj_str(v)) == NULL)
        return fail_envelope("", NULL, "badTool", "request needs {tool:...}");
    if (mj_find(request_json, "sessionId", &v))
        sid = mj_str(v);
    if (mj_find(request_json, "requestId", &v))
        req_id = mj_str(v);
    if (!strcmp(tool, "reconstruct_run")) {
        free(tool); free(sid); free(req_id);
        return run_reconstruct(x, request_json);
    }
    if (!strcmp(tool, "new_game")) {
        free(tool);
        free(sid);
        out = run_new_game(x, request_json, req_id);
        free(req_id);
        return out;
    }
    if (!sid || !valid_id(sid)) {
        free(tool);
        free(sid);
        {
            char *out = fail_envelope("", req_id, "badSessionId", "bad session id");
            free(req_id);
            return out;
        }
    }
    if (!strcmp(tool, "get_state")) {
        g = game_get(x, sid, 0);
        free(tool);
        free(sid);
        if (!g) {
            {
                char *unknown = fail_envelope("", req_id, "unknownSession", "unknown session");
                free(req_id);
                return unknown;
            }
        }
        out = run_get_state(x, g, req_id);
        free(req_id);
        return out;
    }
    if (!strcmp(tool, "resume")) {
        g = game_get(x, sid, 1);
        free(tool);
        free(sid);
        if (!g) {
            {
                char *out = fail_envelope("", req_id, "noGame", "cannot create session");
                free(req_id);
                return out;
            }
        }
        out = run_resume(x, g, req_id);
        free(req_id);
        return out;
    }
    if (!strcmp(tool, "end_session")) {
        g = game_get(x, sid, 0);
        free(tool);
        free(sid);
        if (!g) {
            {
                char *unknown = fail_envelope("", req_id, "unknownSession", "unknown session");
                free(req_id);
                return unknown;
            }
        }
        out = run_end(x, g, req_id);
        free(req_id);
        return out;
    }
    if (!strcmp(tool, "act")) {
        g = game_get(x, sid, 0);
        free(tool);
        free(sid);
        if (!g) {
            {
                char *unknown = fail_envelope("", req_id, "unknownSession", "unknown session");
                free(req_id);
                return unknown;
            }
        }
        out = run_act(x, g, request_json, req_id);
        free(req_id);
        return out;
    }
    free(tool);
    free(sid);
    {
        char *out = fail_envelope("", req_id, "badTool", "unknown tool");
        free(req_id);
        return out;
    }
}

/* Narration and a clean EOF cannot distinguish death, escape and victory. */
static void
emit_end(game_t *g, mj_Buf *b)
{
    const char *kind = "unknown";
    const char *cause = g->terminal_cause[0] ? g->terminal_cause : NULL;
    if (!g->ended && !g->terminal_kind[0])
        return;
    if (g->terminal_kind[0])
        kind = g->terminal_kind;
    else if (!strcmp(g->end_reason, "engineError") || !strcmp(g->end_reason, "protocol"))
        kind = "engineError";
    else if (!strcmp(g->end_reason, "died"))
        kind = "death";
    else if (!strcmp(g->end_reason, "quit"))
        kind = "quit";
    else if (!strcmp(g->end_reason, "saved"))
        kind = "disconnected";
    else if (!strcmp(g->end_reason, "ascended"))
        kind = "ascended";
    else if (!strcmp(g->end_reason, "escaped"))
        kind = "escaped";
    mj_key(b, "end");
    mj_obj(b);
    mj_key(b, "kind"); mj_strv(b, kind);
    if (cause) {
        mj_key(b, "cause"); mj_strv(b, cause);
    }
    mj_key(b, "turn"); mj_intv(b, g->terminal_kind[0] ? g->terminal_turn : turn_of(g));
    mj_endobj(b);
}

#include "recording.inc"

#include "reconstruction.inc"
#include "request_validation.inc"

char *
nhx_call(nhx_t *x, const char *request_json)
{
    mj_val v;
    char *tool = NULL, *sid = NULL, *rid = NULL, *out;
    int retry = 0, was_ended, storage_blocked = 0;
    game_t *g;
    if (!x || !request_json) return NULL;
    if (!mj_valid(request_json)) return fail_envelope("", NULL, "invalidJson", "request must be a complete JSON object");
    if (mj_find(request_json, "tool", &v)) tool = mj_str(v);
    if (mj_find(request_json, "sessionId", &v)) sid = mj_str(v);
    if (mj_find(request_json, "requestId", &v)) rid = mj_str(v);
    g = sid ? game_get(x, sid, 0) : NULL;
    {
        const char *why = NULL;
        const char *code = validate_request(request_json, tool, &why);
        if (code) {
            if (g && tool && !strcmp(tool, "act")) {
                if (!g->ended && g->have_operation && g->operation.dec_pending == -2)
                    out = envelope_synth(g, rid, "act", "blocked", g->event_seq, 1, code, why);
                else out = envelope_error(g, rid, "act", code, why);
            } else out = fail_envelope(sid ? sid : "", rid, code, why);
            free(tool); free(sid); free(rid);
            return out;
        }
    }
    was_ended = g && g->ended;
    if (g && rid && tool && !strcmp(tool, "act") && req_lookup(g, rid)) retry = 1;
    out = nhx_dispatch(x, request_json);
    if (out && mj_find(out, "sessionId", &v)) {
        char *id = mj_str(v);
        g = id ? game_get(x, id, 0) : NULL;
        free(id);
    }
    if (out && mj_find(out, "error", &v)) {
        mj_val code;
        storage_blocked = (tool && !strcmp(tool, "resume")) || (mj_find(v.p, "code", &code) &&
            (record_is(code, "recordingUnavailable") || record_is(code, "metadataUnavailable") ||
             record_is(code, "inputHistoryError") || record_is(code, "recoveryRequired")));
    }
    if (g && out && tool && !retry && !storage_blocked && g->lease_fd >= 0 &&
        (!strcmp(tool, "act") || !strcmp(tool, "new_game") || !strcmp(tool, "resume")) &&
        !g->sidecar_error[0] && !g->input_error[0] && !g->recovery_required) {
        mj_val outcome, status;
        if (mj_find(out, "observation", &v) && mj_find(out, "outcome", &outcome) && mj_find(outcome.p, "status", &status)) {
            if (record_is(status, "unknown")) { g->boundary_complete = 0; g->recovery_required = 1; }
            else { g->boundary_complete = 1; g->sidecar_input_bytes = g->input_bytes; }
            sidecar_save(g);
        }
    }
    if (out && tool && !retry && !storage_blocked &&
        (!strcmp(tool, "new_game") || !strcmp(tool, "act") ||
         !strcmp(tool, "resume") || !strcmp(tool, "end_session") ||
         (!strcmp(tool, "get_state") && g && g->ended && !was_ended)) &&
        mj_find(out, "observation", &v)) {
        char *id = NULL;
        if (mj_find(out, "sessionId", &v)) id = mj_str(v);
        g = id ? game_get(x, id, 0) : NULL;
        /* A retired handle may serve old receipts/snapshots, but cannot
         * append to an archive now owned by another bridge. */
        if (g && g->lease_fd >= 0 && record_frame(g, request_json, out) < 0)
            fprintf(stderr, "recording failed for %s: %s\n", id, strerror(errno));
        free(id);
    }
    /* End/failure releases ownership only after the last checkpoint and
     * sidecar are committed, so a new owner cannot race the old recorder. */
    if (g && g->ended && g->eng) {
        nh_session_close(g->eng);
        g->eng = NULL;
        pending_clear(g);
    }
    if (g && !g->eng) lease_release(g);
    out = record_health(g, out);
    out = sidecar_health(g, out);
    free(tool); free(sid); free(rid);
    return out;
}
