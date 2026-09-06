/* neonethack headless port, added/modified 2026-09-03 through 2026-09-05.
 * See CHANGES.neonethack.md and dat/license (NGPL).
 * window_procs -> NDJSON JSON-RPC (see the private engine protocol).
 *
 * Pure brain, zero IO: every output proc emits a notification, every input
 * proc emits an "input" request and blocks on the client's response.
 * All mutable state (saves/bones/record) is meant to travel via persist_*
 * requests (wired in a follow-up); stdout hygiene is handled in rpc_init().
 */
#include "hack.h"
#include "rpc.h"
#include "json_min.h"
#include "cli.h"
#include "play.h"
#include "botl.h"
#include "func_tab.h"

#include <stdlib.h>
#include <string.h>

#include "pickup-settings.inc"
#include "knowledge.inc"

/* ---------- local window/menu bookkeeping ---------- */
#define HL_MAXWIN 64
#define HL_MSGLOG 256

struct hl_menu_item {
    anything id;
    char accel;
    char groupacc;
    int attr;
    int glyph;
    unsigned itemflags;
    char *text; /* heap copy */
};

struct hl_win {
    int used;
    int type;
    struct hl_menu_item *items;
    int nitems, capitems;
};

static struct hl_win hl_wins[HL_MAXWIN];
static winid hl_map_win = WIN_ERR;

/* new_game handshake state */
static int hl_have_game = 0;
static char *hl_input(const char *, const char *);
static long hl_seed = 0;
static int hl_have_seed = 0;
static int hl_role = -1, hl_race = -1, hl_gend = -1, hl_align = -1;
static char hl_name[PL_NSIZ];

/* seed override consumed by the sys_random_seed() patch (unixmain.c) */
static int hl_seed_calls = 0;
unsigned long
headless_seed_override(void)
{
    /* -1: no override, fall through to OS entropy */
    if (!hl_have_seed)
        return (unsigned long) -1L;
    /* distinct deterministic stream per RNG (game, display, ...) */
    return (unsigned long) (hl_seed + (hl_seed_calls++ * 0x9e3779b9L));
}

/* message history ring (also feeds getmsghistory) */
static char *hl_msgs[HL_MSGLOG];
static int hl_msgnext = 0, hl_msgcount = 0;
static char **hl_snapshot = NULL;
static int hl_snapcount = 0, hl_snapidx = 0;

/* rpc_input() takes a params fragment: the object body WITHOUT braces,
 * e.g. ,"window":1,"how":2 (leading comma included). This converts a
 * finished JBuf object into that fragment in place, inserting the
 * leading comma via a one-byte shift (no growth: the dropped braces
 * free exactly the byte the comma needs). */
static const char *
hl_frag(JBuf *jb)
{
    if (!jb->ok || jb->len < 2)
        return NULL;
    if (jb->len == 2) { /* empty object: no fragment needed */
        jb->buf[1] = '\0';
        return jb->buf + 2; /* points at the NUL: empty string */
    }
    /* buf holds "{...}" (len chars, NUL at buf[len]); the inner body
     * shifts one byte right to make room for the leading comma, and the
     * pre-existing NUL at buf[len] already terminates the fragment. */
    memmove(jb->buf + 2, jb->buf + 1, jb->len - 2);
    jb->buf[1] = ',';
    jb->buf[jb->len] = '\0';
    return jb->buf + 1;
}

static void
hl_log_msg(const char *s)
{
    char *copy = strdup(s ? s : "");
    if (!copy)
        return;
    if (hl_msgcount == HL_MSGLOG) {
        free(hl_msgs[hl_msgnext]);
        hl_msgs[hl_msgnext] = copy;
        hl_msgnext = (hl_msgnext + 1) % HL_MSGLOG;
    } else {
        hl_msgs[(hl_msgnext + hl_msgcount) % HL_MSGLOG] = copy;
        hl_msgcount++;
    }
}

/* ---------- shadow map + flush ---------- */
struct hl_cell {
    int glyph, ttychar;
    unsigned long framecolor;
    int tileidx, color256idx;
    int cmap, background_cmap; /* perceived symbols, never unseen terrain */
    int visible; /* engine sight, independent of remembered display glyphs */
    int attitude; /* 0 unknown, 1 hostile, 2 peaceful, 3 tame: visible look facts */
    int appearance; /* displayed monster type, never a hidden monster lookup */
    int dirty;
};
static struct hl_cell hl_map[ROWNO][COLNO];
static int hl_map_dirty = 0;
static int hl_snapshot_sent = 0;
static long long hl_knowledge_epoch;

static void
hl_clear_map(void)
{
    int x, y;
    memset(hl_map, 0, sizeof hl_map);
    /* Zero is a real monster glyph. An undisclosed cell has no glyph or
     * terrain symbol, including after changing levels or clearing the map. */
    for (y = 0; y < ROWNO; y++)
        for (x = 0; x < COLNO; x++) {
            hl_map[y][x].glyph = NO_GLYPH;
            hl_map[y][x].cmap = hl_map[y][x].background_cmap = -1;
        }
}

static void
hl_emit_glyph_obj(JBuf *jb, const glyph_info *glyph, const glyph_info *bg)
{
    jb_begin_obj(jb);
    jb_key(jb, "glyph");
    jb_int(jb, glyph ? glyph->glyph : NO_GLYPH);
    jb_key(jb, "ttychar");
    jb_int(jb, glyph ? glyph->ttychar : 0);
    jb_key(jb, "framecolor");
    jb_int(jb, glyph ? (long long) glyph->framecolor : 0);
    jb_key(jb, "tileidx");
    jb_int(jb, glyph ? glyph->gm.tileidx : 0);
    jb_key(jb, "color256idx");
    jb_int(jb, glyph ? glyph->gm.color256idx : 0);
    if (bg) {
        jb_key(jb, "bkglyph");
        jb_int(jb, bg->glyph);
    }
    jb_end_obj(jb);
}

/* full-map snapshot on first flush, deltas afterwards */
static void
headless_flush(void)
{
    JBuf jb, cells;
    int x, y;
    /* Sight can change without a glyph redraw (remembered lit rooms). */
    for (y = 0; y < ROWNO; y++)
        for (x = 1; x < COLNO; x++) {
            struct hl_cell *c = &hl_map[y][x];
            int visible = cansee(x, y) ? 1 : 0;
            int appearance = (!Hallucination && glyph_is_monster(c->glyph))
                                 ? glyph_to_mon(c->glyph) + 1 : 0;
            int attitude = 0;
            struct monst *seen = m_at(x, y);
            /* Match look's non-hallucinatory, spotted monster information.
             * Disguises, hidden creatures, and remembered glyphs disclose none. */
            if (visible && appearance && !u.uswallow && seen
                && canspotmon(seen) && !seen->mundetected
                && seen->m_ap_type == M_AP_NOTHING
                && !(x == u.ux && y == u.uy))
                attitude = seen->mtame ? 3 : seen->mpeaceful ? 2 : 1;
            if (c->attitude != attitude) {
                c->attitude = attitude;
                c->dirty = hl_map_dirty = 1;
            }
            /* The stock optional background glyph deliberately omits room
             * floor. An object first seen on it therefore has no terrain
             * glyph for a layered client. Render the visible base explicitly,
             * using the same secret-masking renderer as underfoot perception.
             * Never consult unseen terrain or replace a furniture disguise. */
            if (visible && !u.uswallow
                && (glyph_is_object(c->glyph) || glyph_is_monster(c->glyph)
                    || glyph_is_body(c->glyph))) {
                int base = back_to_glyph(x, y);
                int background = glyph_is_cmap(base) ? glyph_to_cmap(base) : -1;
                if (c->background_cmap != background) {
                    c->background_cmap = background;
                    c->dirty = hl_map_dirty = 1;
                }
            }
            if (c->appearance != appearance) {
                c->appearance = appearance;
                c->dirty = hl_map_dirty = 1;
            }
            if (c->visible != visible) {
                c->visible = visible;
                c->dirty = hl_map_dirty = 1;
            }
        }
    if (!hl_map_dirty && hl_snapshot_sent)
        return;
    jb_init(&jb);
    jb_init(&cells);
    jb_begin_arr(&cells);
    for (y = 0; y < ROWNO; y++) {
        for (x = 0; x < COLNO; x++) {
            struct hl_cell *c = &hl_map[y][x];
            if (hl_snapshot_sent && !c->dirty)
                continue;
            jb_sep(&cells);
            jb_begin_obj(&cells);
            jb_key(&cells, "x");
            jb_int(&cells, x);
            jb_key(&cells, "y");
            jb_int(&cells, y);
            jb_key(&cells, "glyph");
            jb_int(&cells, c->glyph);
            jb_key(&cells, "ttychar");
            jb_int(&cells, c->ttychar);
            jb_key(&cells, "framecolor");
            jb_int(&cells, (long long) c->framecolor);
            jb_key(&cells, "cmap");
            jb_int(&cells, c->cmap);
            jb_key(&cells, "backgroundCmap");
            jb_int(&cells, c->background_cmap);
            jb_key(&cells, "boulder");
            jb_bool(&cells, glyph_is_object(c->glyph) && glyph_to_obj(c->glyph) == BOULDER);
            jb_key(&cells, "visible");
            jb_bool(&cells, c->visible);
            if (c->attitude) {
                jb_key(&cells, "attitude");
                jb_str(&cells, c->attitude == 3 ? "tame" : c->attitude == 2 ? "peaceful" : "hostile");
            }
            if (c->appearance > 0 && c->appearance <= NUMMONS) {
                jb_key(&cells, "appearance");
                jb_str(&cells, mons[c->appearance - 1].pmnames[NEUTRAL]);
            }
            jb_key(&cells, "tileidx");
            jb_int(&cells, c->tileidx);
            jb_key(&cells, "color256idx");
            jb_int(&cells, c->color256idx);
            jb_end_obj(&cells);
            c->dirty = 0;
        }
    }
    jb_end_arr(&cells);
    if (!cells.ok) {
        jb_free(&jb);
        jb_free(&cells);
        return;
    }
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "full");
    jb_bool(&jb, !hl_snapshot_sent);
    jb_key(&jb, "cells");
    jb_raw(&jb, cells.buf);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify(hl_snapshot_sent ? "map_delta" : "snapshot", jb.buf);
    hl_snapshot_sent = 1;
    hl_map_dirty = 0;
    jb_free(&jb);
    jb_free(&cells);
}

/* ---------- startup handshake ---------- */
static void
hl_answer_initialize(long long id, const char *params)
{
    JBuf jb;
    const char *p;
    int ok = 0;
    long long want = 0;
    /* expect params.protocolVersion == "0.1" (checked loosely: major "0") */
    p = j_find_key(params ? params : "{}", "protocolVersion");
    if (p) {
        char *v = j_parse_str(p, &ok);
        if (ok && v && v[0] == '0' && (v[1] == '\0' || v[1] == '.'))
            want = 1;
        free(v);
    }
    if (!want) {
        rpc_reply_error(id, -32001, "E_UNSUPPORTED_VERSION: want 0.x");
        return;
    }
    if (headless_runtime_epoch() >= 0) {
        long long profile, epoch;
        p = j_find_key(params, "runtimeProfile");
        profile = p ? j_parse_int(p, &ok) : -1;
        if (!ok || profile != 1) {
            rpc_reply_error(id, -32002, "E_RUNTIME_PROFILE: want profile 1");
            return;
        }
        p = j_find_key(params, "calendarEpoch");
        epoch = p ? j_parse_int(p, &ok) : -1;
        if (!ok || epoch != headless_runtime_epoch()) {
            rpc_reply_error(id, -32002, "E_RUNTIME_PROFILE: bootstrap epoch mismatch");
            return;
        }
    }
    jb_init(&jb);
    jb_begin_obj(&jb);
    if (headless_runtime_epoch() >= 0) {
        jb_key(&jb, "runtimeProfile"); jb_int(&jb, 1);
        jb_key(&jb, "calendarEpoch"); jb_int(&jb, headless_runtime_epoch());
    }
    jb_key(&jb, "protocolVersion");
    jb_str(&jb, rpc_protocol_version);
    jb_key(&jb, "engineVersion");
    jb_str(&jb, rpc_engine_version());
    jb_key(&jb, "capabilities");
    jb_begin_arr(&jb);
    {
        const char *caps[] = { "snapshot", "delta", "persist", "resume-log",
                               "seed", NULL };
        int i;
        for (i = 0; caps[i]; i++) {
            jb_sep(&jb);
            jb_str(&jb, caps[i]);
        }
    }
    jb_end_arr(&jb);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_reply(id, jb.buf);
    else
        rpc_reply_error(id, -32603, "internal");
    jb_free(&jb);
}

static long long
hl_param_int(const char *params, const char *key, long long dflt)
{
    int ok = 0;
    long long v;
    const char *p = j_find_key(params ? params : "{}", key);
    if (!p)
        return dflt;
    v = j_parse_int(p, &ok);
    return ok ? v : dflt;
}

static void
hl_answer_new_game(long long id, const char *params)
{
    JBuf jb;
    char *s;
    int ok = 0;
    const char *p;
    hl_role = (int) hl_param_int(params, "role", -1);
    hl_race = (int) hl_param_int(params, "race", -1);
    hl_gend = (int) hl_param_int(params, "gender", -1);
    hl_align = (int) hl_param_int(params, "align", -1);
    /* CLI presets fill keys the request omitted. */
    if (!j_find_key(params ? params : "{}", "role"))
        hl_role = hl_cli_slot("role");
    if (!j_find_key(params ? params : "{}", "race"))
        hl_race = hl_cli_slot("race");
    if (!j_find_key(params ? params : "{}", "gender"))
        hl_gend = hl_cli_slot("gender");
    if (!j_find_key(params ? params : "{}", "align"))
        hl_align = hl_cli_slot("align");
    p = j_find_key(params ? params : "{}", "seed");
    if (p && strncmp(p, "null", 4) != 0) {
        hl_seed = (long) j_parse_int(p, &ok);
        hl_have_seed = ok;
    } else if (!p) {
        long cli_seed = 0;
        if (hl_cli_seed(&cli_seed)) {
            hl_seed = cli_seed;
            hl_have_seed = 1;
        }
    }
    p = j_find_key(params ? params : "{}", "name");
    if (p) {
        s = j_parse_str(p, &ok);
        if (ok && s && *s) {
            strncpy(hl_name, s, PL_NSIZ - 1);
            hl_name[PL_NSIZ - 1] = '\0';
        }
        free(s);
    }
    if (!hl_name[0]) {
        char cli_name[64];
        if (hl_cli_name(cli_name, sizeof cli_name)) {
            strncpy(hl_name, cli_name, PL_NSIZ - 1);
            hl_name[PL_NSIZ - 1] = '\0';
        }
    }
    /* Push the hero name into the core now: main's plnamesuffix() only
     * calls askname() for empty/generic names, so without this every
     * session would run as the OS user (locking/restoring the wrong
     * save). Runs before getlock/restore in both handshake and --play. */
    if (hl_name[0]) {
        strncpy(svp.plname, hl_name, sizeof svp.plname - 1);
        svp.plname[sizeof svp.plname - 1] = '\0';
    }
    hl_have_game = 1;
    if (!hl_pickup_configure(j_find_key(params ? params : "{}", "automaticPickup")))
        panic("invalid automatic pickup creation settings");
    if (hl_have_seed) {
        /* init_random() already ran during initoptions() (before this
         * handshake) on OS entropy, and nothing consumes game RNG between
         * there and here (no menus/rolls yet). Re-seed now so the whole
         * run -- attributes, level gen, everything -- derives from the
         * logged seed. Calendar and runtime options remain separate inputs;
         * a seed alone does not establish replay equivalence. */
        hl_seed_calls = 0;
        init_random(rn2);
        init_random(rn2_on_display_rng);
        has_strong_rngseed = FALSE; /* no later reseeds, ever */
    }
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "sessionId");
    jb_int(&jb, 1);
    jb_key(&jb, "seedUsed");
    jb_int(&jb, hl_have_seed ? (long long) hl_seed : -1);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_reply(id, jb.buf);
    else
        rpc_reply_error(id, -32603, "internal");
    jb_free(&jb);
}

static void
headless_init_nhwindows(int *argcp, char **argv)
{
    rpc_init();
    memset(hl_wins, 0, sizeof hl_wins);
    hl_clear_map();
    /* argv was already consumed by hl_cli_parse in main() (before
     * early_options); parsing again here would reset preset slots. */
    (void) argcp;
    (void) argv;
    if (hl_cli.play) {
        /* --play: no stdin handshake; the in-process terminal driver
         * performs initialize + new_game from CLI presets instead. */
        JBuf jb;
        hl_play_begin();
        hl_answer_initialize(0, "{}");
        jb_init(&jb);
        {
            long seed = 0;
            char name[64];
            int have_seed = hl_cli_seed(&seed);
            int have_name = hl_cli_name(name, sizeof name);
            jb_begin_obj(&jb);
            jb_key(&jb, "role");
            jb_int(&jb, hl_cli_slot("role"));
            jb_key(&jb, "race");
            jb_int(&jb, hl_cli_slot("race"));
            jb_key(&jb, "gender");
            jb_int(&jb, hl_cli_slot("gender"));
            jb_key(&jb, "align");
            jb_int(&jb, hl_cli_slot("align"));
            jb_key(&jb, "name");
            jb_str(&jb, have_name ? name : "");
            jb_key(&jb, "seed");
            if (have_seed)
                jb_int(&jb, seed);
            else
                jb_null(&jb);
            jb_end_obj(&jb);
        }
        if (jb.ok)
            hl_answer_new_game(0, jb.buf);
        jb_free(&jb);
        return;
    }
    /* handshake: expect initialize, then new_game (both blocking) */
    for (;;) {
        char *method = NULL, *params = NULL;
        long long id = rpc_read_request(&method, &params);
        if (id == -1) {
            free(method);
            free(params);
            break; /* EOF */
        }
        if (id == -2) {
            /* unparseable line (no method): ignore and keep waiting;
             * silently starting a default game would be worse. */
            free(method);
            free(params);
            continue;
        }
        if (strcmp(method, "initialize") == 0) {
            hl_answer_initialize(id, params);
        } else if (strcmp(method, "new_game") == 0) {
            hl_answer_new_game(id, params);
            free(method);
            free(params);
            break;
        } else {
            rpc_reply_error(id, -32601, "expect initialize then new_game");
        }
        free(method);
        free(params);
    }
}

static void
headless_player_selection(void)
{
    /* integer indices preselected via new_game skip the role prompts */
    if (hl_role >= 0)
        flags.initrole = hl_role;
    if (hl_race >= 0)
        flags.initrace = hl_race;
    if (hl_gend >= 0)
        flags.initgend = hl_gend;
    if (hl_align >= 0)
        flags.initalign = hl_align;
    /* remaining ROLE_NONE-style prompts (menus) are served over the wire */
}

static void
headless_askname(void)
{
    if (hl_name[0]) {
        strncpy(svp.plname, hl_name, sizeof svp.plname - 1);
        svp.plname[sizeof svp.plname - 1] = '\0';
        return;
    }
    {
        char *r = hl_input("getlin", ",\"prompt\":\"What is your name?\"");
        if (r) {
            const char *p = j_find_key(r, "line");
            int ok = 0;
            char *s = p ? j_parse_str(p, &ok) : NULL;
            if (ok && s && *s) {
                strncpy(svp.plname, s, sizeof svp.plname - 1);
                svp.plname[sizeof svp.plname - 1] = '\0';
            }
            free(s);
            free(r);
        }
        if (!svp.plname[0])
            strcpy(svp.plname, "headless");
    }
}

static void
headless_get_nh_event(void)
{
}

void
headless_action_result(const char *action, const char *status)
{
    JBuf jb;
    if (windowprocs.wp_id != wp_headless) return;
    jb_init(&jb); jb_begin_obj(&jb);
    jb_key(&jb, "action"); jb_str(&jb, action);
    jb_key(&jb, "status"); jb_str(&jb, status);
    jb_key(&jb, "turn"); jb_int(&jb, svm.moves);
    jb_end_obj(&jb);
    if (jb.ok) rpc_notify("action_result", jb.buf);
    jb_free(&jb);
}

/* Called only beside an existing player-facing disclosure, never by a query. */
void
headless_door_witness(coordxy x, coordxy y, const char *fact)
{
    JBuf jb;
    if (windowprocs.wp_id != wp_headless || !isok(x, y)) return;
    jb_init(&jb); jb_begin_obj(&jb);
    jb_key(&jb, "branch"); jb_int(&jb, u.uz.dnum);
    jb_key(&jb, "level"); jb_int(&jb, u.uz.dlevel);
    jb_key(&jb, "x"); jb_int(&jb, x); jb_key(&jb, "y"); jb_int(&jb, y);
    jb_key(&jb, "fact"); jb_str(&jb, fact);
    jb_key(&jb, "turn"); jb_int(&jb, svm.moves);
    jb_key(&jb, "epoch"); jb_int(&jb, hl_knowledge_epoch + 1);
    jb_end_obj(&jb);
    if (jb.ok) rpc_notify("door_witness", jb.buf);
    jb_free(&jb);
}

void
headless_lifesaved(int how, long turn)
{
    JBuf jb;
    /* The hero is still alive. A post-mortem killer description could reveal
     * an unseen attacker or unidentified object; publish no such identity. */
    const char *cause = how == CHOKING ? "choking" : "fatal harm";
    if (windowprocs.wp_id != wp_headless) return;
    jb_init(&jb); jb_begin_obj(&jb);
    jb_key(&jb, "cause"); jb_str(&jb, cause);
    jb_key(&jb, "turn"); jb_int(&jb, turn);
    jb_key(&jb, "health"); jb_int(&jb, Upolyd ? u.mh : u.uhp);
    jb_end_obj(&jb);
    if (jb.ok) rpc_notify("life_saved", jb.buf);
    jb_free(&jb);
}

void
headless_terminal(int how, const char *cause, long turn)
{
    const char *kind;
    JBuf jb;
    if (windowprocs.wp_id != wp_headless)
        return;
    kind = how < PANICKED ? "death"
           : how == QUIT ? "quit"
           : how == ESCAPED ? "escaped"
           : how == ASCENDED ? "ascended" : "engineError";
    jb_init(&jb); jb_begin_obj(&jb);
    jb_key(&jb, "kind"); jb_str(&jb, kind);
    jb_key(&jb, "cause"); jb_str(&jb, cause ? cause : "");
    jb_key(&jb, "turn"); jb_int(&jb, turn);
    jb_key(&jb, "health"); jb_int(&jb, Upolyd ? u.mh : u.uhp);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("game_ended", jb.buf);
    jb_free(&jb);
}

void
headless_final_score(long score)
{
    JBuf jb;
    if (windowprocs.wp_id != wp_headless) return;
    jb_init(&jb); jb_begin_obj(&jb);
    jb_key(&jb, "score"); jb_int(&jb, score);
    hl_knowledge(&jb);
    jb_end_obj(&jb);
    if (jb.ok) rpc_notify("final_result", jb.buf);
    jb_free(&jb);
}

static void
headless_exit_nhwindows(const char *str)
{
    JBuf jb;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "reason");
    jb_str(&jb, str && *str ? str : "exit");
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("session_ended", jb.buf);
    jb_free(&jb);
}

static void
headless_suspend_nhwindows(const char *str)
{
    (void) str;
}

static void
headless_resume_nhwindows(void)
{
}

static winid
headless_create_nhwindow(int type)
{
    int i;
    for (i = 1; i < HL_MAXWIN; i++) {
        if (!hl_wins[i].used) {
            JBuf jb;
            hl_wins[i].used = 1;
            hl_wins[i].type = type;
            if (type == NHW_MAP)
                hl_map_win = i;
            jb_init(&jb);
            jb_begin_obj(&jb);
            jb_key(&jb, "window");
            jb_int(&jb, i);
            jb_key(&jb, "type");
            jb_int(&jb, type);
            jb_end_obj(&jb);
            if (jb.ok)
                rpc_notify("window_create", jb.buf);
            jb_free(&jb);
            return i;
        }
    }
    return WIN_ERR;
}

static void
headless_clear_nhwindow(winid window)
{
    JBuf jb;
    if (window == hl_map_win) {
        hl_clear_map();
        hl_snapshot_sent = 0;
        hl_map_dirty = 1;
    }
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "window");
    jb_int(&jb, window);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("window_clear", jb.buf);
    jb_free(&jb);
}

static void
headless_display_nhwindow(winid window, boolean blocking)
{
    JBuf jb;
    if (window == hl_map_win)
        headless_flush();
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "window");
    jb_int(&jb, window);
    jb_key(&jb, "blocking");
    jb_bool(&jb, blocking);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("window_display", jb.buf);
    jb_free(&jb);
    if (blocking) {
        /* params fragment carrying the real window id */
        static char ackfrag[64];
        char *r;
        snprintf(ackfrag, sizeof ackfrag, ",\"window\":%d", window);
        r = rpc_input("ack", ackfrag);
        free(r);
    }
}

static void
headless_destroy_nhwindow(winid window)
{
    JBuf jb;
    int i;
    if (window > 0 && window < HL_MAXWIN && hl_wins[window].used) {
        for (i = 0; i < hl_wins[window].nitems; i++)
            free(hl_wins[window].items[i].text);
        free(hl_wins[window].items);
        memset(&hl_wins[window], 0, sizeof hl_wins[window]);
        if (window == hl_map_win)
            hl_map_win = WIN_ERR;
    }
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "window");
    jb_int(&jb, window);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("window_destroy", jb.buf);
    jb_free(&jb);
}

static void
headless_curs(winid window, int x, int y)
{
    JBuf jb;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "window");
    jb_int(&jb, window);
    jb_key(&jb, "x");
    jb_int(&jb, x);
    jb_key(&jb, "y");
    jb_int(&jb, y);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("cursor", jb.buf);
    jb_free(&jb);
}

static void
headless_putstr(winid window, int attr, const char *str)
{
    JBuf jb;
    const char *channel = (window == WIN_MESSAGE) ? "message" : "text";
    if (!str)
        str = "";
    if (window == WIN_MESSAGE)
        hl_log_msg(str);
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "channel");
    jb_str(&jb, channel);
    jb_key(&jb, "window");
    jb_int(&jb, window);
    jb_key(&jb, "attr");
    jb_int(&jb, attr);
    jb_key(&jb, "text");
    jb_str(&jb, str);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("message", jb.buf);
    jb_free(&jb);
}

static void
headless_display_file(const char *name, boolean complain)
{
    JBuf jb;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "name");
    jb_str(&jb, name ? name : "");
    jb_key(&jb, "complain");
    jb_bool(&jb, complain);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("display_file", jb.buf);
    jb_free(&jb);
    /* the implementor renders the file; ack before continuing */
    {
        char *r = rpc_input("ack", NULL);
        free(r);
    }
}

/* ---------- menus (wire carries ordinals, port keeps the ANY_Ps) ---------- */
static void
headless_start_menu(winid window, unsigned long mbehavior)
{
    JBuf jb;
    int i;
    if (window > 0 && window < HL_MAXWIN && hl_wins[window].used) {
        for (i = 0; i < hl_wins[window].nitems; i++)
            free(hl_wins[window].items[i].text);
        free(hl_wins[window].items);
        hl_wins[window].items = NULL;
        hl_wins[window].nitems = hl_wins[window].capitems = 0;
    }
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "window");
    jb_int(&jb, window);
    jb_key(&jb, "behavior");
    jb_int(&jb, (long long) mbehavior);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("menu_start", jb.buf);
    jb_free(&jb);
}

static void
headless_add_menu(winid window, const glyph_info *glyphinfo,
                  const ANY_P *identifier, char ch, char gch, int attr,
                  int clr, const char *str, unsigned int itemflags)
{
    struct hl_win *w;
    struct hl_menu_item *it;
    JBuf jb;
    if (window <= 0 || window >= HL_MAXWIN || !hl_wins[window].used)
        return;
    w = &hl_wins[window];
    if (w->nitems == w->capitems) {
        int ncap = w->capitems ? w->capitems * 2 : 16;
        struct hl_menu_item *nb =
            realloc(w->items, (size_t) ncap * sizeof *nb);
        if (!nb)
            return;
        w->items = nb;
        w->capitems = ncap;
    }
    it = &w->items[w->nitems++];
    memset(it, 0, sizeof *it);
    if (identifier)
        it->id = *identifier;
    it->accel = ch;
    it->groupacc = gch;
    it->attr = attr;
    it->glyph = glyphinfo ? glyphinfo->glyph : NO_GLYPH;
    it->itemflags = itemflags;
    it->text = strdup(str ? str : "");
    if (!it->text)
        it->text = strdup("");

    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "window");
    jb_int(&jb, window);
    jb_key(&jb, "index");
    jb_int(&jb, w->nitems - 1);
    jb_key(&jb, "accel");
    jb_int(&jb, ch);
    jb_key(&jb, "selectable");
    jb_bool(&jb, identifier && identifier->a_void);
    jb_key(&jb, "groupacc");
    jb_int(&jb, gch);
    jb_key(&jb, "attr");
    jb_int(&jb, attr);
    jb_key(&jb, "color");
    jb_int(&jb, clr);
    jb_key(&jb, "text");
    jb_str(&jb, str ? str : "");
    jb_key(&jb, "itemflags");
    jb_int(&jb, (long long) itemflags);
    if (glyphinfo) {
        jb_key(&jb, "glyph");
        hl_emit_glyph_obj(&jb, glyphinfo, NULL);
    }
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("menu_item", jb.buf);
    jb_free(&jb);
}

/* The object-menu builder calls this immediately after adding an object row.
 * Only already-offered object identity is reported; no pointer, hidden object
 * type, BUC, charge count or container contents are exposed. */
void
headless_menu_object(winid window, const struct obj *obj)
{
    JBuf jb;
    if (strcmp(windowprocs.name, "headless") || !obj || !obj->o_id
        || window <= 0 || window >= HL_MAXWIN || !hl_wins[window].used
        || !hl_wins[window].nitems
        || hl_wins[window].items[hl_wins[window].nitems - 1].id.a_obj != obj)
        return; /* A failed add_menu must not bind the previous row. */
    jb_init(&jb); jb_begin_obj(&jb);
    jb_key(&jb, "window"); jb_int(&jb, window);
    jb_key(&jb, "index"); jb_int(&jb, hl_wins[window].nitems - 1);
    jb_key(&jb, "objectId"); jb_int(&jb, obj->o_id);
    jb_key(&jb, "quantity"); jb_int(&jb, obj->quan);
    jb_end_obj(&jb);
    if (jb.ok) rpc_notify("menu_object", jb.buf);
    jb_free(&jb);
}

/* Structured presentation context, never inferred from a label or accelerator. */
void
headless_container_menu(winid window, const char *phase)
{
    JBuf jb;
    jb_init(&jb); jb_begin_obj(&jb);
    jb_key(&jb, "window"); jb_int(&jb, window);
    jb_key(&jb, "phase"); jb_str(&jb, phase);
    jb_end_obj(&jb);
    if (jb.ok) rpc_notify("container_menu", jb.buf);
    jb_free(&jb);
}

void
headless_container_item(winid window, const struct obj *obj, const char *transfer)
{
    JBuf jb;
    headless_menu_object(window, obj);
    if (window <= 0 || window >= HL_MAXWIN || !hl_wins[window].used
        || !hl_wins[window].nitems
        || hl_wins[window].items[hl_wins[window].nitems - 1].id.a_obj != obj)
        return;
    jb_init(&jb); jb_begin_obj(&jb);
    jb_key(&jb, "window"); jb_int(&jb, window);
    jb_key(&jb, "index"); jb_int(&jb, hl_wins[window].nitems - 1);
    jb_key(&jb, "transfer"); jb_str(&jb, transfer);
    jb_end_obj(&jb);
    if (jb.ok) rpc_notify("container_item", jb.buf);
    jb_free(&jb);
}

static void
headless_end_menu(winid window, const char *prompt)
{
    JBuf jb;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "window");
    jb_int(&jb, window);
    jb_key(&jb, "prompt");
    jb_str(&jb, prompt ? prompt : "");
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("menu_end", jb.buf);
    jb_free(&jb);
}

static int
headless_select_menu(winid window, int how, MENU_ITEM_P **menu_list)
{
    struct hl_win *w;
    char *r;
    const char *p;
    long long picks[1024];
    long long counts[1024];
    int npicks, ncounts, i, n = 0;
    menu_item *mi;
    JBuf jb;
    *menu_list = NULL;
    if (window <= 0 || window >= HL_MAXWIN || !hl_wins[window].used)
        return -1;
    w = &hl_wins[window];
    headless_flush();
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "window");
    jb_int(&jb, window);
    jb_key(&jb, "how");
    jb_int(&jb, how);
    jb_end_obj(&jb);
    r = hl_input("menu", hl_frag(&jb));
    jb_free(&jb);
    if (!r)
        return -1;
    p = j_find_key(r, "cancelled");
    if (p) {
        int ok = 0;
        if (j_parse_bool(p, &ok) && ok) {
            free(r);
            return -1;
        }
    }
    p = j_find_key(r, "picks");
    npicks = j_parse_int_array(p, picks, 1024);
    if (npicks < 0)
        npicks = 0;
    p = j_find_key(r, "counts");
    ncounts = j_parse_int_array(p, counts, 1024);
    if (ncounts < 0)
        ncounts = 0;
    /* Invalid raw selections are never reinterpreted as another menu row. */
    if ((how == PICK_NONE && npicks) || (how == PICK_ONE && npicks > 1)) {
        free(r); return -1;
    }
    for (i = 0; i < npicks; i++) {
        if (picks[i] < 0 || picks[i] >= w->nitems
            || !w->items[(int) picks[i]].id.a_void) {
            free(r); return -1;
        }
    }
    if (npicks > 0)
        mi = *menu_list = (menu_item *) alloc((unsigned) npicks
                                              * sizeof(menu_item));
    else
        mi = NULL;
    for (i = 0; i < npicks; i++) {
        int idx = (int) picks[i];
        if (idx < 0 || idx >= w->nitems)
            continue;
        mi[n].item = w->items[idx].id;
        mi[n].count = (i < ncounts) ? (long) counts[i] : -1L;
        mi[n].itemflags = w->items[idx].itemflags;
        n++;
    }
    free(r);
    return n;
}

/* The ordinary getobj '*' inventory, with the engine retaining the object
 * binding. Do not expose obj_ok rankings: some callbacks depend on unknown
 * properties. Selection is an attempt and getobj still validates it normally. */
struct obj *
headless_getobj_prompt(const char *query, boolean hands, boolean counted,
                       long *count)
{
    winid win = headless_create_nhwindow(NHW_MENU);
    struct obj *o;
    anything any;
    menu_item *selected = NULL;
    int n;
    struct obj *chosen = NULL;
    JBuf jb;
    headless_start_menu(win, MENU_BEHAVE_STANDARD);
    for (o = gi.invent; o; o = o->nobj) {
        any = cg.zeroany;
        any.a_obj = o;
        headless_add_menu(win, &nul_glyphinfo, &any, o->invlet, 0,
                          ATR_NONE, NO_COLOR, doname(o), MENU_ITEMFLAGS_NONE);
        headless_menu_object(win, o);
    }
    if (hands) {
        any = cg.zeroany;
        any.a_obj = &hands_obj;
        headless_add_menu(win, &nul_glyphinfo, &any, HANDS_SYM, 0,
                          ATR_NONE, NO_COLOR, "Hands / no item", MENU_ITEMFLAGS_NONE);
    }
    jb_init(&jb); jb_begin_obj(&jb);
    jb_key(&jb, "window"); jb_int(&jb, win);
    jb_key(&jb, "counted"); jb_bool(&jb, counted);
    jb_end_obj(&jb);
    if (jb.ok) rpc_notify("item_menu", jb.buf);
    jb_free(&jb);
    headless_end_menu(win, query);
    n = headless_select_menu(win, PICK_ONE, &selected);
    if (n == 1) {
        o = selected[0].item.a_obj;
        chosen = o;
        if (counted) *count = selected[0].count;
    }
    if (selected) free(selected);
    headless_destroy_nhwindow(win);
    return chosen;
}

static char
headless_message_menu(char let, int how, const char *mesg)
{
    char *r;
    char ans = '\0';
    JBuf jb;
    if (how == PICK_NONE) {
        headless_putstr(WIN_MESSAGE, 0, mesg);
        return 0;
    }
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "let");
    jb_int(&jb, let);
    jb_key(&jb, "text");
    jb_str(&jb, mesg ? mesg : "");
    jb_end_obj(&jb);
    r = rpc_input("msgmenu", hl_frag(&jb));
    jb_free(&jb);
    if (r) {
        const char *p = j_find_key(r, "answer");
        int ok = 0;
        char *s = p ? j_parse_str(p, &ok) : NULL;
        if (ok && s && *s)
            ans = s[0];
        free(s);
        free(r);
    }
    return ans;
}

static void
headless_mark_synch(void)
{
}

static void
headless_wait_synch(void)
{
    headless_flush();
}

#ifdef CLIPPING
static void
headless_cliparound(int x, int y)
{
    JBuf jb;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "x");
    jb_int(&jb, x);
    jb_key(&jb, "y");
    jb_int(&jb, y);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("cliparound", jb.buf);
    jb_free(&jb);
}
#endif

#ifdef POSITIONBAR
static void
headless_update_positionbar(char *posbar)
{
    JBuf jb;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "text");
    jb_str(&jb, posbar ? posbar : "");
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("positionbar", jb.buf);
    jb_free(&jb);
}
#endif

static void
headless_print_glyph(winid window, coordxy x, coordxy y,
                     const glyph_info *glyphinfo,
                     const glyph_info *bkglyphinfo)
{
    if (window == hl_map_win && x >= 0 && x < COLNO && y >= 0 && y < ROWNO
        && glyphinfo) {
        struct hl_cell *c = &hl_map[y][x];
        c->glyph = glyphinfo->glyph;
        c->ttychar = glyphinfo->ttychar;
        c->framecolor = glyphinfo->framecolor;
        c->tileidx = glyphinfo->gm.tileidx;
        c->color256idx = glyphinfo->gm.color256idx;
        c->cmap = glyph_is_cmap(glyphinfo->glyph)
            ? glyph_to_cmap(glyphinfo->glyph) : -1;
        c->background_cmap = bkglyphinfo && glyph_is_cmap(bkglyphinfo->glyph)
            ? glyph_to_cmap(bkglyphinfo->glyph) : -1;
        c->dirty = 1;
        hl_map_dirty = 1;
        (void) bkglyphinfo;
        return;
    }
    {
        JBuf jb;
        jb_init(&jb);
        jb_begin_obj(&jb);
        jb_key(&jb, "window");
        jb_int(&jb, window);
        jb_key(&jb, "x");
        jb_int(&jb, x);
        jb_key(&jb, "y");
        jb_int(&jb, y);
        jb_key(&jb, "glyph");
        hl_emit_glyph_obj(&jb, glyphinfo, bkglyphinfo);
        jb_end_obj(&jb);
        if (jb.ok)
            rpc_notify("glyph", jb.buf);
        jb_free(&jb);
    }
}

static void
headless_raw_print(const char *str)
{
    headless_putstr(WIN_MESSAGE, 0, str);
}

static void
headless_raw_print_bold(const char *str)
{
    headless_putstr(WIN_MESSAGE, ATR_BOLD, str);
}

extern void hangup(int);

static int
headless_nhgetch(void)
{
    char *r;
    int key = '\033';
    headless_flush();
    r = hl_input("key", NULL);
    if (!r) {
        hangup(0);
        return '\033';
    }
    {
        const char *p = j_find_key(r, "key");
        int ok = 0;
        long long v = j_parse_int(p, &ok);
        if (ok)
            key = (int) v;
        free(r);
    }
    return key;
}

/* These are read-only perceptions at an input boundary, not pickup/menu
 * commands. Object identities stay private to the adapter; labels use the
 * normal perceived naming rules. Blind/underwater floor uncertainty is not
 * resolved by touching things (which could petrify the explorer). */
static const char *
hl_object_class(int c)
{
    switch (c) {
    case FOOD_CLASS: return "food";
    case WEAPON_CLASS: return "weapon";
    case ARMOR_CLASS: return "armor";
    case POTION_CLASS: return "potion";
    case SCROLL_CLASS: return "scroll";
    case SPBOOK_CLASS: return "spellbook";
    case WAND_CLASS: return "wand";
    case RING_CLASS: return "ring";
    case AMULET_CLASS: return "amulet";
    case TOOL_CLASS: return "tool";
    case COIN_CLASS: return "coin";
    case GEM_CLASS: return "gem";
    default: return "object";
    }
}

static void
hl_perceived_object(JBuf *jb, struct obj *o, boolean carried)
{
    jb_sep(jb);
    jb_begin_obj(jb);
    jb_key(jb, "id"); jb_int(jb, o->o_id);
    jb_key(jb, "slot"); jb_int(jb, carried ? o->invlet : 0);
    jb_key(jb, "label"); jb_str(jb, doname(o));
    jb_key(jb, "class"); jb_str(jb, hl_object_class(o->oclass));
    jb_key(jb, "quantity"); jb_int(jb, o->quan);
    hl_known_properties(jb, o);
    /* Apparent container shape only: all bags qualify, without revealing their
     * type, contents, lock, trap or curse. Hallucination cannot identify one. */
    jb_key(jb, "container"); jb_bool(jb, !Hallucination && o->dknown && Is_container(o));
    if (carried) {
        /* These exceptions have a fixed, recognizable appearance. Do not
         * expose a hidden property or infer identity from their label. */
        jb_key(jb, "accessory");
        jb_bool(jb, !Hallucination && o->dknown &&
                (o->otyp == MEAT_RING || o->otyp == BLINDFOLD ||
                 o->otyp == TOWEL || o->otyp == LENSES));
        if (o->oclass == ARMOR_CLASS) {
            /* Visible physical layering/embedding only, not curse state or
             * a claim that taking it off will be safe or successful. */
            jb_key(jb, "armorAccessible");
            jb_bool(jb, o != uskin && !(o == uarm && uarmc)
                    && !(o == uarmu && (uarm || uarmc)));
        }
        /* Physical use of your own possessions is known; do not expose
           artifact powers, BUC state, charges, or other hidden properties. */
        jb_key(jb, "usage"); jb_begin_arr(jb);
        if (o->owornmask & (W_ARMOR | W_ACCESSORY)) { jb_sep(jb); jb_str(jb, "worn"); }
        if (o == uwep || (o == uswapwep && u.twoweap)) { jb_sep(jb); jb_str(jb, "wielded"); }
        if (o == uswapwep) { jb_sep(jb); jb_str(jb, u.twoweap ? "offhand" : "alternate"); }
        if (o == uquiver) { jb_sep(jb); jb_str(jb, "quivered"); }
        if (o->owornmask & (W_BALL | W_CHAIN)) { jb_sep(jb); jb_str(jb, "attached"); }
        jb_end_arr(jb);
    }
    jb_end_obj(jb);
}

static void
hl_perception(void)
{
    JBuf jb;
    struct obj *o;
    boolean floor_known;
    if (!hl_have_game || !isok(u.ux, u.uy))
        return;
    floor_known = !Blind && !u.uswallow
        && (!is_pool(u.ux, u.uy) || Underwater)
        && !is_lava(u.ux, u.uy);
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "perceptionVersion"); jb_int(&jb, 3);
    hl_emit_pickup(&jb);
    hl_knowledge(&jb);
    jb_key(&jb, "affordanceVersion"); jb_int(&jb, 1);
    jb_key(&jb, "knowledgeEpoch"); jb_int(&jb, ++hl_knowledge_epoch);
    jb_key(&jb, "normalMap"); jb_bool(&jb, !u.uswallow);
    /* Base body/mount/transformation and confusion/stun are known to the hero.
     * Do not inspect intrinsic/extrinsic bits or unidentified equipment powers.
     * Unusual forms remain unknown in resolver v1. */
    jb_key(&jb, "ordinaryLocomotion"); jb_bool(&jb, !Upolyd && !u.usteed);
    /* The hero knows their current form. Broad attempts deliberately do not
     * inspect material, unique identity or container contents via is_edible. */
    jb_key(&jb, "nonFoodDiet");
    jb_bool(&jb, metallivorous(gy.youmonst.data)
            || gy.youmonst.data == &mons[PM_FIRE_ELEMENTAL]
            || gy.youmonst.data == &mons[PM_GELATINOUS_CUBE]);
    jb_key(&jb, "doorDiagonals"); jb_bool(&jb, !Is_rogue_level(&u.uz));
    jb_key(&jb, "directionReliable"); jb_bool(&jb, !Confusion && !Stunned);
    jb_key(&jb, "branch"); jb_int(&jb, u.uz.dnum);
    jb_key(&jb, "level"); jb_int(&jb, u.uz.dlevel);
    jb_key(&jb, "x"); jb_int(&jb, u.ux);
    jb_key(&jb, "y"); jb_int(&jb, u.uy);
    jb_key(&jb, "inventory"); jb_begin_arr(&jb);
    for (o = gi.invent; o; o = o->nobj)
        hl_perceived_object(&jb, o, TRUE);
    jb_end_arr(&jb);
    /* The hero glyph can obscure the feature after a full level redraw.
     * back_to_glyph is a read-only terrain renderer and requires sight; it
     * masks secret doors/corridors and does not inspect hidden traps. */
    if (floor_known && cansee(u.ux, u.uy)) {
        int here_glyph = back_to_glyph(u.ux, u.uy);
        if (glyph_is_cmap(here_glyph)) {
            jb_key(&jb, "hereCmap"); jb_int(&jb, glyph_to_cmap(here_glyph));
        }
    }
    jb_key(&jb, "floorKnown"); jb_bool(&jb, floor_known);
    jb_key(&jb, "floor"); jb_begin_arr(&jb);
    if (floor_known)
        for (o = svl.level.objects[u.ux][u.uy]; o; o = o->nexthere)
            hl_perceived_object(&jb, o, FALSE);
    jb_end_arr(&jb);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("perception", jb.buf);
    jb_free(&jb);
}

/* Decisions can interrupt a deed after inventory has already changed (for
 * example, one bite before a near-full warning). Publish at each semantic
 * input boundary, not only at the next resting command prompt. */
static char *
hl_input(const char *kind, const char *params)
{
    char *reply;
    const char *settings;
    for (;;) {
        headless_flush();
        hl_perception();
        reply = rpc_input(kind, params);
        if (!reply || (strcmp(kind, "key") && strcmp(kind, "poskey"))
            || gg.getposx > 0 || !(settings = j_find_key(reply, "automaticPickup")))
            return reply;
        /* A settings response is a journaled, zero-turn command-boundary
         * change. It never becomes a movement key or answers another prompt. */
        if (!hl_pickup_configure(settings)) panic("invalid automatic pickup update");
        free(reply);
    }
}

static int
headless_nh_poskey(coordxy *x, coordxy *y, int *mod)
{
    char *r;
    int key = '\033', ok = 0;
    if (gg.getposx > 0) {
        JBuf jb;
        jb_init(&jb); jb_begin_obj(&jb);
        jb_key(&jb, "positionMode"); jb_int(&jb, iflags.terrainmode ? 2 : 1);
        jb_key(&jb, "cursorX"); jb_int(&jb, gg.getposx);
        jb_key(&jb, "cursorY"); jb_int(&jb, gg.getposy);
        jb_key(&jb, "prompt"); jb_str(&jb, iflags.terrainmode ? "Explore the detected map" : "Choose a location");
        jb_end_obj(&jb);
        r = hl_input("poskey", hl_frag(&jb));
        jb_free(&jb);
    } else r = hl_input("poskey", NULL);
    if (!r) {
        hangup(0);
        return '\033';
    }
    if (x && y && mod) {
        *x = (coordxy) hl_param_int(r, "x", 0);
        *y = (coordxy) hl_param_int(r, "y", 0);
        *mod = (int) hl_param_int(r, "mod", 0);
    }
    {
        const char *p = j_find_key(r, "key");
        long long v = j_parse_int(p, &ok);
        if (ok)
            key = (int) v;
        free(r);
    }
    return key;
}

static void
headless_nhbell(void)
{
    rpc_notify("bell", NULL);
}

static int
headless_doprev_message(void)
{
    return 0;
}

static const struct obj *hl_floor_prompt_item;
void headless_floor_item(const struct obj *o) { hl_floor_prompt_item = o; }

static char
headless_yn_function(const char *query, const char *resp, char def)
{
    char *r;
    char ans = def;
    JBuf jb;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "prompt");
    jb_str(&jb, query ? query : "");
    jb_key(&jb, "choices");
    jb_str(&jb, resp ? resp : "");
    jb_key(&jb, "default");
    jb_int(&jb, def);
    jb_key(&jb, "objectId"); jb_int(&jb, hl_floor_prompt_item ? hl_floor_prompt_item->o_id : 0);
    jb_key(&jb, "context");
    jb_str(&jb, hl_floor_prompt_item ? "floorItem" : program_state.input_state == getdirInp && !resp
                  ? "direction" : "confirmationOrChoice");
    jb_end_obj(&jb);
    r = hl_input("yn", hl_frag(&jb));
    jb_free(&jb);
    if (r) {
        const char *p = j_find_key(r, "answer");
        int ok = 0;
        char *s = p ? j_parse_str(p, &ok) : NULL;
        if (ok && s && *s)
            ans = s[0];
        free(s);
        free(r);
    }
    /* Window-port contract (doc/window.txt): Escape cancels through q, n,
     * or the caller's default. Returning raw Escape for a restricted prompt
     * makes the core report an impossible response. Unrestricted direction
     * and inventory prompts must retain Escape for their own cancellation. */
    if (ans == '\033' && resp) {
        if (strchr(resp, 'q'))
            ans = 'q';
        else if (strchr(resp, 'n'))
            ans = 'n';
        else
            ans = def;
    }
    return ans;
}

static const char *hl_text_context;
void headless_text_context(const char *context) { hl_text_context = context; }

static void
headless_getlin(const char *query, char *bufp)
{
    char *r;
    JBuf jb;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "prompt");
    jb_str(&jb, query ? query : "");
    if (hl_text_context) {
        jb_key(&jb, "context"); jb_str(&jb, hl_text_context);
    }
    jb_end_obj(&jb);
    r = hl_input("getlin", hl_frag(&jb));
    jb_free(&jb);
    bufp[0] = '\0';
    if (r) {
        const char *p = j_find_key(r, "line");
        int ok = 0;
        char *s = p ? j_parse_str(p, &ok) : NULL;
        if (ok && s) {
            strncpy(bufp, s, BUFSZ - 1);
            bufp[BUFSZ - 1] = '\0';
        }
        free(s);
        free(r);
    }
}

static int
headless_get_ext_cmd(void)
{
    /* the client cannot guess indices: send the command names along.
     * extcmdlist[] is NULL-ef_txt-terminated (see cmd.c). */
    JBuf jb;
    char *r;
    int idx = -1, i = 0;
    const struct ext_func_tab *efp;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "commands");
    jb_begin_arr(&jb);
    for (efp = extcmdlist; efp->ef_txt; efp++, i++) {
        jb_sep(&jb);
        jb_str(&jb, efp->ef_txt);
        if (i > 4096)
            break; /* sanity: table is short, never loop forever */
    }
    jb_end_arr(&jb);
    jb_end_obj(&jb);
    r = hl_input("extcmd", hl_frag(&jb));
    jb_free(&jb);
    if (r) {
        idx = (int) hl_param_int(r, "index", -1);
        free(r);
    }
    return idx;
}

static void
headless_number_pad(int state)
{
    JBuf jb;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "state");
    jb_int(&jb, state);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("number_pad", jb.buf);
    jb_free(&jb);
}

static void
headless_delay_output(void)
{
    rpc_notify("delay", NULL);
}

#ifdef CHANGE_COLOR
static void
headless_change_color(int color, long rgb, int reverse)
{
    (void) color;
    (void) rgb;
    (void) reverse;
}

static char *
headless_get_color_string(void)
{
    return "";
}
#endif

static void
headless_preference_update(const char *pref)
{
    JBuf jb;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "pref");
    jb_str(&jb, pref ? pref : "");
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("preference", jb.buf);
    jb_free(&jb);
}

static char *
headless_getmsghistory(boolean init)
{
    int i;
    if (init) {
        /* snapshot entries are borrowed from the ring; free only the array */
        free(hl_snapshot);
        hl_snapshot = NULL;
        if (hl_msgcount > 0) {
            hl_snapshot = malloc((size_t) hl_msgcount * sizeof *hl_snapshot);
            if (hl_snapshot) {
                for (i = 0; i < hl_msgcount; i++)
                    hl_snapshot[i] =
                        hl_msgs[(hl_msgnext + i) % HL_MSGLOG];
                hl_snapcount = hl_msgcount;
            } else {
                hl_snapcount = 0;
            }
        } else {
            hl_snapcount = 0;
        }
        hl_snapidx = 0;
    }
    if (hl_snapidx < hl_snapcount)
        return hl_snapshot[hl_snapidx++];
    return NULL;
}

static void
headless_putmsghistory(const char *msg, boolean restoring_msghist)
{
    (void) restoring_msghist;
    /* re-emit so the client rebuilds the same history (matters on restore) */
    headless_putstr(WIN_MESSAGE, 0, msg);
}

static void
headless_status_init(void)
{
    rpc_notify("status_init", NULL);
}

static void
headless_status_update(int fldidx, genericptr_t ptr, int chg, int percent,
                       int color, unsigned long *colormasks)
{
    JBuf jb;
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "field");
    jb_int(&jb, fldidx);
    if (fldidx == BL_CONDITION) {
        /* core passes &blstats[].a.a_ulong (see botl.c), NOT a stuffed
         * value: dereference to get the deterministic condition bitmask */
        jb_key(&jb, "condition");
        jb_int(&jb, ptr ? (long long) *(unsigned long *) ptr : 0);
    } else {
        const char *v = ptr ? (const char *) ptr : "";
        if (fldidx == BL_GOLD) {
            /* Core passes "$:N" or "\GXXXXNNNN:N" (see botl.c): the
             * currency prefix is a tty glyph encoding, so the protocol
             * carries just the amount. */
            const char *c = strchr(v, ':');
            if (c)
                v = c + 1;
        }
        jb_key(&jb, "value");
        jb_str(&jb, v);
    }
    jb_key(&jb, "change");
    jb_int(&jb, chg);
    jb_key(&jb, "percent");
    jb_int(&jb, percent);
    jb_key(&jb, "color");
    jb_int(&jb, color);
    if (colormasks) {
        jb_key(&jb, "colormask");
        jb_int(&jb, (long long) *colormasks);
    }
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("status_update", jb.buf);
    jb_free(&jb);
    if (fldidx == BL_FLUSH)
        headless_flush();
}

static void
headless_update_inventory(int a1)
{
    JBuf jb;
    (void) a1;
    headless_flush();
    jb_init(&jb);
    jb_begin_obj(&jb);
    jb_key(&jb, "perm");
    jb_bool(&jb, iflags.perm_invent);
    jb_end_obj(&jb);
    if (jb.ok)
        rpc_notify("inventory", jb.buf);
    jb_free(&jb);
}

static win_request_info *
headless_ctrl_nhwindow(winid window, int request, win_request_info *wri)
{
    (void) window;
    (void) request;
    return wri;
}

/* Interface definition used in windows.c */
struct window_procs headless_procs = {
    WPID(headless),
    (0
     | WC_ASCII_MAP
     | WC_MOUSE_SUPPORT
     | WC_COLOR | WC_HILITE_PET | WC_INVERSE | WC_EIGHT_BIT_IN),
    (0
#if defined(SELECTSAVED)
     | WC2_SELECTSAVED
#endif
#if defined(STATUS_HILITES)
     | WC2_HILITE_STATUS | WC2_HITPOINTBAR | WC2_FLUSH_STATUS
     | WC2_RESET_STATUS
#endif
     | WC2_DARKGRAY | WC2_SUPPRESS_HIST | WC2_STATUSLINES),
    {1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1},
    headless_init_nhwindows, headless_player_selection, headless_askname,
    headless_get_nh_event, headless_exit_nhwindows,
    headless_suspend_nhwindows, headless_resume_nhwindows,
    headless_create_nhwindow, headless_clear_nhwindow,
    headless_display_nhwindow, headless_destroy_nhwindow, headless_curs,
    headless_putstr, genl_putmixed, headless_display_file,
    headless_start_menu, headless_add_menu, headless_end_menu,
    headless_select_menu, headless_message_menu, headless_mark_synch,
    headless_wait_synch,
#ifdef CLIPPING
    headless_cliparound,
#endif
#ifdef POSITIONBAR
    headless_update_positionbar,
#endif
    headless_print_glyph, headless_raw_print, headless_raw_print_bold,
    headless_nhgetch, headless_nh_poskey, headless_nhbell,
    headless_doprev_message, headless_yn_function, headless_getlin,
    headless_get_ext_cmd, headless_number_pad, headless_delay_output,
#ifdef CHANGE_COLOR
    headless_change_color,
#ifdef MAC
    0, 0,
#endif
    headless_get_color_string,
#endif
    genl_outrip, headless_preference_update, headless_getmsghistory,
    headless_putmsghistory, headless_status_init, genl_status_finish,
    genl_status_enablefield,
#ifdef STATUS_HILITES
    headless_status_update,
#else
    genl_status_update,
#endif
    genl_can_suspend_yes, headless_update_inventory,
    headless_ctrl_nhwindow,
};
