/* Test engines only: deliberately asymmetric landmarks and boundary origins.
 * Normal engine perception, movement and serialization run afterward. */
void map_coordinate_fixture(void)
{
    static boolean prepared = FALSE;
    struct monst *m, *next;
    struct obj *o;
    int x, y, hero_x, hero_y, dx, dy;
    if (prepared) return;
    prepared = TRUE;
    if (sscanf(svp.plname, "Coord%dx%d", &hero_x, &hero_y) != 2 || !isok(hero_x, hero_y)) panic("invalid map test origin");
    for (m = fmon; m; m = next) { next = m->nmon; mongone(m); }
    for (y = 0; y < ROWNO; y++) for (x = 1; x < COLNO; x++) {
        struct trap *trap = t_at(x,y);
        if (trap) deltrap(trap);
        while (svl.level.objects[x][y]) delobj(svl.level.objects[x][y]);
        levl[x][y].typ = ROOM; levl[x][y].lit = 1;
    }
    u.ux = hero_x; u.uy = hero_y;
    dx = hero_x > 40 ? -1 : 1; dy = hero_y > 10 ? -1 : 1;
    levl[hero_x + 2*dx][hero_y + dy].typ = FOUNTAIN;
    levl[hero_x + dx][hero_y + 2*dy].typ = SINK;
    o = mksobj(GOLD_PIECE,FALSE,FALSE); o->quan = 19; o->owt = weight(o);
    place_object(o,hero_x + dx,hero_y);
    o = mksobj(DIAMOND,FALSE,FALSE); place_object(o,hero_x,hero_y);
    vision_reset(); vision_recalc(0); docrt(); update_inventory(); disp.botl = TRUE;
}
