/* Included only in a separately compiled temporary test engine. Configure a
 * fresh world once; all attempted actions then use the real public driver and
 * engine costs. Never loaded by production or into an existing session. */
static void attempt_fixture_prepare(void)
{
    static int prepared;
    const char *mode = getenv("NNH_ATTEMPT_FIXTURE");
    int dx, dy;
    if (prepared || !mode || !isok(u.ux, u.uy)) return;
    prepared = 1;
    if (!strcmp(mode, "heavy")) {
        (void) mksobj_at(BOULDER, u.ux, u.uy, TRUE, FALSE);
        newsym(u.ux, u.uy);
        flush_screen(1);
        return;
    }
    for (dy = -1; dy <= 1; dy++) for (dx = -1; dx <= 1; dx++) {
        int x = u.ux + dx, y = u.uy + dy;
        int xx = x + dx, yy = y + dy;
        if ((!dx && !dy) || !isok(x,y) || !isok(xx,yy)
            || !cansee(x,y) || !cansee(xx,yy)
            || levl[x][y].typ != ROOM || levl[xx][yy].typ != ROOM
            || m_at(x,y) || m_at(xx,yy) || t_at(x,y) || t_at(xx,yy)
            || svl.level.objects[x][y] || svl.level.objects[xx][yy]) continue;
        (void) mksobj_at(BOULDER, x, y, TRUE, FALSE);
        newsym(x,y);
        flush_screen(1);
        return;
    }
    panic("No disclosed empty pair for boulder outcome fixture");
}
