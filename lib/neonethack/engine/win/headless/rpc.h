/* neonethack headless port: NDJSON JSON-RPC 2.0 transport.
 *
 * stdout is reserved for exactly one JSON object per line (UTF-8).
 * Everything else (diagnostics, stray core output) goes to stderr:
 * rpc_init() dups fd 1 aside and points fd 1 at fd 2, so even a rogue
 * printf from the core or Lua can never corrupt the stream.
 *
 * Direction A (engine -> client): notifications {method,params} and
 *   "input" requests {id,method:"input",params:{kind,...}}.
 * Direction B (client -> engine): responses {id,result} answering an input
 *   request, and standalone requests {id,method:"initialize"|"new_game"}
 *   answered while the engine starts up.
 */
#ifndef RPC_H
#define RPC_H

#include "json_min.h"

/* must be called first, from headless_init_nhwindows */
void rpc_init(void);
/* fire-and-forget event; params_json is a pre-rendered object body or NULL */
void rpc_notify(const char *method, const char *params_json);
/* ask the client for input; params_json is a fragment of the form
 * ,"name":value,... (leading comma, NO braces -- see hl_frag) merged into
 * params next to "kind". Returns malloc'd result-object text (caller frees
 * and parses fields) or NULL on EOF/parse failure. Emits session_ended
 * first on EOF. */
char *rpc_input(const char *kind, const char *params_json);
/* Free out-of-band lore request while a genuine input remains suspended. */
int headless_lore_request(const char *line);
/* Private verification metadata, not a gameplay query. */
int headless_rng_integrity(char *out, size_t capacity);
/* read one client->engine request line; splits into malloc'd method text and
 * raw params text. Returns request id, or -1 on EOF, -2 on parse error. */
long long rpc_read_request(char **method_out, char **params_out);
void rpc_reply(long long id, const char *result_json);
void rpc_reply_error(long long id, long long code, const char *message);
/* protocol/engine versions advertised in initialize replies */
extern const char *rpc_protocol_version; /* "0.1" */
const char *rpc_engine_version(void);    /* version_string() or "unknown" */

#endif /* RPC_H */
