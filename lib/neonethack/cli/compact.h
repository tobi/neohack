#ifndef NNH_CLI_COMPACT_H
#define NNH_CLI_COMPACT_H
/* Transport-owned observation baseline; never used for engine input. */
typedef struct { char *previous; long long sequence; int neighborhood; } compact_state;
char *compact_project(compact_state *, const char *response, const char *method);
#endif
