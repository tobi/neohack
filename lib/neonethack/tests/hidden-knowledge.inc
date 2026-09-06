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
    int x, y, doors = 0, walls = 0, unseen = 0, unseen_floor = 0;
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
        if (!cansee(x,y) && levl[x][y].typ == ROOM) {
            unseen_floor++;
            if (!strcmp(variant,"background")) levl[x][y].typ = POOL;
        }
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
    /* Visible attitude scenarios intentionally change disclosed facts. */
    if (!strcmp(variant,"peaceful") || !strcmp(variant,"hostile")) {
        for (x = 1; x < COLNO; x++) for (y = 0; y < ROWNO; y++) {
            struct monst *m = m_at(x,y);
            if (m && cansee(x,y) && canspotmon(m) && !m->mundetected && m->m_ap_type == M_AP_NOTHING) {
                m->mtame = 0;
                m->mpeaceful = !strcmp(variant,"peaceful");
                newsym(x,y);
            }
        }
    }
    if (!strcmp(variant,"monster")) {
        struct monst *undisclosed = NULL;
        int old_x = -1, old_y = -1;
        for (x = 1; x < COLNO && !undisclosed; x++) for (y = 0; y < ROWNO; y++)
            if (!cansee(x,y) && fixture_monsters[x][y]) {
                undisclosed = fixture_monsters[x][y]; old_x = x; old_y = y; break;
            }
        for (x = 1; x < COLNO && undisclosed; x++) for (y = 0; y < ROWNO; y++)
            if (!cansee(x,y) && (x != old_x || y != old_y)) {
                svl.level.monsters[x][y] = undisclosed; undisclosed = NULL; break;
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
    /* Exercise the real display renderer and headless callback with a known
     * displayed glyph. This is a perception fixture, not a monster oracle or
     * a production input operation. Sensed glyphs deliberately lack sight. */
    if (!strncmp(variant, "display-", 8)) {
        int chosen = 0, sensed = !strcmp(variant, "display-sensed");
        for (y = u.uy - 4; y <= u.uy + 4 && !chosen; y++)
            for (x = u.ux - 4; x <= u.ux + 4 && !chosen; x++)
                if (isok(x,y) && (x != u.ux || y != u.uy)
                    && (!!cansee(x,y) != sensed)) {
                    glyph_info displayed;
                    int glyph = !strcmp(variant, "display-invisible") ? GLYPH_INVISIBLE
                        : !strcmp(variant, "display-clear") && svm.moves > 1 ? GLYPH_UNEXPLORED
                        : !strcmp(variant, "display-disguise") ? cmap_to_glyph(S_hcdoor)
                        : !strcmp(variant, "display-boulder") ? objnum_to_glyph(BOULDER)
                        : !strcmp(variant, "display-trap") ? cmap_to_glyph(S_arrow_trap)
                        : sensed ? GLYPH_DETECT_MALE_OFF : 0;
                    memset(&displayed, 0, sizeof displayed);
                    map_glyphinfo(x, y, glyph, 0, &displayed);
                    headless_print_glyph(hl_map_win, x, y, &displayed, NULL);
                    chosen = 1;
                }
    }
    if (report) {
        FILE *f = fopen(report,"w");
        if (f) { fprintf(f,"%d %d %d %d %d\n",doors,walls,unseen,fixture_item != NULL,unseen_floor); fclose(f); }
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
