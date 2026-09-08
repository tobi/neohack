#ifndef NNH_MCP_AGENT_H
#define NNH_MCP_AGENT_H
#include "minjson.h"
#include "neonethack.h"
typedef struct {
    char *snapshot, *pending, *last;
    int (*reserve)(const char *request, void *context);
    void *reserve_context;
} mcp_agent_state;
void mcp_agent_clear(mcp_agent_state *);
char *mcp_agent_execute(nnh_context *, mcp_agent_state *, const char *method,
                       mj_val args, long long seen_revision, const char *operation_id);
/* Agent adapter metadata and JSON presentation. No engine state is read here. */
extern const char *mcp_agent_tools, *mcp_agent_instructions;
mj_val mcp_agent_method(const char *name);
int mcp_agent_valid(mj_val method, mj_val args);
char *mcp_agent_help(mj_val args);
char *mcp_agent_present(const char *response, int historical);
char *mcp_agent_present_mode(const char *response, int historical, int compact);
char *mcp_agent_error(const char *code, const char *message);
char *mcp_agent_request(const char *method, mj_val args, long long revision,
                        const char *request_id);
int mcp_agent_uncertain(const char *response);
int mcp_agent_new_creature(const char *before, const char *after);
int mcp_agent_vitals_changed(const char *before, const char *after);
#endif
