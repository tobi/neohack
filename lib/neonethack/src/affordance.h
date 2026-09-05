#ifndef NNH_AFFORDANCE_H
#define NNH_AFFORDANCE_H
#include "minjson.h"
/* Sanitized knowledge only. No engine headers, object pointers or commands. */
typedef enum {
    T_UNKNOWN = 0, T_WALL, T_FLOOR, T_CORRIDOR, T_DOOR_CLOSED,
    T_STAIRS_UP, T_STAIRS_DOWN, T_ALTAR, T_FOUNTAIN, T_THRONE,
    T_TRAP, T_DARK, T_WATER, T_LAVA, T_SINK, T_GRASS,
    T_DOOR_OPEN, T_BARS, T_TREE, T_ICE, T_GRAVE, T_BRIDGE
} terrain_t;
#define NNH_NEIGHBORHOOD_CELLS 81
#define NNH_AFFORDANCE_ACTIONS 6
#define NNH_DOOR_FACT_LIMIT 8192

typedef struct {
    int terrain, in_bounds, visible; /* visible -1 means unavailable */
    int door_orientation; /* disclosed frame axis: 0 unknown, 1 horizontal, 2 vertical */
    int occupant; /* 0 none, 1 self, 2 creature, 3 ally: perceived, not hidden */
    int boulder, trap;
    int lock; /* 0 unknown, 1 witnessed locked, 2 witnessed unlocked */
    int witnessed; /* latest input boundary disclosed this fact */
    long long observed_turn;
} nnh_known_cell;
typedef struct {
    int supported, have_origin, origin_x, origin_y;
    long long revision;
    char level[80];
    int ordinary_locomotion, door_diagonals, direction_reliable;
    int inventory_current, tools, floor_current, floor_items;
    const char *gate, *decision_id, *unavailable_reason;
    nnh_known_cell cells[NNH_NEIGHBORHOOD_CELLS];
} nnh_knowledge;
typedef struct {
    const char *key, *method, *availability, *reason, *next_input;
    int arguments, direction, door_context; /* direction 0..7, 8 up, 9 down, -1 absent */
} nnh_action_offer;
typedef struct {
    nnh_known_cell known;
    int x, y, dx, dy, walkable; /* -1 null */
    const char *relation, *intent, *restriction;
    nnh_action_offer actions[NNH_AFFORDANCE_ACTIONS];
    int action_count;
} nnh_cell_actions;
extern const char *const nnh_terrain_names[];
extern const char *const nnh_compass_names[];
void nnh_resolve_cell(const nnh_knowledge *, int, nnh_cell_actions *);
void nnh_emit_basis(const nnh_knowledge *, mj_Buf *);
void nnh_emit_gate(const nnh_knowledge *, mj_Buf *);
void nnh_emit_cell_actions(const nnh_cell_actions *, mj_Buf *);
void nnh_emit_neighborhood(const nnh_knowledge *, mj_Buf *);
#endif
