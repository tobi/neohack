/* Temporary test engine only. Keep genuine downward stairs and their level
 * destination; place the hero one ordinary step away on disclosed floor. */
void descent_fixture(void)
{
    static boolean prepared = FALSE;
    stairway *stairs;
    struct monst *m, *next;
    int x, y;
    if (prepared) return;
    prepared = TRUE;
    stairs = stairway_find_dir(FALSE);
    if (!stairs) panic("descent fixture needs downward stairs");
    for (m = fmon; m; m = next) { next = m->nmon; mongone(m); }
    for (y = 0; y < ROWNO; y++) for (x = 1; x < COLNO; x++) {
        struct trap *trap = t_at(x,y);
        if (trap) deltrap(trap);
        while (svl.level.objects[x][y]) delobj(svl.level.objects[x][y]);
        if (!On_stairs(x,y)) levl[x][y].typ = ROOM;
        levl[x][y].lit = 1;
    }
    u.ux = stairs->sx == 79 ? 78 : stairs->sx + 1;
    u.uy = stairs->sy;
    vision_reset(); vision_recalc(0); docrt(); update_inventory(); disp.botl = TRUE;
}
