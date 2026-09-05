#include "affordance.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
#include <time.h>
int main(void) {
    nnh_knowledge k = {0}; nnh_cell_actions c; mj_Buf b;
    int i; clock_t start;
    k.ordinary_locomotion = k.direction_reliable = k.door_diagonals = 1;
    k.have_origin = k.supported = 1; k.origin_x = 1; k.origin_y = 0; k.gate = "ready";
    for(i=0;i<81;i++) { k.cells[i].terrain=T_FLOOR; k.cells[i].in_bounds=1; k.cells[i].visible=1; }
    k.cells[31].terrain = T_DOOR_CLOSED;
    nnh_resolve_cell(&k,31,&c); assert(c.walkable == -1); assert(!c.restriction); assert(!strcmp(c.intent,"attemptOpen"));
    /* No raw lock/trap/disguise state exists in this input: indistinguishable
       closed doors have exactly one representation and one serialized result. */
    k.cells[31].lock=1; nnh_resolve_cell(&k,31,&c); assert(c.walkable==0); assert(!strcmp(c.restriction,"lockedDoor"));
    k.cells[31].lock=2; nnh_resolve_cell(&k,31,&c); assert(c.walkable==1);
    k.cells[32].terrain=T_DOOR_OPEN; nnh_resolve_cell(&k,32,&c); assert(c.walkable==1); assert(!strcmp(c.restriction,"intactDoorDiagonal"));
    k.cells[41].occupant=2; nnh_resolve_cell(&k,41,&c); assert(c.walkable==1); assert(!strcmp(c.intent,"creatureBump"));
    k.cells[41].occupant=3; nnh_resolve_cell(&k,41,&c); assert(!strcmp(c.intent,"allyBump"));
    k.cells[41].occupant=0; k.cells[41].boulder=1; nnh_resolve_cell(&k,41,&c); assert(!strcmp(c.intent,"possiblePush"));
    k.cells[41].terrain=T_WATER; nnh_resolve_cell(&k,41,&c); assert(c.walkable==-1);
    k.cells[41].terrain=T_LAVA; nnh_resolve_cell(&k,41,&c); assert(c.walkable==-1);
    k.ordinary_locomotion=0; nnh_resolve_cell(&k,32,&c); assert(c.walkable==-1); assert(!c.restriction); k.ordinary_locomotion=1;
    k.direction_reliable=0; nnh_resolve_cell(&k,32,&c); assert(!strcmp(c.intent,"unknown")); assert(!c.restriction);
    k.cells[0].in_bounds=0; nnh_resolve_cell(&k,0,&c); assert(c.walkable==0 && c.action_count==0);
    mj_init(&b); nnh_emit_cell_actions(&c,&b); assert(!strstr(b.buf,"terrain")); mj_free(&b);
    k.cells[4].terrain=T_DOOR_CLOSED; nnh_resolve_cell(&k,4,&c);
    for(i=0;i<c.action_count;i++) { assert(!strcmp(c.actions[i].availability,"outOfReach")); assert(!c.actions[i].arguments); }
    k.inventory_current=1; k.tools=0; nnh_resolve_cell(&k,40,&c); assert(!strcmp(c.actions[c.action_count-1].availability,"knownBlocked"));
    start=clock(); for(i=0;i<100000;i++) { nnh_resolve_cell(&k,i%81,&c); }
    printf("100000 pure cell resolutions: %.2f ms\n", 1000.0*(clock()-start)/CLOCKS_PER_SEC);
    return 0;
}
