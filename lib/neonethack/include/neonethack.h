/* libneonethack public C API, ABI 1.
 * No engine headers, terminal keys, global initialization or allocator sharing.
 * Each context owns isolated games. Calls into this library (including close)
 * must be serialized within a process; use separate processes for concurrency.
 * All strings are UTF-8. Input pointers are borrowed for the duration of a call.
 * Results are immutable, owned by the caller, and survive context destruction.
 */
#ifndef NEONETHACK_H
#define NEONETHACK_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#define NNH_ABI_VERSION 1
#define NNH_PROTOCOL_VERSION 1
#define NNH_MAX_REQUEST_BYTES 4096

typedef struct nhx nnh_context;
typedef struct nnh_result nnh_result;
typedef enum { NNH_OK = 0, NNH_INVALID_ARGUMENT = 1, NNH_OUT_OF_MEMORY = 2, NNH_SYSTEM_ERROR = 3 } nnh_status;

typedef struct {
    size_t size;                 /* sizeof(nnh_config), for ABI checking */
    const char *engine_path;    /* executable headless engine */
    const char *data_path;      /* read-only playground template */
    const char *sessions_path;  /* writable, trusted local journal directory */
} nnh_config;

typedef struct {
    const char *request_id;     /* unique per session; retain across retries */
    int64_t expected_revision; /* >= 0, <= 2^53-1; not a turn number */
} nnh_guard;

typedef struct {
    const char *name, *role, *race, *gender, *align; /* NULL means omitted */
    int has_seed;
    int64_t seed;
} nnh_identity;

typedef enum {
    NNH_NORTH, NNH_NORTHEAST, NNH_EAST, NNH_SOUTHEAST,
    NNH_SOUTH, NNH_SOUTHWEST, NNH_WEST, NNH_NORTHWEST, NNH_UP, NNH_DOWN
} nnh_direction;
typedef enum { NNH_TARGET_SELF, NNH_TARGET_DIRECTION } nnh_target_kind;
typedef struct { nnh_target_kind kind; nnh_direction direction; } nnh_target;
/* Exactly one of id/name must be non-NULL. NULL item pointer means discovery. */
typedef struct { const char *id; const char *name; } nnh_item;
typedef enum { NNH_ANSWER_ITEM, NNH_ANSWER_TARGET, NNH_ANSWER_CONFIRMATION, NNH_ANSWER_CHOICE, NNH_ANSWER_TEXT, NNH_ANSWER_POSITION } nnh_answer_kind;
typedef struct {
    nnh_answer_kind kind;
    union {
        nnh_item item;
        nnh_target target;
        int confirm; /* exactly 0 or 1 */
        struct { const int32_t *ids; size_t count; } choice;
        const char *text;
        struct { int x, y; const char *command; } position; /* command NULL selects x/y; otherwise compass, finish or help */
    } value;
} nnh_answer;

/* Only these declarations form the shared-library export surface. Private
 * parser/driver/process symbols are hidden, even from host interposition. */
#if defined(__GNUC__) || defined(__clang__)
#pragma GCC visibility push(default)
#endif
const char *nnh_version(void); /* static library version string */
nnh_status nnh_context_open(const nnh_config *, nnh_context **out);
void nnh_context_close(nnh_context *); /* NULL is safe; does not delete journals */

/* Length-delimited protocol v1 bridge. Embedded NUL/invalid UTF-8/unknown fields
 * are rejected before engine input. On NNH_OK, *out is an owned result (which
 * may contain a semantic/protocol error). Other statuses leave *out == NULL.
 * This API never exposes raw engine requests or management/reconstruction.
 */
nnh_status nnh_dispatch(nnh_context *, const char *json, size_t length, nnh_result **out);
const char *nnh_result_json(const nnh_result *); /* borrowed until result_free */
const char *nnh_result_error(const nnh_result *); /* error code or NULL */
const char *nnh_result_session(const nnh_result *); /* ID or NULL */
int64_t nnh_result_revision(const nnh_result *); /* -1 if unavailable */
void nnh_result_free(nnh_result *); /* NULL is safe */

nnh_status nnh_session_create(nnh_context *, const nnh_identity *, nnh_result **);
nnh_status nnh_session_observe(nnh_context *, const char *session, nnh_result **);
nnh_status nnh_session_resume(nnh_context *, const char *session, nnh_result **);
nnh_status nnh_session_close(nnh_context *, const char *session, nnh_result **);

nnh_status nnh_game_move(nnh_context *, const char *, const nnh_guard *, nnh_direction, nnh_result **);
nnh_status nnh_game_climb(nnh_context *, const char *, const nnh_guard *, nnh_direction, nnh_result **);
nnh_status nnh_game_wait(nnh_context *, const char *, const nnh_guard *, nnh_result **);
nnh_status nnh_game_search(nnh_context *, const char *, const nnh_guard *, nnh_result **);
nnh_status nnh_game_quit(nnh_context *, const char *, const nnh_guard *, nnh_result **);
nnh_status nnh_game_pray(nnh_context *, const char *, const nnh_guard *, nnh_result **);
/* NULL target asks for a genuine target decision. */
nnh_status nnh_game_kick(nnh_context *, const char *, const nnh_guard *, const nnh_target *, nnh_result **);
nnh_status nnh_game_open(nnh_context *, const char *, const nnh_guard *, const nnh_target *, nnh_result **);
nnh_status nnh_game_close(nnh_context *, const char *, const nnh_guard *, const nnh_target *, nnh_result **);
nnh_status nnh_game_pickup(nnh_context *, const char *, const nnh_guard *, const nnh_item *, nnh_result **);
nnh_status nnh_game_eat(nnh_context *, const char *, const nnh_guard *, const nnh_item *, nnh_result **);
nnh_status nnh_game_drink(nnh_context *, const char *, const nnh_guard *, const nnh_item *, nnh_result **);
nnh_status nnh_game_wield(nnh_context *, const char *, const nnh_guard *, const nnh_item *, nnh_result **);
nnh_status nnh_game_equip(nnh_context *, const char *, const nnh_guard *, const nnh_item *, nnh_result **);
nnh_status nnh_game_remove(nnh_context *, const char *, const nnh_guard *, const nnh_item *, nnh_result **);
nnh_status nnh_game_read(nnh_context *, const char *, const nnh_guard *, const nnh_item *, nnh_result **);
nnh_status nnh_game_apply(nnh_context *, const char *, const nnh_guard *, const nnh_item *, nnh_result **);
nnh_status nnh_game_drop(nnh_context *, const char *, const nnh_guard *, const nnh_item *, nnh_result **);
nnh_status nnh_game_zap(nnh_context *, const char *, const nnh_guard *, const nnh_item *, const nnh_target *, nnh_result **);
nnh_status nnh_decision_answer(nnh_context *, const char *, const nnh_guard *, const char *decision, const nnh_answer *, nnh_result **);
nnh_status nnh_decision_cancel(nnh_context *, const char *, const nnh_guard *, const char *decision, nnh_result **);
#if defined(__GNUC__) || defined(__clang__)
#pragma GCC visibility pop
#endif
#ifdef __cplusplus
}
#endif
#endif
