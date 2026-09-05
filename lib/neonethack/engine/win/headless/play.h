/* neonethack --play: interactive ASCII terminal driver (see play.c). */
#ifndef HL_PLAY_H
#define HL_PLAY_H

/* Enter play mode (raw terminal, alt screen). No-op without a tty. */
void hl_play_begin(void);
/* Display one engine->UI line (notification or input request). */
void hl_play_on_line(const char *line);
/* Answer the pending input request from the keyboard.
 * Returns a malloc'd full client->engine envelope for the pending id
 * (caller frees); NULL only when stdin hits EOF. */
char *hl_play_read(void);
/* Leave play mode (restore terminal). Safe to call twice. */
void hl_play_end(void);

#endif /* HL_PLAY_H */
