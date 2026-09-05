/* Private semantic driver. Not an installed/public header.
 * api.c owns the versioned public boundary; these internal flat requests remain
 * the journal/receipt representation, not a supported client protocol.
 * Serialize library calls. Result strings are owned and freed with nhx_free.
 */
#ifndef NNH_EXPLORER_PRIVATE_H
#define NNH_EXPLORER_PRIVATE_H
#include "symbols.h"
typedef struct nhx nhx_t;
nhx_t *nhx_open(const char *engine_bin, const char *template_dir, const char *sessions_dir);
char *nhx_call(nhx_t *, const char *request_json);
void nhx_free(char *);
void nhx_close(nhx_t *);
#endif
