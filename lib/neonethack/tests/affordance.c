#include "affordance.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
#include <time.h>
#include <stdlib.h>
#include <limits.h>

/* Independent coordinate oracles: map rows have 80 storage slots but only
 * columns 1..79 are playable; local neighborhoods are 9x9, centered at 40. */
static void coordinate_lattice(void) {
    nnh_knowledge k = {0};
    nnh_cell_actions out;
    int x, y, dx, dy, index, checks = 0;
    k.supported = k.have_origin = k.ordinary_locomotion = k.direction_reliable = 1;
    k.gate = "ready";
    for (y = 0; y < 21; y++) for (x = 1; x < 80; x++) {
        k.origin_x = x; k.origin_y = y;
        for (dy = -4; dy <= 4; dy++) for (dx = -4; dx <= 4; dx++) {
            index = (dy + 4) * 9 + dx + 4;
            k.cells[index].in_bounds = x + dx >= 1 && x + dx <= 79 && y + dy >= 0 && y + dy <= 20;
            k.cells[index].terrain = T_FLOOR;
            k.cells[index].color = index; /* detect an x/y transpose */
        }
        for (dy = -4; dy <= 4; dy++) for (dx = -4; dx <= 4; dx++) {
            index = (dy + 4) * 9 + dx + 4;
            nnh_resolve_cell(&k, index, &out);
            assert(out.x == x + dx && out.y == y + dy);
            assert(out.dx == dx && out.dy == dy && out.known.color == index);
            if (!out.known.in_bounds) assert(out.action_count == 0 && out.walkable == 0);
            checks++;
        }
    }
    printf("%d neighborhood coordinate cases passed\n", checks);
}

static void route_coordinates(void) {
    static const int origins[][2] = {{1,0},{79,0},{1,20},{79,20},{9,9},{10,10},{40,10},{78,19}};
    static const int invalid[][2] = {{-1,1},{81,0},{0,1},{80,0},{1,-1},{1,21},{INT_MAX,INT_MAX},{INT_MIN,INT_MIN}};
    nnh_known_cell *map = calloc(NNH_MAP_CELLS, sizeof *map);
    nnh_knowledge k = {0};
    int parent[NNH_MAP_CELLS], steps[NNH_MAP_CELLS], x, y, i, n, p, distance;
    size_t origin;
    assert(map);
    k.have_origin = k.ordinary_locomotion = k.direction_reliable = 1;
    for (y = 0; y < 21; y++) for (x = 1; x < 80; x++) {
        map[y * 80 + x].in_bounds = 1;
        map[y * 80 + x].terrain = T_FLOOR;
    }
    for (origin = 0; origin < sizeof origins / sizeof origins[0]; origin++) {
        k.origin_x = origins[origin][0]; k.origin_y = origins[origin][1];
        int start = k.origin_y * 80 + k.origin_x;
        assert(nnh_known_paths(&k, map, parent) == start);
        for (y = 0; y < 21; y++) {
            assert(parent[y * 80] == -1); /* never route through reserved x=0 */
            for (x = 1; x < 80; x++) {
                p = y * 80 + x; distance = 0;
                while (p != start) {
                    int next = parent[p];
                    assert(next >= 0 && next < NNH_MAP_CELLS && next != p);
                    assert(abs(next % 80 - p % 80) <= 1 && abs(next / 80 - p / 80) <= 1);
                    assert(next % 80 >= 1); /* no row wrap */
                    p = next; assert(++distance < NNH_MAP_CELLS);
                }
                assert(distance == (abs(x-k.origin_x) > abs(y-k.origin_y) ? abs(x-k.origin_x) : abs(y-k.origin_y)));
            }
        }
        n = nnh_known_route(&k, map, (20-k.origin_y)*80 + 80-k.origin_x, steps);
        assert(n >= 0);
        p = start;
        for (i = 0; i < n; i++) {
            assert(abs(steps[i]%80-p%80) <= 1 && abs(steps[i]/80-p/80) <= 1);
            p = steps[i];
        }
        assert(p == (20-k.origin_y)*80 + 80-k.origin_x);
    }
    for (origin = 0; origin < sizeof invalid / sizeof invalid[0]; origin++) {
        k.origin_x = invalid[origin][0]; k.origin_y = invalid[origin][1];
        assert(nnh_known_paths(&k, map, parent) == -1);
    }
    free(map);
}
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
    /* A tame ally in a corridor is displaceable; any other occupant blocks. */
    map[a+1].occupant = 3; assert(nnh_known_route(&k,map,a+3,steps) == 3); assert(steps[0] == a+1);
    assert(nnh_known_route(&k,map,a+1,steps) == 1);
    map[a+1].occupant = 2; assert(nnh_known_route(&k,map,a+3,steps) == -1);
    assert(nnh_known_route(&k,map,a+1,steps) == -1); map[a+1].occupant = 0;
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
    cell.occupant = 3; assert(!strcmp(nnh_known_block(&cell), "disconnected"));
    cell.occupant = 0; cell.terrain = T_DOOR_CLOSED; assert(!strcmp(nnh_known_block(&cell), "closedDoor"));
    cell.terrain = T_WALL; assert(!strcmp(nnh_known_block(&cell), "disconnected"));
}
int main(void) {
    nnh_knowledge k = {0}; nnh_cell_actions c; mj_Buf b;
    int i; clock_t start;
    coordinate_lattice();
    route_coordinates();
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
    strcpy(k.cells[40].mark, "."); k.cells[40].occupant = k.cells[40].object = 0;
    nnh_resolve_cell(&k,40,&c);
    mj_init(&b); nnh_emit_cell_actions(&c,&b);
    { const char *t = strstr(b.buf, "\"terrain\":{"), *end = t ? strchr(t, '}') : 0, *m = t ? strstr(t, "\"mark\":\".\"") : 0;
      assert(t && end && m && m < end); }
    mj_free(&b);
    k.cells[40].occupant = 2; strcpy(k.cells[40].mark, "d");
    nnh_resolve_cell(&k,40,&c);
    mj_init(&b); nnh_emit_cell_actions(&c,&b);
    { const char *t = strstr(b.buf, "\"terrain\":{"), *end = t ? strchr(t, '}') : 0, *m = t ? strstr(t, "\"mark\"") : 0;
      assert(t && end && (!m || m > end)); assert(strstr(b.buf, "\"occupant\"")); }
    mj_free(&b);
    k.cells[40].occupant = 0; k.cells[40].object = 1; strcpy(k.cells[40].mark, "$");
    nnh_resolve_cell(&k,40,&c);
    mj_init(&b); nnh_emit_cell_actions(&c,&b);
    { const char *t = strstr(b.buf, "\"terrain\":{"), *end = t ? strchr(t, '}') : 0, *m = t ? strstr(t, "\"mark\"") : 0;
      assert(t && end && (!m || m > end)); }
    mj_free(&b);
    k.cells[40].object = 0; strcpy(k.cells[40].mark, ".");
    k.cells[4].terrain=T_DOOR_CLOSED; nnh_resolve_cell(&k,4,&c);
    for(i=0;i<c.action_count;i++) { assert(!strcmp(c.actions[i].availability,"outOfReach")); assert(!c.actions[i].arguments); }
    k.inventory_current=1; k.tools=0; nnh_resolve_cell(&k,40,&c); assert(!strcmp(c.actions[c.action_count-1].availability,"knownBlocked"));
    start=clock(); for(i=0;i<100000;i++) { nnh_resolve_cell(&k,i%81,&c); }
    printf("100000 pure cell resolutions: %.2f ms\n", 1000.0*(clock()-start)/CLOCKS_PER_SEC);
    return 0;
}
