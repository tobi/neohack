/* Temporary fresh-world fixture only. The known charged wand is disclosed
 * through ordinary inventory; zap, wishing text and costs use real engine code. */
static void text_fixture_prepare(void)
{
    static int prepared;
    struct obj *wand;
    if (prepared || !isok(u.ux,u.uy)) return;
    prepared = 1;
    wand = mksobj(WAN_WISHING, TRUE, FALSE);
    if (!wand) panic("No wand for text-decision fixture");
    wand->spe = 1;
    wand->blessed = wand->cursed = 0;
    wand->known = wand->dknown = wand->bknown = 1;
    makeknown(WAN_WISHING);
    (void) addinv(wand);
}
