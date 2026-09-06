/* Test engines only: establish real objects before the first command prompt.
 * Production builds never include this file. All subsequent interaction uses
 * the normal C API and actual pickup/container rules. */
void pickup_fixture(void)
{
    static boolean prepared = FALSE;
    struct obj *o, *box;
    struct monst *mon, *nextmon;
    int i, x, y;
    static const struct { int type; const char *name; int cursed, known, lost; } cases[] = {
        { ARROW, "ordinary-arrow", 0, 1, LOST_NONE },
        { ARROW, "known-curse", 1, 1, LOST_NONE },
        { ARROW, "hidden-curse", 1, 0, LOST_NONE },
        { ARROW, "thrown-curse", 1, 1, LOST_THROWN },
        { ARROW, "stolen-curse", 1, 1, LOST_STOLEN },
        { DAGGER, "thrown-dagger", 0, 1, LOST_THROWN },
        { DAGGER, "stolen-dagger", 0, 1, LOST_STOLEN },
        { CORPSE, "test-corpse", 0, 1, LOST_NONE },
        { FOOD_RATION, "test-food", 0, 1, LOST_NONE },
        { GOLD_PIECE, "test-gold", 0, 1, LOST_NONE },
        { POT_HEALING, "test-potion", 0, 0, LOST_NONE }
    };
    if (prepared || !isok(u.ux, u.uy)) return;
    prepared = TRUE;
    for (mon = fmon; mon; mon = nextmon) {
        nextmon = mon->nmon; mongone(mon); /* no pet may eat the fixture corpse */
    }
    x = u.ux + 1; y = u.uy;
    if (!isok(x + 1, y)) panic("pickup test start too close to map edge");
    levl[x][y].typ = levl[x + 1][y].typ = ROOM;
    levl[x][y].lit = levl[x + 1][y].lit = 1;
    for (i = 0; i < SIZE(cases); i++) {
        o = mksobj(cases[i].type, FALSE, FALSE);
        o->quan = 1; o->spe = 0; o->cursed = cases[i].cursed;
        o->blessed = 0; o->bknown = cases[i].known; o->dknown = 1;
        o->how_lost = cases[i].lost;
        if (o->otyp == CORPSE) set_corpsenm(o, PM_NEWT);
        o = oname(o, cases[i].name, ONAME_NO_FLAGS);
        o->owt = weight(o); place_object(o, x, y);
    }
    /* Same-type stacks exercise taking/putting when addinv merges them. */
    o = mksobj(FOOD_RATION, FALSE, FALSE);
    o->quan = 5; o->blessed = o->cursed = 0; o->bknown = o->dknown = 1;
    o = oname(o, "transfer-rations", ONAME_NO_FLAGS);
    o->owt = weight(o); (void) addinv(o);
    box = mksobj(CHEST, FALSE, FALSE);
    box->olocked = box->otrapped = 0; box->dknown = 1;
    box = oname(box, "transfer-box", ONAME_NO_FLAGS);
    o = mksobj(FOOD_RATION, FALSE, FALSE);
    o->quan = 3; o->blessed = o->cursed = 0; o->bknown = o->dknown = 1;
    o = oname(o, "transfer-rations", ONAME_NO_FLAGS);
    o->owt = weight(o); add_to_container(box, o); box->owt = weight(box);
    place_object(box, u.ux, u.uy);
    o = mksobj(ARROW, FALSE, FALSE);
    o->quan = 1; o->spe = 0; o->blessed = o->cursed = 0;
    o = oname(o, "initial-arrow", ONAME_NO_FLAGS); o->owt = weight(o);
    place_object(o, u.ux, u.uy);
    o = mksobj(GOLD_PIECE, FALSE, FALSE); o->quan = 7; o->owt = weight(o);
    place_object(o, u.ux, u.uy);
    o = mksobj(LONG_SWORD, FALSE, FALSE);
    o->quan = 40; o->blessed = o->cursed = 0; o->bknown = o->dknown = 1;
    o = oname(o, "heavy-swords", ONAME_NO_FLAGS); o->owt = weight(o);
    place_object(o, x + 1, y);
    newsym(u.ux, u.uy); newsym(x, y); newsym(x + 1, y);
    vision_recalc(0); update_inventory();
}
