#include "affordance.h"
#include <string.h>
#include <stdlib.h>
const char *const nnh_item_actions[NNH_ITEM_ACTIONS] = {"eat", "drink", "wield", "equip", "remove", "read", "drop", "zap"};
static const char *const item_methods[NNH_ITEM_ACTIONS] = {"game.eat", "game.drink", "game.wield", "game.equip", "game.remove", "game.read", "game.drop", "game.zap"};
const char *const nnh_terrain_names[] = {
    "unknown", "wall", "floor", "corridor", "closedDoor", "stairsUp",
    "stairsDown", "altar", "fountain", "throne", "trap", "dark", "water",
    "lava", "sink", "grass", "openDoor", "bars", "tree", "ice", "grave", "bridge"
};
const char *const nnh_compass_names[] = {
    "north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest", "up", "down"
};
static int direction(int dx, int dy)
{
    static const int xs[] = {0,1,1,1,0,-1,-1,-1}, ys[] = {-1,-1,0,1,1,1,0,-1};
    int i;
    for (i = 0; i < 8; i++) if (xs[i] == dx && ys[i] == dy) return i;
    return -1;
}
static int known_rock(const nnh_known_cell *c)
{
    return c->in_bounds && (c->terrain == T_WALL || c->terrain == T_TREE);
}
static void offer(nnh_cell_actions *out, const char *key, const char *method,
                  const char *availability, int dir, const char *reason, const char *next, int context)
{
    nnh_action_offer *a;
    if (out->action_count >= NNH_AFFORDANCE_ACTIONS) return;
    a = &out->actions[out->action_count++];
    a->key = key; a->method = method; a->availability = availability;
    a->arguments = strcmp(availability, "outOfReach") && strcmp(availability, "knownBlocked");
    a->direction = dir; a->reason = reason; a->next_input = next; a->door_context = context;
}
static void tool_offer(const nnh_knowledge *k, nnh_cell_actions *out, int distant, int door)
{
    const char *availability = distant ? "outOfReach" : !k->inventory_current ? "uncertain" : k->tools ? "needsSelection" : "knownBlocked";
    offer(out, "apply", "game.apply", availability, -1,
          !distant && k->inventory_current && !k->tools ? "noKnownTools" : NULL,
          !distant && (!k->inventory_current || k->tools) ? "item" : NULL, door);
}
void nnh_resolve_cell(const nnh_knowledge *k, int index, nnh_cell_actions *out)
{
    int adjacent, here, terrain, dir, diagonal, door;
    memset(out, 0, sizeof *out);
    out->dx = index % 9 - 4; out->dy = index / 9 - 4;
    out->x = k->origin_x + out->dx; out->y = k->origin_y + out->dy;
    out->known = k->cells[index]; terrain = out->known.terrain;
    here = !out->dx && !out->dy;
    adjacent = !here && abs(out->dx) <= 1 && abs(out->dy) <= 1;
    out->relation = here ? "here" : adjacent ? "adjacent" : "distant";
    out->walkable = -1;
    if (!out->known.in_bounds) { out->walkable = 0; return; }
    if (k->ordinary_locomotion) switch (terrain) {
    case T_FLOOR: case T_CORRIDOR: case T_DOOR_OPEN: case T_STAIRS_UP:
    case T_STAIRS_DOWN: case T_ALTAR: case T_FOUNTAIN: case T_THRONE:
    case T_SINK: case T_GRASS: case T_ICE: case T_GRAVE: case T_BRIDGE:
        out->walkable = 1; break;
    case T_WALL: case T_BARS: case T_TREE: out->walkable = 0; break;
    case T_DOOR_CLOSED: out->walkable = out->known.lock ? out->known.lock == 2 : -1; break;
    default: break;
    }
    dir = direction(out->dx, out->dy);
    diagonal = adjacent && out->dx && out->dy;
    door = terrain == T_DOOR_CLOSED || terrain == T_DOOR_OPEN;
    if (adjacent) {
        out->requires_squeeze = diagonal && k->ordinary_locomotion &&
            known_rock(&k->cells[40 + out->dx]) &&
            known_rock(&k->cells[40 + 9 * out->dy]);
        out->intent = !k->direction_reliable ? "unknown" : out->known.occupant >= 2 ?
            (out->known.occupant == 3 ? "allyBump" : "creatureBump") : out->known.boulder ? "possiblePush" :
            terrain == T_DOOR_CLOSED ? "attemptOpen" : out->walkable == 1 ? "step" :
            out->walkable == 0 ? "attemptObstacle" : "unknown";
        if (k->ordinary_locomotion && k->direction_reliable) {
            if (diagonal && k->door_diagonals && (door || k->cells[40].terrain == T_DOOR_OPEN || k->cells[40].terrain == T_DOOR_CLOSED))
                out->restriction = "intactDoorDiagonal";
            else if (terrain == T_DOOR_CLOSED && out->known.lock == 1) out->restriction = "lockedDoor";
            else if (out->walkable == 0) out->restriction = "knownTerrainObstacle";
            /* Squeeze/body/burden restrictions are not guessed from terrain. */
        }
        offer(out, "move", "game.move", out->walkable < 0 || out->restriction || !k->direction_reliable ? "uncertain" : "attemptable", dir, NULL, NULL, 0);
    }
    if (door) {
        const char *availability = adjacent ? "attemptable" : here ? "knownBlocked" : "outOfReach";
        offer(out, terrain == T_DOOR_OPEN ? "close" : "open", terrain == T_DOOR_OPEN ? "game.close" : "game.open", availability, dir, here ? "requiresAdjacentTarget" : NULL, NULL, 0);
        if (!here) offer(out, "kick", "game.kick", availability, dir, NULL, NULL, 0);
        tool_offer(k, out, !adjacent, 1);
    } else if (adjacent) {
        offer(out, "kick", "game.kick", "uncertain", dir, NULL, NULL, 0);
    }
    if (here) {
        offer(out, "search", "game.search", "attemptable", -1, NULL, NULL, 0);
        offer(out, "wait", "game.wait", "attemptable", -1, NULL, NULL, 0);
        int i;
        offer(out, "pickup", "game.pickup", !k->floor_current ? "uncertain" : k->floor_items ? "needsSelection" : "knownBlocked", -1, k->floor_current && !k->floor_items ? "noPerceivedItems" : NULL, !k->floor_current || k->floor_items ? "item" : NULL, 0);
        for (i = 0; i < NNH_ITEM_ACTIONS; i++) {
            int water = !strcmp(nnh_item_actions[i], "drink") && (terrain == T_FOUNTAIN || terrain == T_SINK);
            offer(out, nnh_item_actions[i], item_methods[i], water ? "attemptable" : !k->item_known[i] ? "uncertain" : k->item_count[i] ? "needsSelection" : "knownBlocked", -1,
                  !water && k->item_known[i] && !k->item_count[i] ? "noPerceivedItems" : NULL,
                  !water && (!k->item_known[i] || k->item_count[i]) ? "item" : NULL, 0);
        }
        offer(out, "loot", "game.loot", !k->floor_current ? "uncertain" : k->floor_containers ? "attemptable" : "knownBlocked", -1, k->floor_current && !k->floor_containers ? "noPerceivedContainers" : NULL, NULL, 0);
        if (terrain == T_STAIRS_UP || terrain == T_STAIRS_DOWN)
            offer(out, "climb", "game.climb", "attemptable", terrain == T_STAIRS_UP ? 8 : 9, NULL, NULL, 0);
        if (!door) tool_offer(k, out, 0, 0);
    } else if (!adjacent && (terrain == T_STAIRS_UP || terrain == T_STAIRS_DOWN))
        offer(out, "climb", "game.climb", "outOfReach", -1, NULL, NULL, 0);
}
void nnh_emit_basis(const nnh_knowledge *k, mj_Buf *b)
{
    mj_key(b, "basis"); mj_obj(b);
    mj_key(b, "revision"); mj_intv(b, k->revision);
    mj_key(b, "levelId"); mj_strv(b, k->level);
    mj_key(b, "origin"); mj_obj(b);
    mj_key(b, "x"); mj_intv(b, k->origin_x); mj_key(b, "y"); mj_intv(b, k->origin_y);
    mj_endobj(b); mj_endobj(b);
}
void nnh_emit_gate(const nnh_knowledge *k, mj_Buf *b)
{
    mj_key(b, "inputGate"); mj_obj(b); mj_key(b, "state"); mj_strv(b, k->gate);
    if (k->decision_id && *k->decision_id) { mj_key(b, "decisionId"); mj_strv(b, k->decision_id); }
    mj_endobj(b);
}
const char *nnh_terrain_freshness(int terrain, int visible)
{
    return terrain == T_UNKNOWN || terrain == T_DARK ? "unknown" :
        visible == 1 ? "current" : "remembered";
}
void nnh_emit_display(const nnh_known_cell *c, mj_Buf *b)
{
    if (c->occupant) {
        mj_key(b, "occupant"); mj_obj(b);
        mj_key(b, "kind"); mj_strv(b, c->occupant == 1 ? "self" : c->occupant == 3 ? "ally" : "creature");
        if (c->occupant != 1 && c->attitude[0]) { mj_key(b, "attitude"); mj_strv(b, c->attitude); }
        if (c->occupant != 1 && c->appearance[0]) { mj_key(b, "appearance"); mj_strv(b, c->appearance); }
        mj_key(b, "mark"); mj_strv(b, c->mark);
        if (c->occupant != 1) { mj_key(b, "color"); mj_intv(b, c->color); }
        mj_endobj(b);
    } else if (c->object) {
        mj_key(b, "objects"); mj_arr(b); mj_obj(b);
        mj_key(b, "mark"); mj_strv(b, c->mark);
        mj_key(b, "color"); mj_intv(b, c->color);
        if (c->boulder) { mj_key(b, "kind"); mj_strv(b, "boulder"); }
        if (c->object_category[0] && c->object_appearance[0]) {
            mj_key(b, "category"); mj_strv(b, c->object_category);
            mj_key(b, "known"); mj_obj(b);
            mj_key(b, "appearance"); mj_strv(b, c->object_appearance);
            if (c->depicted_creature[0]) { mj_key(b, "depictedCreature"); mj_strv(b, c->depicted_creature); }
            mj_endobj(b);
        }
        mj_endobj(b); mj_endarr(b);
    }
}
void nnh_emit_cell_actions(const nnh_cell_actions *c, mj_Buf *b)
{
    int i;
    mj_obj(b);
    mj_key(b, "x"); mj_intv(b, c->x); mj_key(b, "y"); mj_intv(b, c->y);
    mj_key(b, "dx"); mj_intv(b, c->dx); mj_key(b, "dy"); mj_intv(b, c->dy);
    mj_key(b, "inBounds"); mj_boolv(b, c->known.in_bounds);
    if (c->known.in_bounds) {
        mj_key(b, "visible"); if (c->known.visible < 0) mj_nullv(b); else mj_boolv(b, c->known.visible);
        mj_key(b, "terrain"); mj_obj(b);
        mj_key(b, "type"); mj_strv(b, nnh_terrain_names[c->known.terrain]);
        if ((c->known.terrain == T_DOOR_CLOSED || c->known.terrain == T_DOOR_OPEN) && c->known.door_orientation) {
            mj_key(b, "orientation"); mj_strv(b, c->known.door_orientation == 1 ? "horizontal" : "vertical");
        }
        mj_key(b, "freshness"); mj_strv(b, nnh_terrain_freshness(c->known.terrain, c->known.visible));
        mj_endobj(b);
        if (c->known.terrain == T_DOOR_CLOSED || c->known.terrain == T_DOOR_OPEN) {
            mj_key(b, "door"); mj_obj(b);
            mj_key(b, "lock"); mj_strv(b, c->known.lock == 1 ? "locked" : c->known.lock == 2 ? "unlocked" : "unknown");
            mj_key(b, "freshness"); mj_strv(b, !c->known.lock ? "unknown" : c->known.witnessed ? "witnessed" : "remembered");
            if (c->known.lock) { mj_key(b, "observedTurn"); mj_intv(b, c->known.observed_turn); }
            mj_endobj(b);
        }
        nnh_emit_display(&c->known, b);
        mj_key(b, "hazards"); mj_arr(b);
        if (c->known.trap || c->known.terrain == T_TRAP) mj_strv(b, "trap");
        if (c->known.terrain == T_WATER) mj_strv(b, "water");
        if (c->known.terrain == T_LAVA) mj_strv(b, "lava");
        mj_endarr(b);
    }
    mj_key(b, "walkable"); if (c->walkable < 0) mj_nullv(b); else mj_boolv(b, c->walkable);
    mj_key(b, "movement"); mj_obj(b); mj_key(b, "relation"); mj_strv(b, c->relation);
    if (c->intent) { mj_key(b, "intent"); mj_strv(b, c->intent); }
    if (c->restriction) { mj_key(b, "knownRestriction"); mj_strv(b, c->restriction); }
    if (c->requires_squeeze) { mj_key(b, "requiresSqueeze"); mj_boolv(b, 1); }
    mj_endobj(b);
    mj_key(b, "actions"); mj_arr(b);
    for (i = 0; i < c->action_count; i++) {
        const nnh_action_offer *a = &c->actions[i];
        mj_obj(b); mj_key(b, "key"); mj_strv(b, a->key); mj_key(b, "method"); mj_strv(b, a->method);
        mj_key(b, "availability"); mj_strv(b, a->availability);
        if (a->arguments) {
            mj_key(b, "arguments"); mj_obj(b);
            if (a->direction >= 0) {
                int target = strcmp(a->method, "game.move") && strcmp(a->method, "game.climb");
                if (target) { mj_key(b, "target"); mj_obj(b); }
                mj_key(b, "direction"); mj_strv(b, nnh_compass_names[a->direction]);
                if (target) mj_endobj(b);
            }
            mj_endobj(b);
        }
        if (a->reason) { mj_key(b, "reason"); mj_strv(b, a->reason); }
        if (a->next_input) { mj_key(b, "nextInput"); mj_strv(b, a->next_input); }
        if (a->door_context) {
            mj_key(b, "context"); mj_obj(b); mj_key(b, "kind"); mj_strv(b, "door");
            mj_key(b, "x"); mj_intv(b, c->x); mj_key(b, "y"); mj_intv(b, c->y); mj_endobj(b);
        }
        mj_key(b, "cost"); mj_strv(b, "variable");
        if (!strcmp(a->key, "kick")) {
            mj_key(b, "cautions"); mj_arr(b); mj_strv(b, "mayInjure"); mj_strv(b, "mayMakeNoise"); mj_strv(b, "mayDamageProperty"); mj_endarr(b);
        }
        mj_endobj(b);
    }
    mj_endarr(b); mj_endobj(b);
}
void nnh_emit_neighborhood(const nnh_knowledge *k, mj_Buf *b)
{
    int i; nnh_cell_actions cell;
    mj_obj(b); mj_key(b, "version"); mj_intv(b, 1);
    mj_key(b, "status"); mj_strv(b, k->unavailable_reason ? "unavailable" : "available");
    if (k->unavailable_reason) { mj_key(b, "reason"); mj_strv(b, k->unavailable_reason); }
    else {
        nnh_emit_basis(k, b); nnh_emit_gate(k, b);
        mj_key(b, "radius"); mj_intv(b, 4);
        mj_key(b, "cells"); mj_arr(b);
        for (i = 0; i < NNH_NEIGHBORHOOD_CELLS; i++) { nnh_resolve_cell(k, i, &cell); nnh_emit_cell_actions(&cell, b); }
        mj_endarr(b);
    }
    mj_endobj(b);
}

int nnh_known_paths(const nnh_knowledge *basis, const nnh_known_cell *map, int *parent)
{
    static const int dx[] = {0,1,1,1,0,-1,-1,-1}, dy[] = {-1,-1,0,1,1,1,0,-1};
    int queue[NNH_MAP_CELLS];
    int start = basis->origin_y * NNH_MAP_WIDTH + basis->origin_x;
    int head = 0, tail = 0, i;
    nnh_knowledge k = *basis;
    if (!basis->have_origin || !basis->ordinary_locomotion || !basis->direction_reliable ||
        start < 0 || start >= NNH_MAP_CELLS || !map[start].in_bounds) return -1;
    for (i = 0; i < NNH_MAP_CELLS; i++) parent[i] = -1;
    queue[tail++] = start; parent[start] = start;
    while (head < tail) {
        int at = queue[head++], x = at % NNH_MAP_WIDTH, y = at / NNH_MAP_WIDTH;
        int ox, oy;
        k.origin_x = x; k.origin_y = y;
        memset(k.cells, 0, sizeof k.cells);
        for (oy = -1; oy <= 1; oy++) for (ox = -1; ox <= 1; ox++) {
            int nx = x + ox, ny = y + oy;
            if (nx >= 1 && nx < NNH_MAP_WIDTH && ny >= 0 && ny < NNH_MAP_HEIGHT)
                k.cells[40 + ox + 9 * oy] = map[ny * NNH_MAP_WIDTH + nx];
        }
        for (i = 0; i < 8; i++) {
            nnh_cell_actions edge;
            int nx = x + dx[i], ny = y + dy[i], next;
            if (nx < 1 || nx >= NNH_MAP_WIDTH || ny < 0 || ny >= NNH_MAP_HEIGHT) continue;
            next = ny * NNH_MAP_WIDTH + nx;
            if (parent[next] >= 0) continue;
            nnh_resolve_cell(&k, 40 + dx[i] + 9 * dy[i], &edge);
            /* Unknown diagonal corners also cannot establish a known route. */
            if (dx[i] && dy[i] &&
                (k.cells[40 + dx[i]].terrain == T_UNKNOWN || k.cells[40 + dx[i]].terrain == T_DARK ||
                 k.cells[40 + 9 * dy[i]].terrain == T_UNKNOWN || k.cells[40 + 9 * dy[i]].terrain == T_DARK)) continue;
            /* Do not infer push/squeeze feasibility around boulder corners. */
            if (dx[i] && dy[i] &&
                (known_rock(&k.cells[40 + dx[i]]) || k.cells[40 + dx[i]].boulder) &&
                (known_rock(&k.cells[40 + 9 * dy[i]]) || k.cells[40 + 9 * dy[i]].boulder)) continue;
            if (edge.walkable != 1 || !edge.intent || strcmp(edge.intent, "step") ||
                edge.restriction || edge.requires_squeeze || edge.known.trap) continue;
            parent[next] = at; queue[tail++] = next;
        }
    }
    return start;
}

const char *nnh_known_block(const nnh_known_cell *c)
{
    if (!c || !c->in_bounds) return "disconnected";
    if (c->terrain == T_UNKNOWN || c->terrain == T_DARK) return "targetUnknown";
    if (c->occupant >= 2) return "targetOccupied";
    if (c->terrain == T_DOOR_CLOSED) return "closedDoor";
    return "disconnected";
}
int nnh_known_route(const nnh_knowledge *basis, const nnh_known_cell *map, int target, int *steps)
{
    int parent[NNH_MAP_CELLS], i, n = 0;
    int start = nnh_known_paths(basis, map, parent);
    if (start < 0 || target < 0 || target >= NNH_MAP_CELLS || parent[target] < 0) return -1;
    for (i = target; i != start; i = parent[i]) steps[n++] = i;
    for (i = 0; i < n / 2; i++) {
        int swap = steps[i]; steps[i] = steps[n - 1 - i]; steps[n - 1 - i] = swap;
    }
    return n;
}
