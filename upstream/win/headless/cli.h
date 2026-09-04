/* neonethack headless CLI modes: flags, presets, log/replay, pretty print.
 *
 * main() runs hl_cli_parse() before early_options() so the unix parsers
 * never see these flags (early_options rejects any --s*=* token). This module:
 *   --seed N --name S --role I --race I --gender I --align I
 *       presets used when new_game params omit the key (and to build the
 *       implicit new_game in --play mode).
 *   --log FILE      append every client->engine line (the resume log).
 *   --replay FILE   serve these lines as the first stdin lines, then live.
 *   --pretty        human-readable engine->UI transcript on stdout.
 *   --play          interactive ASCII terminal mode (see play.c).
 */
#ifndef HL_CLI_H
#define HL_CLI_H

#include <stdio.h>

typedef struct {
    int seed_set;
    long seed;
    char name[64];
    int has_name;
    int role, race, gender, align; /* -1 = ask/random, like the protocol */
    const char *logfile;
    const char *replayfile;
    int pretty;
    int play;
} hl_cli_t;

extern hl_cli_t hl_cli;

/* Parse and consume our flags from argv (argc adjusted). */
void hl_cli_parse(int *argcp, char **argv);

/* Preset accessors for the new_game handler. */
int hl_cli_seed(long *out);
int hl_cli_name(char *out, unsigned outcap);
int hl_cli_slot(const char *key); /* role|race|gender|align, -1 default */

/* Replay queue: malloc'd line or NULL when exhausted. */
char *hl_cli_replay_next(void);
/* Append a consumed stdin line to the log file (no-op if --log absent). */
void hl_cli_log_line(const char *line);
/* Pretty-print one engine->UI line to out (2-space JSON indent). */
void hl_cli_pretty(const char *line, FILE *out);

#endif /* HL_CLI_H */
