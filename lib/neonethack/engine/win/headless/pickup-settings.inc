/* neonethack, 2026-09-06. Structured automatic ground pickup settings.
 * NetHack NGPL; see CHANGES.neonethack.md and dat/license. */
static const struct { const char *name; int oclass; } hl_pickup_classes[] = {
    {"gold", COIN_CLASS}, {"food", FOOD_CLASS}, {"potions", POTION_CLASS},
    {"scrolls", SCROLL_CLASS}, {"weapons", WEAPON_CLASS}, {"armor", ARMOR_CLASS},
    {"rings", RING_CLASS}, {"amulets", AMULET_CLASS}, {"tools", TOOL_CLASS},
    {"spellbooks", SPBOOK_CLASS}, {"wands", WAND_CLASS}, {"gems", GEM_CLASS},
    {"rocks", ROCK_CLASS}, {"balls", BALL_CLASS}, {"chains", CHAIN_CLASS}
};
static struct {
    boolean enabled, arrows, leave_corpses, leave_cursed;
    unsigned types;
} hl_pickup = { FALSE, TRUE, TRUE, TRUE, 1U };
static boolean hl_pickup_review, hl_pickup_review_present;
boolean headless_pickup_review(void) { return hl_pickup_review; }
static char hl_pickup_patterns[2][16][65];
static int hl_pickup_pattern_count[2], hl_pickup_pattern_present[2];

/* Literal matching shares NetHack's perceived, singular description. Never use
 * object type identities or undisclosed beatitude for name-based selection. */
boolean
headless_pickup_matches(struct obj *obj, boolean ignore)
{
    int i, kind = ignore ? 1 : 0;
    char *label;
    if (!hl_pickup_pattern_count[kind]) return FALSE;
    label = makesingular(doname(obj));
    for (i = 0; i < hl_pickup_pattern_count[kind]; i++)
        if (strstri(label, hl_pickup_patterns[kind][i])) return TRUE;
    return FALSE;
}

static boolean
hl_pickup_configure(const char *json)
{
    int enabled, arrows, corpses, cursed, ok, i, n = 0;
    unsigned types = 0;
    const char *p;
    char *name;
    char patterns[2][16][65] = {{{0}}};
    int count[2] = {0, 0}, present[2] = {0, 0}, kind, review = 0, review_present;
    if (json) {
        enabled = j_parse_bool(j_find_key(json, "enabled"), &ok); if (!ok) return FALSE;
        arrows = j_parse_bool(j_find_key(json, "arrows"), &ok); if (!ok) return FALSE;
        corpses = j_parse_bool(j_find_key(json, "leaveCorpses"), &ok); if (!ok) return FALSE;
        cursed = j_parse_bool(j_find_key(json, "leaveKnownCursed"), &ok); if (!ok) return FALSE;
        p = j_find_key(json, "review"); review_present = (p != 0);
        if (p) { review = j_parse_bool(p, &ok); if (!ok) return FALSE; }
        p = j_find_key(json, "itemTypes");
        if (!p || *p++ != '[') return FALSE;
        for (;;) {
            p += strspn(p, " \t\r\n");
            if (*p == ']') break;
            name = j_parse_str(p, &ok);
            if (!ok || !name) { free(name); return FALSE; }
            for (i = 0; i < SIZE(hl_pickup_classes); i++)
                if (!strcmp(name, hl_pickup_classes[i].name)) break;
            free(name);
            if (i == SIZE(hl_pickup_classes) || (types & (1U << i))) return FALSE;
            types |= 1U << i;
            /* Skip the complete quoted JSON string, including escaped quotes. */
            for (p++; *p && *p != '"'; p++) if (*p == '\\' && p[1]) p++;
            if (!*p) return FALSE;
            p++; p += strspn(p, " \t\r\n");
            if (*p == ']') break;
            if (*p++ != ',') return FALSE;
        }
        for (kind = 0; kind < 2; kind++) {
            p = j_find_key(json, kind ? "ignorePatterns" : "lootPatterns");
            if (!p) continue;
            present[kind] = 1;
            if (*p++ != '[') return FALSE;
            for (;;) {
                p += strspn(p, " \t\r\n");
                if (*p == ']') break;
                name = j_parse_str(p, &ok);
                if (!ok || !name || !*name || strlen(name) > 64 || count[kind] >= 16) { free(name); return FALSE; }
                Strcpy(patterns[kind][count[kind]++], name); free(name);
                for (p++; *p && *p != '"'; p++) if (*p == '\\' && p[1]) p++;
                if (!*p) return FALSE;
                p++; p += strspn(p, " \t\r\n");
                if (*p == ']') break;
                if (*p++ != ',') return FALSE;
            }
        }
        memcpy(hl_pickup_patterns, patterns, sizeof patterns);
        memcpy(hl_pickup_pattern_count, count, sizeof count);
        memcpy(hl_pickup_pattern_present, present, sizeof present);
        hl_pickup_review = review; hl_pickup_review_present = review_present;
        hl_pickup.enabled = enabled;
        hl_pickup.arrows = arrows;
        hl_pickup.leave_corpses = corpses;
        hl_pickup.leave_cursed = cursed;
        hl_pickup.types = types;
    }
    flags.pickup = hl_pickup.enabled;
    flags.autoquiver = FALSE; iflags.fireassist = FALSE; /* explicit weapon/ammunition choices */
    for (i = 0; i < SIZE(hl_pickup_classes); i++)
        if (hl_pickup.types & (1U << i)) flags.pickup_types[n++] = hl_pickup_classes[i].oclass;
    /* An empty NetHack type string means ALL. VENOM is the deliberate no-floor-
     * item sentinel, so only enabled inclusion exceptions can match. */
    if (!n) flags.pickup_types[n++] = VENOM_CLASS;
    flags.pickup_types[n] = '\0';
    /* All recovered/dropped objects follow the same visible filters. No hidden
     * early-return recovery override may defeat the advertised exclusions. */
    flags.pickup_thrown = flags.pickup_stolen = flags.nopick_dropped = FALSE;
    free_autopickup_exceptions();
    /* Both builds pin posixregex. Insertion PREPENDS and matching uses FIRST,
     * so install inclusion first, exclusions last. Only perceived naming is used. */
    if ((hl_pickup.arrows && !add_autopickup_exception("\"<(^| )arrow( named .*)?$\""))
        || (hl_pickup.leave_corpses && !add_autopickup_exception("\"> corpse( named .*)?$\""))
        || (hl_pickup.leave_cursed && !add_autopickup_exception("\">^(an? |the |[0-9]+ )?cursed \"")))
        panic("cannot compile automatic pickup rules");
    return TRUE;
}

static void
hl_emit_pickup(JBuf *jb)
{
    int i, kind;
    jb_key(jb, "automaticPickup"); jb_begin_obj(jb);
    jb_key(jb, "enabled"); jb_bool(jb, hl_pickup.enabled);
    jb_key(jb, "itemTypes"); jb_begin_arr(jb);
    for (i = 0; i < SIZE(hl_pickup_classes); i++)
        if (hl_pickup.types & (1U << i)) { jb_sep(jb); jb_str(jb, hl_pickup_classes[i].name); }
    jb_end_arr(jb);
    for (kind = 0; kind < 2; kind++) if (hl_pickup_pattern_present[kind]) {
        jb_key(jb, kind ? "ignorePatterns" : "lootPatterns"); jb_begin_arr(jb);
        for (i = 0; i < hl_pickup_pattern_count[kind]; i++) { jb_sep(jb); jb_str(jb, hl_pickup_patterns[kind][i]); }
        jb_end_arr(jb);
    }
    if (hl_pickup_review_present) { jb_key(jb, "review"); jb_bool(jb, hl_pickup_review); }
    jb_key(jb, "arrows"); jb_bool(jb, hl_pickup.arrows);
    jb_key(jb, "leaveCorpses"); jb_bool(jb, hl_pickup.leave_corpses);
    jb_key(jb, "leaveKnownCursed"); jb_bool(jb, hl_pickup.leave_cursed);
    jb_end_obj(jb);
}
