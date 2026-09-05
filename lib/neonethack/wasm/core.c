/* Minimal private Emscripten ABI. The public C API remains neonethack.h. */
#include "neonethack.h"
#include <string.h>
static nnh_context *context;
static nnh_result *last_result;
int nnh_wasm_open(const char *engine, const char *data, const char *sessions)
{
    nnh_config config = {sizeof config, engine, data, sessions};
    if (context) return NNH_INVALID_ARGUMENT;
    return nnh_context_open(&config, &context);
}
const char *nnh_wasm_request(const char *request)
{
    nnh_result_free(last_result); last_result = NULL;
    if (nnh_dispatch(context, request, strlen(request), &last_result) != NNH_OK) return NULL;
    return nnh_result_json(last_result);
}
void nnh_wasm_close(void)
{
    nnh_result_free(last_result); last_result = NULL;
    nnh_context_close(context); context = NULL;
}
