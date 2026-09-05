/* Included only in a separately compiled temporary test engine. Never included
 * by the release engine. Mutations last for one perception call, with no gameplay
 * or RNG between begin/end. The baseline and variant expose the same glyphs. */
static struct rm fixture_terrain[COLNO][ROWNO];
static struct monst *fixture_monsters[COLNO][ROWNO];
static struct monst fixture_mimic;
static struct obj *fixture_item;
static unsigned fixture_cursed, fixture_blessed, fixture_bknown;
static long fixture_resistance;
static long fixture_hallucination;
static void fixture_begin(void)
{
    int x, y, doors = 0, walls = 0, unseen = 0;
    const char *variant = getenv("NNH_HIDDEN_VARIANT"), *report = getenv("NNH_HIDDEN_REPORT");
    struct obj *o;
    if (!variant || !isok(u.ux,u.uy)) return;
    memcpy(fixture_terrain, levl, sizeof fixture_terrain);
    memcpy(fixture_monsters, svl.level.monsters, sizeof fixture_monsters);
    fixture_resistance = HFire_resistance;
    fixture_hallucination = HHallucination;
    if (!strcmp(variant,"hallucination")) HHallucination = 1L;
    memset(&fixture_mimic, 0, sizeof fixture_mimic);
    fixture_mimic.data = &mons[PM_SMALL_MIMIC];
    fixture_mimic.m_ap_type = M_AP_FURNITURE; fixture_mimic.mappearance = S_hcdoor;
    for (x = 1; x < COLNO; x++) for (y = 0; y < ROWNO; y++) {
        if (IS_DOOR(levl[x][y].typ) && (levl[x][y].doormask & (D_CLOSED | D_LOCKED))) {
            doors++;
            if (!strcmp(variant,"lock")) levl[x][y].doormask = (levl[x][y].doormask & D_TRAPPED) | ((levl[x][y].doormask & D_LOCKED) ? D_CLOSED : D_LOCKED);
            if (!strcmp(variant,"trap")) levl[x][y].doormask ^= D_TRAPPED;
            if (!strcmp(variant,"mimic")) { levl[x][y].typ = ROOM; svl.level.monsters[x][y] = &fixture_mimic; }
        }
        if (IS_WALL(levl[x][y].typ)) { walls++; if (!strcmp(variant,"secret")) levl[x][y].typ = SDOOR; }
        if (!cansee(x,y) && svl.level.monsters[x][y]) {
            unseen++; if (!strcmp(variant,"monster")) svl.level.monsters[x][y] = NULL;
        }
    }
    fixture_item = NULL;
    for (o = gi.invent; o; o = o->nobj) if (o->oclass == TOOL_CLASS) { fixture_item = o; break; }
    if (fixture_item) {
        fixture_cursed = fixture_item->cursed; fixture_blessed = fixture_item->blessed; fixture_bknown = fixture_item->bknown;
        /* Both fixtures have the same unknown beatitude. */
        fixture_item->bknown = 0;
        if (!strcmp(variant,"curse")) { fixture_item->blessed=0; fixture_item->cursed=!fixture_cursed; }
    }
    if (!strcmp(variant,"property")) HFire_resistance ^= FROMOUTSIDE;
    if (report) {
        FILE *f = fopen(report,"w");
        if (f) { fprintf(f,"%d %d %d %d\n",doors,walls,unseen,fixture_item != NULL); fclose(f); }
    }
}
static void fixture_end(void)
{
    if (!getenv("NNH_HIDDEN_VARIANT") || !isok(u.ux,u.uy)) return;
    memcpy(levl, fixture_terrain, sizeof fixture_terrain);
    memcpy(svl.level.monsters, fixture_monsters, sizeof fixture_monsters);
    HFire_resistance = fixture_resistance;
    HHallucination = fixture_hallucination;
    if (fixture_item) { fixture_item->cursed=fixture_cursed;fixture_item->blessed=fixture_blessed;fixture_item->bknown=fixture_bknown; }
}
