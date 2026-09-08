/* Compiled only into temporary scenario engines. */
static struct obj *manual_object(int type, const char *name, long quantity)
{
    struct obj *o = mksobj(type, FALSE, FALSE);
    o->quan = quantity; o->cursed = o->blessed = 0;
    o->known = o->dknown = o->bknown = 1;
    o = oname(o, name, ONAME_NO_FLAGS); o->owt = weight(o);
    return addinv(o);
}
void manual_fixture(void)
{
    static boolean prepared = FALSE;
    struct obj *o;
    struct monst *m, *next;
    int x, y;
    if (prepared || !isok(u.ux,u.uy)) return;
    prepared = TRUE;
    if (!strcmp(svp.plname,"ItemAppearance")) {
        (void)manual_object(SMALL_SHIELD,"icon-shield",1);
        (void)manual_object(MACE,"icon-mace",1);
        (void)manual_object(CHEST,"icon-chest",1);
        o=manual_object(GAUNTLETS_OF_POWER,"icon-gloves",1);
        objects[o->otyp].oc_name_known=0;
        /* A real shuffled glove description, independent of magic identity. */
        o->known=0;
    }
    for (m=fmon;m;m=next) { next=m->nmon; mongone(m); }
    u.ux=40;u.uy=10;
    for(x=34;x<=46;x++)for(y=4;y<=16;y++) {
        struct trap *trap=t_at(x,y);if(trap)deltrap(trap);
        levl[x][y].typ=ROOM;levl[x][y].lit=1;
    }
    if (!strncmp(svp.plname,"Run",3)) {
        for(x=34;x<=46;x++)for(y=4;y<=16;y++) {
            while (svl.level.objects[x][y]) delobj(svl.level.objects[x][y]);
        }
        levl[36][10].typ=STONE;
        if (!strcmp(svp.plname,"RunBranch")) {
            for(x=34;x<=46;x++)for(y=4;y<=16;y++) levl[x][y].typ=STONE;
            for(x=37;x<=41;x++) levl[x][10].typ=CORR;
            levl[38][9].typ=CORR;
        }
        if (!strcmp(svp.plname,"RunPickup")) {
            o=mksobj(GOLD_PIECE,FALSE,FALSE);o->quan=19;o->owt=weight(o);place_object(o,39,10);
        }
        if (!strcmp(svp.plname,"RunCreature")) {
            m=makemon(&mons[PM_LICHEN],u.ux-1,u.uy,NO_MM_FLAGS);
            m->mpeaceful=0;m->msleeping=1;
        }
    }
    ABASE(A_STR)=AMAX(A_STR)=18;
    ABASE(A_INT)=AMAX(A_INT)=18;
    u.uen=u.uenmax=200;u.uhp=u.uhpmax=200;
    o=manual_object(WAN_LIGHT,"warning-wand",1);o->spe=3;
    (void)manual_object(DAGGER,"selected-daggers",8);
    (void)manual_object(SHORT_SWORD,"other-weapon",1);
    (void)manual_object(POT_WATER,"water-stack",3);
    (void)manual_object(OIL_LAMP,"ordinary-lamp",1);
    (void)manual_object(SCR_BLANK_PAPER,"blank-paper",2);
    o=manual_object(MAGIC_MARKER,"writing-marker",1);o->spe=80;
    (void)manual_object(TOWEL,"wearable-towel",1);
    (void)manual_object(MEAT_RING,"wearable-meat",1);
    (void)manual_object(T_SHIRT,"readable-shirt",1);
    o=manual_object(WAN_FIRE,"unknown-wand",1);o->known=o->dknown=o->bknown=0;
    o->spe=!strcmp(svp.plname,"KnowledgeB")?99:2;
    o->cursed=!strcmp(svp.plname,"KnowledgeB");
    if (!strcmp(svp.plname,"KnowledgeA") || !strcmp(svp.plname,"KnowledgeB")) {
        u.ulevel=3;record_achievement(-ACH_RNK1);
    }
    P_SKILL(P_DAGGER)=P_BASIC;P_MAX_SKILL(P_DAGGER)=P_EXPERT;
    P_ADVANCE(P_DAGGER)=10000;u.weapon_slots=10;
    if (!strcmp(svp.plname,"EngraveInterrupted")) {
        m=makemon(&mons[PM_SEWER_RAT],u.ux+2,u.uy,NO_MM_FLAGS);
        m->mpeaceful=0;m->msleeping=0;
    }
    if (!strcmp(svp.plname,"Artifact")) {
        o=mksobj(LUCKSTONE,FALSE,FALSE);
        o=oname(o,"The Heart of Ahriman",ONAME_NO_FLAGS);
        o->known=o->dknown=o->bknown=1;o->cursed=o->blessed=0;
        (void)addinv(o);
    }
    if (!strcmp(svp.plname,"Ritual")) {
        u.uz = sanctum_level; u.uz.dlevel--;
        svi.inv_pos.x=u.ux;svi.inv_pos.y=u.uy;
        o=manual_object(CANDELABRUM_OF_INVOCATION,"ritual-candelabrum",1);o->spe=0;
        o=manual_object(WAX_CANDLE,"ritual-candles",7);o->age=400;
        o=manual_object(BELL_OF_OPENING,"ritual-bell",1);o->spe=3;o->age=-100;
        (void)manual_object(SPE_BOOK_OF_THE_DEAD,"ritual-book",1);
    }
    if (!strcmp(svp.plname,"Commerce") || !strcmp(svp.plname,"CommerceBill")) {
        struct eshk *eshk;
        for(x=34;x<=46;x++)for(y=4;y<=16;y++)levl[x][y].roomno=ROOMOFFSET;
        svr.rooms[0].rtype=SHOPBASE;svr.rooms[0].lx=34;svr.rooms[0].hx=46;
        svr.rooms[0].ly=4;svr.rooms[0].hy=16;
        u.ushops[0]=u.urooms[0]=ROOMOFFSET;u.ushops[1]=u.urooms[1]=0;
        m=makemon(&mons[PM_SHOPKEEPER],u.ux+1,u.uy,NO_MM_FLAGS);
        neweshk(m);m->isshk=1;m->mpeaceful=1;eshk=ESHK(m);
        eshk->shoproom=ROOMOFFSET;eshk->shoptype=SHOPBASE;eshk->shoplevel=u.uz;
        eshk->shk.x=m->mx;eshk->shk.y=m->my;eshk->bill_p=eshk->bill;
        Strcpy(eshk->customer,svp.plname);Strcpy(eshk->shknam,"Fixture Merchant");
        eshk->debit=25;
        (void)manual_object(GOLD_PIECE,"",1000);
        if (!strcmp(svp.plname,"CommerceBill")) {
            int i;
            eshk->debit=0;eshk->billct=2;
            for(i=0;i<2;i++) {
                o=manual_object(i ? DIAMOND : SCR_IDENTIFY,i ? "billed-gem" : "billed-scroll",1);
                o->unpaid=1;eshk->bill[i].bo_id=o->o_id;eshk->bill[i].bquan=1;
                eshk->bill[i].price=i ? 100 : 20;eshk->bill[i].useup=0;
            }
        }
    }
    if (!strcmp(svp.plname,"Diet")) (void)polymon(PM_RUST_MONSTER);
    if (!strcmp(svp.plname,"DuplicateSlots")) {
        /* Overflow inventory may share '#'. Labels and slots are not identity. */
        for(o=gi.invent;o;o=o->nobj) if(o->oclass==WAND_CLASS) o->invlet=NOINVSYM;
    }
    if (!strcmp(svp.plname,"EquipmentSlots")) {
        /* A real, layered worn set. Set placement through the engine's own
         * bookkeeping; subsequent removal/quiver/swap tests use public input. */
        for (o=gi.invent;o;o=o->nobj) if (o->owornmask) setnotworn(o);
        o=manual_object(LEATHER_ARMOR,"slot-body",1);setworn(o,W_ARM);
        o=manual_object(CLOAK_OF_MAGIC_RESISTANCE,"slot-cloak",1);setworn(o,W_ARMC);
        o=manual_object(HELMET,"slot-head",1);setworn(o,W_ARMH);
        o=manual_object(SMALL_SHIELD,"slot-shield",1);setworn(o,W_ARMS);
        o=manual_object(LEATHER_GLOVES,"slot-hands",1);setworn(o,W_ARMG);
        o=manual_object(LOW_BOOTS,"slot-feet",1);setworn(o,W_ARMF);
        o=manual_object(HAWAIIAN_SHIRT,"slot-shirt",1);setworn(o,W_ARMU);
        o=manual_object(AMULET_OF_LIFE_SAVING,"slot-neck",1);setworn(o,W_AMUL);
        o=manual_object(RIN_ADORNMENT,"slot-left",1);setworn(o,W_RINGL);
        o=manual_object(RIN_STEALTH,"slot-right",1);setworn(o,W_RINGR);
        o=manual_object(LENSES,"slot-eyes",1);setworn(o,W_TOOL);
        o=manual_object(DAGGER,"slot-weapon",1);setuwep(o);
        o=manual_object(SHORT_SWORD,"slot-alternate",1);setuswapwep(o);
        o=manual_object(DART,"slot-quiver",5);setuqwep(o);
    }
    if (!strncmp(svp.plname,"Art",3)) {
        const int subjects[] = { PM_HUMAN, PM_DOG, PM_HOUSECAT, PM_RAVEN, PM_PYTHON, PM_RED_DRAGON };
        int i;
        for(x=34;x<=46;x++)for(y=4;y<=16;y++) {
            while (svl.level.objects[x][y]) delobj(svl.level.objects[x][y]);
            unblock_point(x,y);
        }
        for (i=0;i<6;i++) {
            char name[32];
            Sprintf(name,"art-statue-%d",i);
            o=manual_object(STATUE,name,1);o->corpsenm=subjects[i];o->owt=weight(o);
            o=mksobj(STATUE,FALSE,FALSE);o->corpsenm=subjects[i];o->owt=weight(o);
            place_object(o,37+i,9);
        }
        o=mksobj(CROSSBOW_BOLT,FALSE,FALSE);place_object(o,40,11);
        o=mksobj(LONG_SWORD,FALSE,FALSE);place_object(o,41,11);
        /* Rendered disguise must remain an apparent sword, not a monster. */
        m=makemon(&mons[PM_SMALL_MIMIC],43,10,NO_MM_FLAGS);
        m->m_ap_type=M_AP_OBJECT;m->mappearance=LONG_SWORD;m->msleeping=1;
        if (!strcmp(svp.plname,"ArtHallucinated")) make_hallucinated(100L,FALSE,0L);
    }
    vision_recalc(0);docrt();update_inventory();disp.botl=TRUE;
}
