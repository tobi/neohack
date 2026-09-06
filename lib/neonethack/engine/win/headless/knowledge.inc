/* Only the ordinary hero-facing menus' facts. Never use raw spell memory,
 * practice counters, current monster state, hunger values or prayer timers. */
static void hl_knowledge(JBuf *jb)
{
    int i, id, level, failure, advancement;
    const char *name, *category;
    char retention[24], ref[48];
    mapseen *ms;
    jb_key(jb, "knowledge"); jb_begin_obj(jb);
    jb_key(jb, "observedTurn"); jb_int(jb, svm.moves);
    jb_key(jb, "spells"); jb_begin_arr(jb);
    for (i = 0; (id = headless_spell_info(i, &name, &level, &category, &failure, retention)) != 0; i++) {
        jb_sep(jb); jb_begin_obj(jb);
        Sprintf(ref, "spell-%d", id);
        jb_key(jb, "id"); jb_str(jb, ref);
        jb_key(jb, "name"); jb_str(jb, name);
        jb_key(jb, "level"); jb_int(jb, level);
        jb_key(jb, "category"); jb_str(jb, category);
        jb_key(jb, "failurePercent"); jb_int(jb, failure);
        jb_key(jb, "retention"); jb_str(jb, retention);
        jb_end_obj(jb);
    }
    jb_end_arr(jb);
    jb_key(jb, "skills"); jb_begin_arr(jb);
    for (i = 0; i < P_NUM_SKILLS; i++) if (headless_skill_info(i, &name, &category, &advancement)) {
        jb_sep(jb); jb_begin_obj(jb);
        Sprintf(ref, "skill-%d", i);
        jb_key(jb, "id"); jb_str(jb, ref);
        jb_key(jb, "name"); jb_str(jb, name);
        jb_key(jb, "level"); jb_str(jb, category);
        jb_key(jb, "advancement"); jb_str(jb, advancement == 1 ? "available" : advancement == 2 ? "needsExperience" : advancement == 3 ? "peaked" : "practice");
        jb_end_obj(jb);
    }
    jb_end_arr(jb);
    jb_key(jb, "levels"); jb_begin_arr(jb);
    for (ms = svm.mapseenchn; ms; ms = ms->next) {
        if (ms->flags.forgot) continue;
        jb_sep(jb); jb_begin_obj(jb);
        Sprintf(ref, "level-%d-%d", ms->lev.dnum, ms->lev.dlevel);
        jb_key(jb, "id"); jb_str(jb, ref);
        jb_key(jb, "branch"); jb_str(jb, svd.dungeons[ms->lev.dnum].dname);
        jb_key(jb, "depth"); jb_int(jb, depth(&ms->lev));
        jb_key(jb, "freshness"); jb_str(jb, "remembered");
        if (ms->custom) { jb_key(jb, "annotation"); jb_str(jb, ms->custom); }
        jb_key(jb, "features"); jb_begin_obj(jb);
#define KNOWN_FEATURE(key, member) jb_key(jb, key); jb_int(jb, ms->feat.member)
        KNOWN_FEATURE("fountains", nfount); KNOWN_FEATURE("sinks", nsink);
        KNOWN_FEATURE("altars", naltar); KNOWN_FEATURE("thrones", nthrone);
        KNOWN_FEATURE("shops", nshop); KNOWN_FEATURE("temples", ntemple);
#undef KNOWN_FEATURE
        jb_end_obj(jb); jb_end_obj(jb);
    }
    jb_end_arr(jb);
    jb_key(jb, "conduct"); jb_begin_obj(jb);
#define CONDUCT(key, field) jb_key(jb, key); jb_int(jb, u.uconduct.field)
    CONDUCT("food", food); CONDUCT("unvegan", unvegan); CONDUCT("unvegetarian", unvegetarian);
    CONDUCT("gnostic", gnostic); CONDUCT("weaponHits", weaphit); CONDUCT("kills", killer);
    CONDUCT("literacy", literate); CONDUCT("objectPolymorphs", polypiles); CONDUCT("selfPolymorphs", polyselfs);
    CONDUCT("wishes", wishes); CONDUCT("artifactWishes", wisharti); CONDUCT("sokobanViolations", sokocheat);
    CONDUCT("pets", pets);
#undef CONDUCT
    jb_end_obj(jb);
    jb_key(jb, "achievements"); jb_begin_arr(jb);
    for (i = 0; i < N_ACH && u.uachieved[i]; i++) {
        id = u.uachieved[i];
        if (!(name = headless_achievement_name(id)) || !*name) continue;
        jb_sep(jb); jb_begin_obj(jb);
        Sprintf(ref, "achievement-%d", abs(id));
        jb_key(jb, "id"); jb_str(jb, ref);
        jb_key(jb, "name"); jb_str(jb, name);
        jb_end_obj(jb);
    }
    jb_end_arr(jb); jb_end_obj(jb);
}

static void hl_known_properties(JBuf *jb, struct obj *o)
{
    jb_key(jb, "known"); jb_begin_obj(jb);
    if (!Hallucination) {
        if (o->dknown) {
            const char *appearance = OBJ_DESCR(objects[o->otyp]);
            /* Shuffled descriptions are perceived; true names are only safe
             * when this object type has no unidentified appearance. */
            jb_key(jb, "appearance");
            jb_str(jb, appearance ? appearance : OBJ_NAME(objects[o->otyp]));
        }
        if (o->dknown && objects[o->otyp].oc_name_known) {
            jb_key(jb, "identity"); jb_str(jb, OBJ_NAME(objects[o->otyp]));
        }
        if (o->bknown) {
            jb_key(jb, "beatitude"); jb_str(jb, o->cursed ? "cursed" : o->blessed ? "blessed" : "uncursed");
        }
        if (o->dknown && o->known) {
            if (o->oclass == WAND_CLASS || (o->oclass == TOOL_CLASS && objects[o->otyp].oc_charged)) {
                jb_key(jb, "charges"); jb_int(jb, o->spe);
                jb_key(jb, "recharges"); jb_int(jb, o->recharged);
            } else if (o->oclass == WEAPON_CLASS || o->oclass == ARMOR_CLASS ||
                       (o->oclass == RING_CLASS && objects[o->otyp].oc_charged)) {
                jb_key(jb, "enchantment"); jb_int(jb, o->spe);
            }
        }
        if (o->rknown) { jb_key(jb, "erosionProof"); jb_bool(jb, o->oerodeproof); }
    }
    jb_end_obj(jb);
}
