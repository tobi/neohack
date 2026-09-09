#include "affordance.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
#include <time.h>
#include <stdlib.h>
static void routes(void) {
    nnh_known_cell *map = calloc(NNH_MAP_CELLS, sizeof *map);
    nnh_knowledge k = {0};
    int steps[NNH_MAP_CELLS], a = 5 * NNH_MAP_WIDTH + 5, i;
    assert(map);
    k.have_origin = k.ordinary_locomotion = k.direction_reliable = k.door_diagonals = 1;
    k.origin_x = 5; k.origin_y = 5;
    for (i = 0; i < 4; i++) { map[a+i].in_bounds = 1; map[a+i].terrain = T_FLOOR; }
    assert(nnh_known_route(&k, map, a, steps) == 0);
    assert(nnh_known_route(&k, map, a+3, steps) == 3);
    assert(steps[0] == a+1 && steps[2] == a+3);
    map[a+1].trap = 1; assert(nnh_known_route(&k,map,a+3,steps) == -1); map[a+1].trap = 0;
    map[a+1].boulder = 1; assert(nnh_known_route(&k,map,a+3,steps) == -1); map[a+1].boulder = 0;
    map[a+1].occupant = 3; assert(nnh_known_route(&k,map,a+3,steps) == -1); map[a+1].occupant = 0;
    map[a+1].terrain = T_DOOR_CLOSED; map[a+1].lock = 2;
    assert(nnh_known_route(&k,map,a+3,steps) == -1); /* Open is an explicit operation. */
    map[a+1].terrain = T_DOOR_OPEN; assert(nnh_known_route(&k,map,a+3,steps) == 3);
    map[a+1].terrain = T_UNKNOWN; assert(nnh_known_route(&k,map,a+3,steps) == -1);
    map[a+1].terrain = T_FLOOR;
    k.direction_reliable = 0; assert(nnh_known_route(&k,map,a+3,steps) == -1); k.direction_reliable = 1;
    /* Known tight diagonal: a squeeze might succeed, but this planner declines. */
    map[a+1].terrain = T_WALL; map[a+NNH_MAP_WIDTH] = map[a+1];
    map[a+NNH_MAP_WIDTH+1] = map[a];
    assert(nnh_known_route(&k,map,a+NNH_MAP_WIDTH+1,steps) == -1);
    map[a+1].terrain = T_FLOOR;
    assert(nnh_known_route(&k,map,a+NNH_MAP_WIDTH+1,steps) == 1);
    map[a+1].boulder = 1;
    assert(nnh_known_route(&k,map,a+NNH_MAP_WIDTH+1,steps) == -1);
    map[a+1].boulder = 0;
    map[a].terrain = T_DOOR_OPEN;
    assert(nnh_known_route(&k,map,a+NNH_MAP_WIDTH+1,steps) == 2);
    free(map);
    nnh_known_cell cell = {0};
    assert(!strcmp(nnh_known_block(&cell), "disconnected"));
    cell.in_bounds = 1; cell.terrain = T_UNKNOWN; assert(!strcmp(nnh_known_block(&cell), "targetUnknown"));
    cell.terrain = T_DARK; assert(!strcmp(nnh_known_block(&cell), "targetUnknown"));
    cell.terrain = T_FLOOR; cell.occupant = 2; assert(!strcmp(nnh_known_block(&cell), "targetOccupied"));
    cell.occupant = 3; assert(!strcmp(nnh_known_block(&cell), "targetOccupied"));
    cell.occupant = 0; cell.terrain = T_DOOR_CLOSED; assert(!strcmp(nnh_known_block(&cell), "closedDoor"));
    cell.terrain = T_WALL; assert(!strcmp(nnh_known_block(&cell), "disconnected"));
}
int main(void) {
    nnh_knowledge k = {0}; nnh_cell_actions c; mj_Buf b;
    int i; clock_t start;
    routes();
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
    k.cells[32].terrain=T_FLOOR; k.cells[31].terrain=k.cells[41].terrain=T_WALL;
    nnh_resolve_cell(&k,32,&c); assert(c.requires_squeeze); assert(!c.restriction); assert(c.walkable==1);
    k.cells[31].terrain=k.cells[41].terrain=T_FLOOR; k.cells[32].terrain=T_DOOR_OPEN;
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
