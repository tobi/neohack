/* Temporary test engines only. Each fresh world gets one disclosed target;
 * subsequent warnings, answers, costs and replay use ordinary engine logic. */
static void warning_fixture_prepare(void)
{
    static int prepared;
    int dx, dy, trap = !strcmp(svp.plname, "WarningTrap");
    if (prepared || !isok(u.ux,u.uy)
        || (!trap && strcmp(svp.plname, "WarningPeaceful"))) return;
    prepared = 1;
    for (dy = -1; dy <= 1; dy++) for (dx = -1; dx <= 1; dx++) {
        int x = u.ux + dx, y = u.uy + dy;
        if ((!dx && !dy) || !isok(x,y) || !cansee(x,y)
            || levl[x][y].typ != ROOM || m_at(x,y) || t_at(x,y)
            || svl.level.objects[x][y]) continue;
        if (trap) {
            struct trap *known = maketrap(x,y,SQKY_BOARD);
            if (!known) panic("No trap in warning fixture");
            known->tseen = 1;
            flags.paranoia_bits |= PARANOID_TRAP;
            flags.paranoia_bits &= ~PARANOID_CONFIRM;
        } else {
            struct monst *peaceful = makemon(&mons[PM_GRID_BUG],x,y,NO_MM_FLAGS);
            if (!peaceful) panic("No peaceful creature in warning fixture");
            peaceful->mpeaceful = 1;
            peaceful->mtame = 0;
            peaceful->msleeping = 1;
            set_malign(peaceful);
            flags.confirm = 1;
            flags.safe_dog = 0; /* ordinary attack-confirmation option, test only */
            flags.paranoia_bits &= ~PARANOID_HIT;
        }
        newsym(x,y); flush_screen(1);
        return;
    }
    panic("No disclosed adjacent square for warning fixture");
}
