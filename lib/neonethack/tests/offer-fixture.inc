/* Isolated test engine only. This establishes an altar and real objects;
 * the public operation still runs dosacrifice and the engine's real ending.
 * It is not evidence of a start-to-ascension route. */
void offer_fixture(void)
{
    static boolean prepared = FALSE;
    struct obj *o;
    struct monst *m, *next;
    if (prepared || !isok(u.ux, u.uy)) return;
    prepared = TRUE;
    for (m = fmon; m; m = next) { next = m->nmon; mongone(m); }
    levl[u.ux][u.uy].typ = ALTAR;
    levl[u.ux][u.uy].altarmask = Align2amask(u.ualign.type) | AM_SANCTUM;
    o = mksobj(!strcmp(svp.plname,"FakeOffering") ? FAKE_AMULET_OF_YENDOR : AMULET_OF_YENDOR, FALSE, FALSE);
    o->known = strcmp(svp.plname,"FakeOffering") != 0; o->dknown = 1;
    (void) addinv(o);
    o = mksobj(CORPSE, FALSE, FALSE);
    set_corpsenm(o, PM_LICHEN); o->age = svm.moves;
    o->dknown = 1; place_object(o, u.ux, u.uy);
    newsym(u.ux, u.uy); vision_recalc(0); update_inventory();
}
