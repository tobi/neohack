/* Only compiled into disposable scenario engines. No production test hook.
 * Set the scene; acquisition, escape and release use normal engine actions. */
void held_fixture(void)
{
    struct monst *m, *next;
    struct obj *o;
    int x, y, i;
    for (m = fmon; m; m = next) { next = m->nmon; mongone(m); }
    u.ux = 40; u.uy = 10;
    for (x = 34; x <= 46; x++) for (y = 4; y <= 16; y++) {
        struct trap *trap = t_at(x, y);
        if (trap) deltrap(trap);
        levl[x][y].typ = ROOM; levl[x][y].lit = 1;
        unblock_point(x, y);
    }
    u.uhp = u.uhpmax = 200;
    /* Deliberately disable every visual condition after startup, including
     * default-on ones. The semantic feed must not depend on these choices. */
    for (i = 0; i < CONDITION_COUNT; i++) condtests[i].enabled = FALSE;
    m = makemon(&mons[PM_VIOLET_FUNGUS], 41, 9, NO_MM_FLAGS);
    m->mpeaceful = m->mtame = m->msleeping = 0;
    m->movement = NORMAL_SPEED;
    m->minvis = m->perminvis = !strcmp(svp.plname, "InvisibleHold");
    o = mksobj(WAN_DEATH, FALSE, FALSE);
    o->spe = 5; o->known = o->dknown = o->bknown = 1;
    o->cursed = o->blessed = 0;
    o = oname(o, "release-wand", ONAME_NO_FLAGS);
    (void) addinv(o);
    vision_recalc(0); docrt(); update_inventory(); disp.botl = TRUE;
}
