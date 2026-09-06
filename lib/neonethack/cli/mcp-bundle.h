#ifndef MCP_BUNDLE_H
#define MCP_BUNDLE_H
/* Paths live for the lifetime of this executable. Errors never repair caches. */
int mcp_bundle_paths(char **engine, char **data, char **sessions);
#endif
