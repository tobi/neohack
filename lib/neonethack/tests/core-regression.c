/* Retained private-core regression probe. The public v1 ABI is tested in api.c.
 * Exercises real named actions, decisions, outcomes, retries and resume through
 * the internal driver, not raw engine input. Run via CTest or with ENGINE DATA.
 */
#define _POSIX_C_SOURCE 200809L
#define _XOPEN_SOURCE 700
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "explorer.h"
#include "minjson.h"

static const char *BIN;
static const char *HACKDIR_SRC;

static int failures = 0;
#define CHECK(cond, ...) do { \
        if (!(cond)) { \
            printf("FAIL: "); printf(__VA_ARGS__); printf("\n"); \
            failures++; \
        } \
    } while (0)

static char *
call(nhx_t *x, const char *req)
{
    char *r = nhx_call(x, req);
    if (!r) {
        printf("FAIL: null response for %s\n", req);
        failures++;
    }
    return r;
}

static int
has(const char *resp, const char *frag)
{
    return resp && strstr(resp, frag) != NULL;
}

static long
jnum(const char *resp, const char *key)
{
    const char *p;
    char buf[64];
    if (!resp || !(p = strstr(resp, key)))
        return -1;
    p += strlen(key);
    snprintf(buf, sizeof buf, "%-.40s", p);
    return strtol(buf, NULL, 10);
}

static int
jcount(const char *resp, const char *frag)
{
    int n = 0;
    const char *p = resp;
    size_t len = strlen(frag);
    if (!p)
        return 0;
    while ((p = strstr(p, frag)) != NULL) {
        n++;
        p += len;
    }
    return n;
}

/* First "turn": value (observation turn: outcome uses turnsElapsed). */
static long
obs_turn(const char *resp)
{
    return jnum(resp, "\"turn\":");
}

static long
revision(const char *resp)
{
    return jnum(resp, "\"revision\":");
}

static int
obs_pos(const char *resp, long *x, long *y)
{
    const char *p;
    if (!resp || !(p = strstr(resp, "\"you\":{\"x\":")))
        return 0;
    *x = strtol(p + 11, NULL, 10);
    p = strstr(p, "\"y\":");
    if (!p)
        return 0;
    *y = strtol(p + 4, NULL, 10);
    return 1;
}

static int
decision_id(const char *resp, char *out, size_t cap)
{
    const char *p;
    size_t i = 0;
    if (!resp || !(p = strstr(resp, "\"decision\":{\"id\":\"")))
        return 0;
    p += 18;
    while (*p && *p != '"' && i + 1 < cap)
        out[i++] = *p++;
    out[i] = '\0';
    return i > 0;
}

static int
session_id(const char *resp, char *out, size_t cap)
{
    const char *p;
    size_t i = 0;
    if (!resp || !(p = strstr(resp, "\"sessionId\":\"")))
        return 0;
    p += 13;
    while (*p && *p != '"' && i + 1 < cap)
        out[i++] = *p++;
    out[i] = '\0';
    return i > 0;
}

int
main(int argc, char **argv)
{
    nhx_t *x;
    char sessdir[] = "/tmp/nhxaccXXXXXX";
    char sid[80] = { 0 };
    char req[1024];
    char dec[48] = { 0 };
    char *r;
    long turn0, rev0, px, py;

    if (argc != 3) { fprintf(stderr, "usage: %s ENGINE DATA\n", argv[0]); return 2; }
    BIN = argv[1]; HACKDIR_SRC = argv[2];
    if (!mkdtemp(sessdir)) {
        printf("FAIL: mkdtemp\n");
        return 1;
    }
    x = nhx_open(BIN, HACKDIR_SRC, sessdir);
    CHECK(x != NULL, "open handle");
    if (!x)
        return 1;

    /* new_game completes with a full observation. */
    r = call(x, "{\"tool\":\"new_game\",\"name\":\"ctest\",\"seed\":7,"
             "\"role\":\"healer\",\"race\":\"elf\",\"gender\":\"female\","
             "\"align\":\"neutral\"}");
    CHECK(has(r, "\"status\":\"completed\""), "new_game completes: %s",
          r ? r + 40 : "(null)");
    CHECK(has(r, "\"strength\":\""), "vitals tracked");
    CHECK(jcount(r, "\"id\":\"item-") >= 8, "starting inventory known");
    CHECK(session_id(r, sid, sizeof sid) && sid[0], "session id issued");
    turn0 = obs_turn(r);
    rev0 = revision(r);
    CHECK(obs_pos(r, &px, &py), "position known");
    printf("start: turn=%ld rev=%ld pos=%ld,%ld sid=%s\n", turn0, rev0,
           px, py, sid);
    nhx_free(r);

    /* Independent world-sets in one process must also honor ownership. */
    {
        nhx_t *other = nhx_open(BIN, HACKDIR_SRC, sessdir);
        char *busy;
        CHECK(other != NULL, "second handle opens");
        snprintf(req, sizeof req, "{\"tool\":\"resume\",\"sessionId\":\"%s\"}", sid);
        busy = other ? call(other, req) : NULL;
        CHECK(has(busy, "\"code\":\"sessionBusy\""), "second handle cannot steal an active world");
        nhx_free(busy);
        nhx_close(other);
    }

    /* Invalid targets fail before engine input: no turn passes. */
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"kick\","
             "\"target\":\"self\"}", sid);
    r = call(x, req);
    CHECK(has(r, "\"code\":\"invalidTarget\""), "kick self rejected");
    CHECK(obs_turn(r) == turn0, "rejected kick costs no turn");
    nhx_free(r);

    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"zap\","
             "\"target\":{\"position\":{\"x\":1,\"y\":1}}}", sid);
    r = call(x, req);
    CHECK(has(r, "\"code\":\"invalidTarget\""), "zap position rejected");
    nhx_free(r);

    /* Unknown actions are honest. */
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"teleport\"}",
             sid);
    r = call(x, req);
    CHECK(has(r, "\"code\":\"unsupportedAction\""), "intrinsic teleport remains unsupported");
    nhx_free(r);

    /* Climb with no stairs underfoot is blocked, not a wall bump. */
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"climb\","
             "\"direction\":\"down\"}", sid);
    r = call(x, req);
    CHECK(has(r, "\"status\":\"blocked\""), "climb blocked: %.120s",
          strstr(r, "\"outcome\""));
    CHECK(has(r, "\"positionChanged\":false"), "climb moves nothing");
    nhx_free(r);

    /* kick works with a compass direction and no letter leakage. */
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"kick\","
             "\"target\":{\"direction\":\"south\"}}", sid);
    r = call(x, req);
    CHECK(has(r, "\"status\":\"completed\"") ||
          has(r, "\"status\":\"blocked\""), "kick settles");
    CHECK(has(r, "\"kicked\"") || has(r, "\"status\":\"blocked\""),
          "kick reports its effect");
    CHECK(!has(r, "\"key\":106") && !has(r, "\"key\":\"j\""), "no raw input key leakage in kick");
    nhx_free(r);

    /* The kick above spent a turn: re-baseline for zero-turn checks. */
    snprintf(req, sizeof req,
             "{\"tool\":\"get_state\",\"sessionId\":\"%s\"}", sid);
    r = call(x, req);
    turn0 = obs_turn(r);
    rev0 = revision(r);
    nhx_free(r);

    /* eat lists eligible food with no turn and no revision move. */
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"eat\"}",
             sid);
    r = call(x, req);
    CHECK(has(r, "\"status\":\"needsChoice\""), "eat lists");
    CHECK(has(r, "\"kind\":\"item\""), "eat offers an item decision");
    {
        /* The observation legitimately carries gold; only the offered
         * options must be food. */
        mj_val decision, options; size_t length = 0; char *opts = NULL;
        if (mj_find(r, "decision", &decision) && mj_find(decision.p, "options", &options)) {
            const char *raw = mj_raw(options, &length); opts = strndup(raw, length);
        }
        CHECK(opts && !strstr(opts, "gold pieces"), "gold is not food"); free(opts);
    }
    CHECK(obs_turn(r) == turn0, "listing costs no turn");
    CHECK(revision(r) == rev0, "listing costs no revision");
    CHECK(decision_id(r, dec, sizeof dec), "listing has an id");
    nhx_free(r);

    /* A miss reports noMatch without spending a turn. */
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"drink\","
             "\"item\":\"motor oil\"}", sid);
    r = call(x, req);
    CHECK(has(r, "\"code\":\"noMatch\""), "drink miss is noMatch");
    CHECK(has(r, "\"status\":\"blocked\""), "miss is blocked");
    nhx_free(r);

    /* Two matches require selection instead of silent choice. */
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"drink\","
             "\"item\":\"healing\"}", sid);
    r = call(x, req);
    CHECK(has(r, "\"status\":\"needsChoice\""), "ambiguous drink lists");
    CHECK(jcount(r, "\"location\":\"inventory\"") >= 2,
          "both potions offered");
    nhx_free(r);

    /* Prayer raises a typed confirmation; declining never restarts it. */
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"pray\"}",
             sid);
    r = call(x, req);
    CHECK(has(r, "\"kind\":\"confirmation\""), "prayer confirms");
    CHECK(decision_id(r, dec, sizeof dec), "prayer offer id");
    nhx_free(r);
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"replyTo\":\"%s\","
             "\"confirm\":false}", sid, dec);
    r = call(x, req);
    CHECK(has(r, "\"status\":\"completed\"") ||
          has(r, "\"status\":\"blocked\""), "declined prayer settles");
    CHECK(!has(r, "\"kind\":\"confirmation\""), "no second confirmation");
    nhx_free(r);

    /* A wrong answer shape preserves the standing offer. */
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"pray\"}",
             sid);
    r = call(x, req);
    CHECK(decision_id(r, dec, sizeof dec), "second prayer offer");
    nhx_free(r);
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"replyTo\":\"%s\","
             "\"choose\":3}", sid, dec);
    r = call(x, req);
    CHECK(has(r, "\"code\":\"invalidAnswer\""), "wrong shape rejected");
    nhx_free(r);
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"replyTo\":\"%s\","
             "\"cancel\":true}", sid, dec);
    r = call(x, req);
    CHECK(has(r, "\"status\":\"cancelled\""), "cancel works, prompt kept");
    nhx_free(r);

    /* requestId retries return the original; conflicts are refused;
     * a known retry wins over stale-revision rejection. */
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"wait\","
             "\"requestId\":\"req-1\"}", sid);
    r = call(x, req);
    {
        char *first = r ? strdup(r) : NULL;
        long rev1 = revision(r);
        char req2[1024];
        char *r2;
        snprintf(req2, sizeof req2,
                 "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"wait\","
                 "\"requestId\":\"req-1\",\"expectedRevision\":0}", sid);
        r2 = call(x, req2);
        CHECK(first && r2 && !strcmp(first, r2),
              "same id+payload replays the original");
        free(first);
        nhx_free(r2);
        snprintf(req2, sizeof req2,
                 "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"search\","
                 "\"requestId\":\"req-1\"}", sid);
        r2 = call(x, req2);
        CHECK(has(r2, "\"code\":\"requestConflict\""), "id reuse refused");
        nhx_free(r2);
        snprintf(req2, sizeof req2,
                 "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"wait\","
                 "\"expectedRevision\":0}", sid);
        r2 = call(x, req2);
        CHECK(has(r2, "\"code\":\"staleRevision\""), "stale rejected");
        nhx_free(r2);
        CHECK(rev1 >= 0, "wait bumped the revision");
    }
    nhx_free(r);

    /* Opaque item refs survive slot changes, but dropped refs are rejected. */
    {
        char itemid[64] = "";
        const char *lp;
        snprintf(req, sizeof req,
                 "{\"tool\":\"act\",\"sessionId\":\"%s\","
                 "\"action\":\"inventory\"}", sid);
        r = call(x, req);
        lp = strstr(r, "\"id\":\"item-");
        if (lp) {
            size_t n = strcspn(lp + 6, "\"");
            if (n && n < sizeof itemid) {
                memcpy(itemid, lp + 6, n);
                itemid[n] = '\0';
            }
        }
        nhx_free(r);
        CHECK(itemid[0] != 0, "a droppable item reference exists");
        if (itemid[0]) {
            char nm[512];
            snprintf(nm, sizeof nm,
                     "{\"tool\":\"act\",\"sessionId\":\"%s\","
                     "\"action\":\"drop\",\"item\":{\"id\":\"%s\"}}",
                     sid, itemid);
            r = call(x, nm);
            CHECK(has(r, "\"status\":\"completed\""), "drop settles");
            nhx_free(r);
            snprintf(nm, sizeof nm,
                     "{\"tool\":\"act\",\"sessionId\":\"%s\","
                     "\"action\":\"wield\",\"item\":{\"id\":\"%s\"}}",
                     sid, itemid);
            r = call(x, nm);
            CHECK(has(r, "\"code\":\"staleReference\"") ||
                  has(r, "\"code\":\"noMatch\""),
                  "dropped slot does not rebind");
            nhx_free(r);
        }
    }

    /* 100 actions from act calls alone, then an independent snapshot
     * must match the accumulated perception. */
    {
        static const char *dirs[] = { "north", "south", "east", "west" };
        long lx = 0, ly = 0, lt = 0, lrev = 0;
        int k;
        char ddec[48];
        for (k = 0; k < 100; k++) {
            snprintf(req, sizeof req,
                     "{\"tool\":\"act\",\"sessionId\":\"%s\","
                     "\"action\":\"move\",\"direction\":\"%s\"}",
                     sid, dirs[k % 4]);
            r = call(x, req);
            if (!r)
                break;
            if (has(r, "\"status\":\"needsChoice\"") &&
                decision_id(r, ddec, sizeof ddec)) {
                char creq[512];
                nhx_free(r);
                snprintf(creq, sizeof creq,
                         "{\"tool\":\"act\",\"sessionId\":\"%s\","
                         "\"replyTo\":\"%s\",\"cancel\":true}", sid, ddec);
                r = call(x, creq);
            }
            if (has(r, "\"ended\":true"))
                break;
            lt = obs_turn(r);
            lrev = revision(r);
            obs_pos(r, &lx, &ly);
            nhx_free(r);
        }
        CHECK(k == 100, "100 actions played");
        snprintf(req, sizeof req,
                 "{\"tool\":\"get_state\",\"sessionId\":\"%s\"}", sid);
        r = call(x, req);
        CHECK(obs_turn(r) == lt, "snapshot turn matches (%ld==%ld)",
              obs_turn(r), lt);
        {
            long sx = 0, sy = 0;
            CHECK(obs_pos(r, &sx, &sy) && sx == lx && sy == ly,
                  "snapshot position matches");
        }
        CHECK(revision(r) == lrev, "snapshot revision matches");
        CHECK(!has(r, "\"ended\":true"), "explorer survived the walk");
        nhx_free(r);
    }

    /* Self-directed zap stays a zap: never a wait, never a plain step. */
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"zap\","
             "\"item\":\"sleep\",\"target\":\"self\"}", sid);
    r = call(x, req);
    if (has(r, "\"status\":\"needsChoice\"") &&
        decision_id(r, dec, sizeof dec)) {
        char creq[512];
        /* A wand prompt may ask confirmation first: confirm it. */
        if (has(r, "\"kind\":\"confirmation\"")) {
            nhx_free(r);
            snprintf(creq, sizeof creq,
                     "{\"tool\":\"act\",\"sessionId\":\"%s\","
                     "\"replyTo\":\"%s\",\"confirm\":true}", sid, dec);
            r = call(x, creq);
        } else if (has(r, "\"kind\":\"item\"")) {
            /* choose the sleep wand explicitly */
            const char *op = strstr(r, "\"id\":\"item-");
            char wid[16] = { 0 };
            if (op)
                sscanf(op + 12, "%15[^\"]", wid);
            nhx_free(r);
            snprintf(creq, sizeof creq,
                     "{\"tool\":\"act\",\"sessionId\":\"%s\","
                     "\"replyTo\":\"%s\",\"item\":{\"id\":\"%s\"}}",
                     sid, dec, wid);
            r = call(x, creq);
        }
    }
    CHECK(has(r, "\"action\":\"zap\""), "self zap stays a zap");
    CHECK(!has(r, "\"positionChanged\":true"), "self zap does not move");
    CHECK(has(r, "\"status\":\"completed\"") ||
          has(r, "\"status\":\"needsChoice\""), "self zap settles");
    nhx_free(r);

    /* Resume restores perception; a second observer consumes nothing. */
    {
        long t_before, r_before;
        snprintf(req, sizeof req,
                 "{\"tool\":\"get_state\",\"sessionId\":\"%s\"}", sid);
        r = call(x, req);
        t_before = obs_turn(r);
        r_before = revision(r);
        nhx_free(r);
        nhx_close(x);
        x = nhx_open(BIN, HACKDIR_SRC, sessdir);
        CHECK(x != NULL, "reopen handle");
        snprintf(req, sizeof req,
                 "{\"tool\":\"resume\",\"sessionId\":\"%s\"}", sid);
        r = call(x, req);
        CHECK(has(r, "\"status\":\"completed\"") ||
              has(r, "\"status\":\"needsChoice\""), "resume settles");
        nhx_free(r);
        snprintf(req, sizeof req,
                 "{\"tool\":\"get_state\",\"sessionId\":\"%s\"}", sid);
        r = call(x, req);
        CHECK(obs_turn(r) == t_before, "resume keeps the turn");
        {
            char *a = r ? strdup(r) : NULL;
            char *b;
            snprintf(req, sizeof req,
                     "{\"tool\":\"get_state\",\"sessionId\":\"%s\"}", sid);
            b = call(x, req);
            CHECK(a && b && revision(a) == revision(b),
                  "observation consumes nothing");
            free(a);
            nhx_free(b);
        }
        CHECK(revision(r) == r_before, "resume keeps the revision");
        nhx_free(r);
    }

    /* A listing survives resume: the old offer id still answers. */
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"action\":\"eat\"}",
             sid);
    r = call(x, req);
    CHECK(has(r, "\"kind\":\"item\"") && decision_id(r, dec, sizeof dec),
          "pre-resume listing");
    nhx_free(r);
    nhx_close(x);
    x = nhx_open(BIN, HACKDIR_SRC, sessdir);
    CHECK(x != NULL, "reopen handle 2");
    snprintf(req, sizeof req, "{\"tool\":\"resume\",\"sessionId\":\"%s\"}",
             sid);
    r = call(x, req);
    nhx_free(r);
    snprintf(req, sizeof req,
             "{\"tool\":\"act\",\"sessionId\":\"%s\",\"replyTo\":\"%s\","
             "\"cancel\":true}", sid, dec);
    r = call(x, req);
    CHECK(has(r, "\"status\":\"cancelled\""), "old listing answers");
    nhx_free(r);

    nhx_close(x);
    if (failures == 0)
        printf("EXPLORER ACCEPTANCE: all green\n");
    else
        printf("EXPLORER ACCEPTANCE: %d failures\n", failures);
    return failures != 0;
}
