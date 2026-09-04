#!/usr/bin/env python3
"""neonethack sprite atlas generator — stdlib only, no Pillow.

Paints a 32x32 pixel-art tileset (terrain + items + tintable monster
silhouettes) and writes client/assets/atlas.png + atlas.json.

  python3 tools/gen_atlas.py

Entities are drawn WHITE/grayscale with dark outlines; the renderer tints
them at runtime with the NetHack color via vertex colors. Terrain/items
are fully colored (vertex color white).
"""
import json
import os
import struct
import zlib

T = 32  # tile size px
COLS = 16

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "client", "assets")

# ---------------- palette ----------------
INK = (18, 12, 24, 255)       # outlines
WHITE = (232, 232, 240, 255)  # entity base
HI = (255, 255, 255, 255)     # specular
SH = (140, 140, 155, 255)     # entity shade
DSH = (88, 88, 105, 255)      # entity deep shade

STONE = (122, 118, 132, 255)
STONE_D = (84, 80, 96, 255)
STONE_L = (158, 154, 172, 255)
MORTAR = (52, 48, 64, 255)
FLOOR = (96, 78, 60, 255)
FLOOR_D = (74, 60, 46, 255)
FLOOR_L = (118, 98, 76, 255)
FLOOR_DK = (58, 48, 44, 255)
WOOD = (139, 101, 60, 255)
WOOD_D = (102, 72, 42, 255)
WOOD_L = (172, 130, 80, 255)
GOLD = (232, 186, 60, 255)
GOLD_D = (168, 128, 36, 255)
GOLD_L = (255, 226, 130, 255)
WATER = (52, 110, 190, 255)
WATER_D = (32, 70, 140, 255)
WATER_L = (120, 180, 235, 255)
LAVA = (230, 90, 30, 255)
LAVA_D = (150, 40, 16, 255)
LAVA_L = (255, 200, 80, 255)
LEAF = (66, 140, 70, 255)
LEAF_D = (40, 96, 46, 255)
LEAF_L = (110, 190, 110, 255)
GRASS = (74, 124, 62, 255)
TRUNK = (110, 80, 52, 255)
RED = (200, 60, 60, 255)
BONE = (214, 206, 188, 255)
IRON = (150, 156, 170, 255)
IRON_D = (100, 106, 122, 255)
PARCH = (216, 196, 150, 255)


def shade(c, f):
    return (min(255, int(c[0] * f)), min(255, int(c[1] * f)),
            min(255, int(c[2] * f)), 255)


# ---------------- canvas ----------------
class Tile:
    def __init__(self):
        self.px = [(0, 0, 0, 0)] * (T * T)

    def set(self, x, y, c):
        if 0 <= x < T and 0 <= y < T and len(c) == 4 and c[3]:
            self.px[y * T + x] = c

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.set(x, y, c)

    def disc(self, cx, cy, r, c):
        for y in range(int(cy - r), int(cy + r) + 1):
            for x in range(int(cx - r), int(cx + r) + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.5:
                    self.set(x, y, c)

    def line(self, x0, y0, x1, y1, c):
        dx, dy = abs(x1 - x0), abs(y1 - y0)
        n = max(dx, dy, 1)
        for i in range(n + 1):
            self.set(round(x0 + (x1 - x0) * i / n),
                     round(y0 + (y1 - y0) * i / n), c)

    def outline_rect(self, x0, y0, x1, y1, c):
        self.rect(x0, y0, x1, y1, c)

    def shaded_rect(self, x0, y0, x1, y1, top, mid, bot):
        """Beveled box: light top/left, dark bottom/right."""
        self.rect(x0, y0, x1, y1, mid)
        self.line(x0, y0, x1, y0, top)
        self.line(x0, y0, x0, y1, top)
        self.line(x0, y1, x1, y1, bot)
        self.line(x1, y0, x1, y1, bot)


def brick_wall(t, mortar=MORTAR, base=STONE):
    """Ashlar stone wall face."""
    t.rect(0, 0, T - 1, T - 1, mortar)
    rows = [(0, 9), (10, 20), (21, 31)]
    offs = [0, 8, 0]
    for (y0, y1), off in zip(rows, offs):
        x = -off
        while x < T:
            w = 15
            t.shaded_rect(x + 1, y0 + 1, min(x + w, T - 1), y1 - 1,
                          STONE_L, base, STONE_D)
            x += w + 2


def flag_floor(t, base=FLOOR, dark=FLOOR_D, light=FLOOR_L, gap=(52, 44, 40, 255)):
    t.rect(0, 0, T - 1, T - 1, gap)
    t.shaded_rect(1, 1, 14, 14, light, base, dark)
    t.shaded_rect(17, 1, 30, 14, light, base, dark)
    t.shaded_rect(1, 17, 14, 30, light, base, dark)
    t.shaded_rect(17, 17, 30, 30, light, base, dark)
    # speckle
    for (x, y) in ((5, 6), (11, 10), (22, 7), (9, 22), (25, 24), (19, 12)):
        t.set(x, y, dark)


def ent_outline(t):
    """Darken edge pixels of the white silhouette for crispness."""
    for y in range(T):
        for x in range(T):
            if t.px[y * T + x][3] == 0:
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < T and 0 <= ny < T:
                        n = t.px[ny * T + nx]
                        if n[3] and n[:3] != INK[:3]:
                            t.set(x, y, INK)
                            break


# ---------------- terrain ----------------
def p_floor(t):
    flag_floor(t)


def p_floor_dark(t):
    flag_floor(t, base=FLOOR_DK, dark=(40, 34, 32, 255),
               light=(70, 60, 54, 255), gap=(30, 26, 26, 255))


def p_corridor(t):
    t.rect(0, 0, T - 1, T - 1, MORTAR)
    t.rect(0, 11, T - 1, 20, FLOOR)
    t.rect(0, 11, T - 1, 12, FLOOR_L)
    t.rect(0, 19, T - 1, 20, FLOOR_D)
    for x in (4, 12, 20, 27):
        t.set(x, 16, FLOOR_D)


def _wall_base(t, masonry=True):
    t.rect(0, 0, T - 1, T - 1, MORTAR)
    if masonry:
        brick_wall(t)


def _passage(t, x0, x1, horizontal=True):
    """Cut a floor passage through a wall tile."""
    if horizontal:
        t.rect(x0, 11, x1, 20, FLOOR)
        t.rect(x0, 11, x1, 12, FLOOR_L)
        t.rect(x0, 19, x1, 20, FLOOR_D)
    else:
        t.rect(11, x0, 20, x1, FLOOR)
        t.rect(11, x0, 12, x1, FLOOR_L)
        t.rect(19, x0, 20, x1, FLOOR_D)


def p_wall_h(t):
    _wall_base(t)
    _passage(t, 0, T - 1, True)


def p_wall_v(t):
    _wall_base(t)
    _passage(t, 0, T - 1, False)


def p_wall_tl(t):
    _wall_base(t)
    _passage(t, 11, T - 1, True)
    _passage(t, 11, T - 1, False)


def p_wall_tr(t):
    _wall_base(t)
    _passage(t, 0, 20, True)
    _passage(t, 11, T - 1, False)


def p_wall_bl(t):
    _wall_base(t)
    _passage(t, 11, T - 1, True)
    _passage(t, 0, 20, False)


def p_wall_br(t):
    _wall_base(t)
    _passage(t, 0, 20, True)
    _passage(t, 0, 20, False)


def p_wall_t(t):
    _wall_base(t)
    _passage(t, 0, T - 1, True)
    _passage(t, 0, T - 1, False)


def p_wall_cross(t):
    _wall_base(t)


def p_wall_end(t):
    _wall_base(t)
    t.disc(16, 16, 7, STONE)
    t.disc(15, 15, 6, STONE_L)
    t.disc(15, 15, 4, STONE)


def p_door_c(t):
    flag_floor(t)
    t.shaded_rect(6, 2, 25, 29, WOOD_L, WOOD, WOOD_D)
    for y in (8, 15, 22):
        t.line(6, y, 25, y, WOOD_D)
    t.set(21, 16, GOLD_L)
    t.set(21, 17, GOLD_D)
    t.rect(5, 1, 26, 2, STONE_D)
    t.rect(5, 29, 26, 30, STONE_D)


def p_door_o(t):
    flag_floor(t)
    t.shaded_rect(2, 2, 12, 29, WOOD_L, WOOD, WOOD_D)
    for y in (8, 15, 22):
        t.line(2, y, 12, y, WOOD_D)
    t.shaded_rect(19, 2, 29, 29, WOOD_L, WOOD, WOOD_D)
    for y in (8, 15, 22):
        t.line(19, y, 29, y, WOOD_D)


def p_stair_up(t):
    flag_floor(t)
    for i, y0 in enumerate((4, 11, 18)):
        c = (150 - i * 18, 132 - i * 16, 116 - i * 14, 255)
        cd = (100 - i * 14, 88 - i * 12, 76 - i * 10, 255)
        t.shaded_rect(7, y0, 24, y0 + 9, c, c, cd)
    t.rect(7, 4, 24, 5, HI)


def p_stair_dn(t):
    flag_floor(t)
    for i, y0 in enumerate((4, 11, 18)):
        c = (60 + i * 18, 52 + i * 16, 48 + i * 14, 255)
        cl = (96 + i * 16, 84 + i * 14, 76 + i * 12, 255)
        t.shaded_rect(7, y0, 24, y0 + 9, cl, c, (30, 26, 24, 255))
    t.rect(7, 25, 24, 27, (10, 8, 10, 255))


def p_altar(t):
    flag_floor(t)
    t.shaded_rect(6, 18, 25, 28, STONE_L, STONE, STONE_D)
    t.shaded_rect(9, 8, 22, 18, STONE_L, STONE, STONE_D)
    t.rect(9, 8, 22, 10, HI)
    t.disc(16, 6, 3, GOLD)
    t.set(15, 5, GOLD_L)


def p_fountain(t):
    flag_floor(t)
    t.disc(16, 19, 11, STONE_D)
    t.disc(16, 19, 9, STONE)
    t.disc(16, 19, 6, WATER_D)
    t.disc(16, 19, 5, WATER)
    t.disc(15, 18, 2, WATER_L)
    t.rect(14, 6, 18, 13, STONE)
    t.rect(14, 6, 18, 7, STONE_L)
    t.disc(16, 5, 3, WATER)
    t.set(15, 4, WATER_L)


def p_sink(t):
    flag_floor(t)
    t.disc(16, 19, 10, IRON_D)
    t.disc(16, 19, 8, IRON)
    t.disc(16, 19, 5, (40, 42, 52, 255))
    t.rect(15, 6, 17, 12, IRON)
    t.set(15, 6, HI)


def p_throne(t):
    flag_floor(t, base=(110, 88, 60, 255))
    t.shaded_rect(8, 10, 23, 28, GOLD_L, GOLD, GOLD_D)
    t.shaded_rect(11, 4, 20, 10, GOLD_L, GOLD, GOLD_D)
    t.rect(11, 4, 20, 6, GOLD_L)
    t.set(13, 18, RED)
    t.set(18, 18, RED)
    t.rect(10, 14, 21, 16, GOLD_D)


def p_trap(t):
    flag_floor(t)
    t.line(4, 4, 27, 27, WOOD_D)
    t.line(27, 4, 4, 27, WOOD_D)
    t.disc(16, 16, 4, (30, 24, 20, 255))
    t.line(4, 3, 27, 3, WOOD_L)
    t.line(3, 4, 3, 27, WOOD_L)


def p_grass(t):
    t.rect(0, 0, T - 1, T - 1, (56, 92, 52, 255))
    for (x, y, h) in ((4, 20, 6), (9, 24, 8), (15, 18, 5), (21, 23, 7),
                      (27, 19, 6), (7, 12, 5), (18, 10, 7), (25, 28, 5)):
        t.line(x, y, x, y - h, LEAF_L)
        t.line(x + 1, y, x + 1, y - h + 2, LEAF)
    t.rect(0, 28, T - 1, 31, (46, 78, 44, 255))


def p_tree(t):
    t.rect(0, 0, T - 1, T - 1, (56, 92, 52, 255))
    t.rect(14, 22, 17, 31, TRUNK)
    t.rect(14, 22, 15, 31, shade(TRUNK, 1.25))
    t.disc(16, 13, 10, LEAF_D)
    t.disc(15, 12, 8, LEAF)
    for (x, y) in ((11, 8), (17, 6), (20, 12), (12, 15)):
        t.disc(x, y, 2, LEAF_L)


def _water(t, deep=WATER_D, mid=WATER, lite=WATER_L):
    t.rect(0, 0, T - 1, T - 1, deep)
    for y in range(0, T, 4):
        for x in range((y * 7) % 8, T, 8):
            t.line(x, y + 1, x + 3, y + 1, mid)
    t.set(6, 6, lite)
    t.set(22, 18, lite)
    t.set(12, 26, lite)


def p_water(t):
    _water(t)


def p_lava(t):
    t.rect(0, 0, T - 1, T - 1, LAVA_D)
    for y in range(2, T, 5):
        for x in range((y * 5) % 7, T, 7):
            t.line(x, y, x + 3, y, LAVA)
            t.set(x + 1, y - 1, LAVA_L)
    t.disc(22, 22, 3, LAVA_L)


def p_ice(t):
    t.rect(0, 0, T - 1, T - 1, (168, 200, 220, 255))
    t.line(2, 20, 14, 6, HI)
    t.line(14, 6, 28, 14, (200, 225, 240, 255))
    t.line(4, 26, 24, 24, (140, 175, 200, 255))


def p_bars(t):
    flag_floor(t)
    for x in (5, 12, 19, 26):
        t.rect(x, 2, x + 2, 29, IRON_D)
        t.rect(x, 2, x + 1, 29, IRON)
        t.set(x, 3, HI)
    t.rect(2, 6, 29, 7, IRON_D)
    t.rect(2, 22, 29, 23, IRON_D)


def p_bridge(t):
    _water(t)
    t.rect(0, 12, T - 1, 19, WOOD)
    t.rect(0, 12, T - 1, 13, WOOD_L)
    t.rect(0, 18, T - 1, 19, WOOD_D)
    for x in range(2, T, 6):
        t.line(x, 12, x, 19, WOOD_D)


def p_cloud(t):
    t.rect(0, 0, T - 1, T - 1, (120, 130, 150, 255))
    t.disc(11, 17, 7, (200, 208, 222, 255))
    t.disc(20, 15, 8, (200, 208, 222, 255))
    t.disc(16, 20, 8, (180, 190, 205, 255))
    t.disc(13, 14, 3, HI)
    t.disc(21, 12, 2, HI)


def p_sand(t):
    t.rect(0, 0, T - 1, T - 1, (204, 178, 128, 255))
    for (x, y) in ((6, 8), (18, 5), (26, 14), (10, 20), (22, 25), (5, 27)):
        t.set(x, y, (178, 152, 108, 255))
        t.set(x + 1, y, (228, 202, 150, 255))


# ---------------- items (fully colored) ----------------
def _shadow(t, x0, y0, x1, y1):
    t.rect(x0 + 1, y0 + 2, x1 + 1, y1 + 2, (0, 0, 0, 110))


def p_gold(t):
    t.disc(12, 21, 8, (0, 0, 0, 110))
    t.disc(11, 20, 8, GOLD_D)
    t.disc(11, 20, 7, GOLD)
    for (x, y) in ((14, 14), (18, 12), (22, 15), (12, 18), (20, 18),
                   (9, 15), (16, 20), (23, 19), (13, 22), (19, 22)):
        t.disc(x, y, 2, GOLD_L)
        t.set(x, y, HI)


def p_potion(t):
    _shadow(t, 12, 8, 19, 26)
    t.rect(13, 5, 18, 9, IRON)      # cork
    t.rect(13, 5, 18, 6, HI)
    t.rect(11, 9, 20, 12, IRON_D)   # neck
    t.disc(16, 19, 8, IRON_D)       # belly glass
    t.disc(16, 19, 7, (120, 60, 170, 255))  # liquid
    t.rect(10, 15, 12, 22, HI)      # glass shine
    t.set(17, 14, HI)
    t.set(18, 15, (200, 150, 230, 255))


def p_scroll(t):
    _shadow(t, 7, 12, 24, 21)
    t.rect(6, 11, 25, 20, PARCH)
    t.rect(6, 11, 25, 12, HI)
    t.rect(6, 19, 25, 20, shade(PARCH, 0.75))
    t.rect(4, 9, 7, 22, WOOD_D)     # left roller
    t.rect(24, 9, 27, 22, WOOD_D)   # right roller
    t.rect(4, 9, 5, 22, WOOD_L)
    t.rect(24, 9, 25, 22, WOOD_L)
    t.line(10, 15, 21, 15, (150, 60, 60, 255))  # seal script
    t.line(10, 17, 18, 17, (60, 60, 150, 255))


def p_wand(t):
    _shadow(t, 6, 16, 25, 18)
    t.line(5, 17, 24, 15, WOOD)
    t.line(5, 18, 24, 16, WOOD_D)
    t.line(5, 17, 24, 15, WOOD_L)
    t.disc(26, 15, 3, (120, 200, 255, 255))  # tip crystal
    t.set(25, 14, HI)
    t.rect(4, 16, 7, 19, GOLD_D)    # butt cap


def p_ring(t):
    import math
    _shadow(t, 9, 13, 23, 26)
    for a in range(0, 360, 6):
        x = round(16 + 8 * math.cos(math.radians(a)))
        y = round(19 + 8 * math.sin(math.radians(a)))
        t.set(x, y, GOLD)
        t.set(x - 1, y, GOLD_D)
        t.set(x + 1, y, GOLD_D)
    for a in (205, 225, 185):
        x = round(16 + 8 * math.cos(math.radians(a)))
        y = round(19 + 8 * math.sin(math.radians(a)))
        t.set(x, y, GOLD_L)
        t.set(x, y - 1, HI)
    t.disc(16, 10, 3, GOLD_D)       # gem setting
    t.disc(16, 10, 2, RED)
    t.set(15, 9, HI)


def p_amulet(t):
    _shadow(t, 12, 9, 19, 27)
    t.line(13, 4, 13, 11, GOLD)     # chain
    t.line(19, 4, 19, 11, GOLD)
    t.line(13, 4, 19, 4, GOLD_L)
    t.disc(16, 17, 7, GOLD_D)       # medallion
    t.disc(16, 17, 5, GOLD)
    t.disc(15, 16, 2, GOLD_L)
    t.set(16, 17, RED)              # center stone


def p_sword(t):
    _shadow(t, 14, 4, 18, 27)
    t.rect(15, 3, 16, 20, IRON)     # blade
    t.rect(15, 3, 15, 20, HI)
    t.set(15, 2, HI)
    t.set(16, 2, HI)
    t.rect(11, 21, 21, 23, GOLD_D)  # guard
    t.rect(11, 21, 21, 21, GOLD_L)
    t.rect(14, 24, 17, 28, WOOD)    # grip
    t.line(14, 24, 17, 24, WOOD_L)
    t.disc(16, 29, 2, GOLD)         # pommel


def p_dagger(t):
    _shadow(t, 15, 8, 18, 26)
    t.rect(15, 7, 17, 17, IRON)
    t.rect(15, 7, 15, 17, HI)
    t.set(16, 6, HI)
    t.rect(12, 18, 20, 19, GOLD_D)
    t.rect(14, 20, 17, 26, WOOD_D)
    t.rect(14, 20, 15, 26, WOOD_L)


def p_armor(t):
    _shadow(t, 9, 8, 22, 27)
    t.shaded_rect(10, 7, 21, 26, IRON, (120, 126, 142, 255), IRON_D)
    t.rect(10, 7, 21, 9, HI)
    t.rect(14, 7, 17, 12, (60, 62, 74, 255))  # neck hole
    for y in (14, 18, 22):
        t.line(10, y, 21, y, IRON_D)  # bands


def p_shield(t):
    _shadow(t, 9, 6, 22, 27)
    t.disc(16, 17, 9, IRON_D)
    t.disc(16, 17, 8, (110, 130, 160, 255))
    t.disc(16, 17, 6, (140, 160, 190, 255))
    t.disc(16, 17, 2, GOLD)
    t.set(13, 12, HI)
    t.set(14, 11, HI)


def p_helm(t):
    _shadow(t, 10, 12, 21, 26)
    t.disc(16, 18, 8, IRON_D)
    t.rect(8, 18, 24, 25, IRON_D)
    t.disc(16, 17, 7, (120, 126, 142, 255))
    t.rect(9, 17, 23, 24, (120, 126, 142, 255))
    t.rect(13, 17, 18, 24, (40, 42, 52, 255))  # visor slit
    t.set(12, 12, HI)


def p_boots(t):
    _shadow(t, 7, 18, 24, 27)
    t.shaded_rect(8, 10, 14, 25, WOOD_L, WOOD, WOOD_D)
    t.shaded_rect(17, 10, 23, 25, WOOD_L, WOOD, WOOD_D)
    t.rect(8, 22, 14, 26, WOOD_D)
    t.rect(17, 22, 23, 26, WOOD_D)
    t.rect(8, 10, 14, 12, WOOD_L)
    t.rect(17, 10, 23, 12, WOOD_L)


def p_food(t):
    _shadow(t, 8, 16, 23, 24)
    t.disc(13, 19, 6, (190, 130, 70, 255))   # bread round 1
    t.disc(13, 18, 5, (215, 160, 95, 255))
    t.disc(20, 20, 5, (185, 125, 65, 255))   # round 2
    t.disc(20, 19, 4, (210, 155, 90, 255))
    t.set(11, 16, HI)
    t.set(19, 17, HI)


def p_gem(t):
    _shadow(t, 11, 14, 20, 24)
    t.rect(12, 16, 19, 22, (150, 60, 180, 255))
    t.line(12, 16, 16, 10, (190, 120, 220, 255))
    t.line(19, 16, 16, 10, (190, 120, 220, 255))
    t.line(12, 22, 16, 28, (110, 40, 140, 255))
    t.line(19, 22, 16, 28, (110, 40, 140, 255))
    t.set(15, 14, HI)
    t.set(14, 18, (230, 180, 245, 255))


def p_rock(t):
    _shadow(t, 10, 16, 21, 25)
    t.disc(14, 20, 6, STONE_D)
    t.disc(13, 19, 6, STONE)
    t.disc(12, 18, 3, STONE_L)


def p_boulder(t):
    t.disc(16, 20, 11, (0, 0, 0, 110))
    t.disc(16, 19, 11, STONE_D)
    t.disc(15, 18, 10, STONE)
    t.disc(13, 15, 5, STONE_L)
    t.set(12, 14, HI)
    t.set(20, 22, STONE_D)


def p_statue(t):
    _shadow(t, 11, 6, 20, 27)
    t.disc(16, 9, 4, STONE_D)       # head
    t.disc(16, 9, 3, STONE)
    t.rect(12, 13, 19, 24, STONE_D)  # torso
    t.rect(13, 13, 18, 24, STONE)
    t.rect(13, 13, 14, 24, STONE_L)
    t.rect(10, 25, 21, 27, STONE_D)  # plinth


def p_lamp(t):
    _shadow(t, 7, 16, 24, 24)
    t.disc(14, 20, 6, GOLD_D)       # oil body
    t.disc(14, 20, 5, GOLD)
    t.set(12, 18, GOLD_L)
    t.rect(18, 18, 26, 21, GOLD_D)  # spout
    t.rect(24, 19, 26, 20, GOLD_L)
    t.disc(26, 16, 2, LAVA_L)       # flame
    t.set(26, 17, LAVA)
    t.rect(12, 12, 16, 15, GOLD_D)  # handle stub


def p_key(t):
    _shadow(t, 7, 9, 24, 23)
    for a in range(0, 360, 12):     # bow ring
        import math
        x = round(10 + 5 * math.cos(math.radians(a)))
        y = round(14 + 5 * math.sin(math.radians(a)))
        t.set(x, y, GOLD)
        t.set(x, y - 1, GOLD_L)
    t.rect(14, 13, 25, 15, GOLD)    # shaft
    t.rect(14, 13, 25, 13, GOLD_L)
    t.rect(14, 15, 25, 15, GOLD_D)
    t.rect(22, 15, 24, 20, GOLD)    # teeth
    t.rect(22, 19, 24, 20, GOLD_L)
    t.rect(18, 15, 19, 18, GOLD)


def p_horn(t):
    _shadow(t, 8, 12, 23, 24)
    for i in range(9):
        x = 8 + i * 2
        y0 = 14 + i
        t.rect(x, y0, x + 1, y0 + 3, WOOD if i % 2 else WOOD_L)
    t.rect(24, 20, 27, 26, GOLD_D)  # bell
    t.rect(24, 25, 27, 26, GOLD_L)


# ---------------- entities (white silhouettes, tinted at runtime) ----------------
W, S, D, H = WHITE, SH, DSH, HI


def _legs(t, xs, y0=22, y1=28):
    for x in xs:
        t.rect(x, y0, x + 1, y1, S)
        t.rect(x, y0, x, y1, W)


def p_e_humanoid(t):
    t.disc(16, 8, 5, S)             # head
    t.disc(16, 8, 4, W)
    t.set(14, 7, D)                 # eyes
    t.set(18, 7, D)
    t.shaded_rect(12, 13, 19, 23, H, W, S)   # torso
    t.rect(12, 13, 13, 23, H)
    t.rect(9, 14, 11, 21, S)        # arms
    t.rect(20, 14, 22, 21, S)
    t.rect(9, 14, 9, 21, W)
    t.rect(20, 14, 20, 21, W)
    _legs(t, (13, 17))
    ent_outline(t)


def p_e_big_humanoid(t):
    t.disc(16, 7, 6, S)
    t.disc(16, 7, 5, W)
    t.set(13, 6, D)
    t.set(19, 6, D)
    t.line(13, 9, 19, 9, D)         # grim mouth
    t.shaded_rect(10, 13, 21, 24, H, W, S)
    t.rect(10, 13, 11, 24, H)
    t.rect(6, 14, 9, 22, S)         # heavy arms
    t.rect(22, 14, 25, 22, S)
    t.rect(6, 14, 6, 22, W)
    t.rect(22, 14, 22, 22, W)
    _legs(t, (12, 18), 24, 29)
    ent_outline(t)


def p_e_small_humanoid(t):
    t.disc(16, 13, 4, S)
    t.disc(16, 13, 3, W)
    t.set(15, 12, D)
    t.set(17, 12, D)
    t.shaded_rect(13, 17, 18, 24, H, W, S)
    t.rect(11, 18, 12, 22, S)
    t.rect(19, 18, 20, 22, S)
    _legs(t, (14, 16), 24, 28)
    ent_outline(t)


def p_e_angel(t):
    for x0, d in ((2, 1), (29, -1)):  # broad wings first (behind body)
        for i in range(8):
            t.line(x0 + d * i, 24 - i, x0 + d * (i + 3), 24 - i, W)
            t.line(x0 + d * i, 25 - i, x0 + d * (i + 2), 25 - i, S)
        t.line(x0, 24, x0 + d * 10, 14, H)
    p_e_humanoid(t)
    t.disc(16, 3, 3, H)             # halo
    t.disc(16, 3, 2, W)
    ent_outline(t)


def p_e_demon(t):
    p_e_humanoid(t)
    t.line(11, 4, 8, 0, D)          # horns
    t.line(21, 4, 24, 0, D)
    t.line(11, 4, 9, 1, H)
    t.line(21, 4, 23, 1, H)
    t.line(13, 9, 19, 9, D)  # grim mouth (grayscale: tinted at runtime)
    ent_outline(t)


def p_e_wraith(t):
    t.disc(16, 9, 5, S)             # hood
    t.disc(16, 10, 4, (30, 28, 40, 255))  # dark face
    t.set(14, 10, H)                    # glowing eyes
    t.set(18, 10, H)
    t.rect(11, 12, 21, 28, S)       # cloak
    t.rect(12, 12, 20, 28, W)
    t.rect(15, 12, 16, 28, S)
    t.line(12, 12, 12, 28, H)
    ent_outline(t)


def p_e_ghost(t):
    t.disc(16, 12, 7, S)
    t.disc(16, 12, 6, W)
    t.set(13, 11, D)
    t.set(19, 11, D)
    t.disc(16, 15, 2, D)            # wail mouth
    for x in (10, 13, 16, 19, 22):  # ragged hem
        t.line(x, 18, x + 1, 26 + (x % 3), W)
    t.set(12, 9, H)
    ent_outline(t)


def p_e_golem(t):
    t.disc(16, 8, 5, D)
    t.disc(16, 8, 4, S)
    t.set(14, 8, H)
    t.set(18, 8, H)
    t.shaded_rect(11, 13, 20, 24, S, W, D)
    t.rect(8, 14, 10, 22, D)
    t.rect(21, 14, 23, 22, D)
    t.rect(8, 14, 8, 22, S)
    t.rect(23, 14, 23, 22, S)
    _legs(t, (12, 18), 24, 29)
    # cracks
    t.line(13, 15, 17, 19, D)
    t.line(17, 19, 15, 23, D)
    ent_outline(t)


def p_e_quadruped(t):
    t.disc(22, 12, 5, S)            # head
    t.disc(22, 12, 4, W)
    t.set(24, 11, D)                # eye
    t.set(21, 7, S)                 # ears
    t.set(24, 7, S)
    t.rect(8, 13, 22, 21, S)        # body
    t.rect(8, 13, 22, 15, W)
    t.rect(8, 19, 22, 21, D)
    _legs(t, (9, 13, 17, 20), 21, 28)
    t.line(8, 14, 4, 10, S)         # tail
    ent_outline(t)


def p_e_feline(t):
    p_e_quadruped(t)
    t.line(20, 7, 18, 3, W)         # pointed ears
    t.line(24, 7, 26, 3, W)
    t.line(20, 7, 19, 4, S)
    t.line(24, 7, 25, 4, S)
    t.line(8, 14, 2, 6, W)          # curled tail
    ent_outline(t)


def p_e_rodent(t):
    t.disc(12, 20, 5, S)
    t.disc(12, 20, 4, W)
    t.disc(12, 14, 3, S)            # big ears
    t.disc(19, 14, 3, S)
    t.disc(12, 14, 2, W)
    t.disc(19, 14, 2, W)
    t.set(11, 19, D)                # nose + eyes
    t.set(10, 17, D)
    t.set(14, 17, D)
    t.line(17, 21, 28, 24, S)       # long tail
    t.set(10, 18, H)
    ent_outline(t)


def p_e_bat(t):
    for x0, d in ((2, 1), (29, -1)):  # leathery wings
        for i in range(6):
            t.line(x0 + d * i * 2, 10 + i, x0 + d * (i * 2 + 2), 12 + i, S)
        t.line(x0, 10, x0 + d * 12, 20, W)
    t.disc(16, 16, 5, S)            # body
    t.disc(16, 16, 4, W)
    t.set(13, 10, S)                # ears
    t.set(19, 10, S)
    t.set(14, 15, D)
    t.set(18, 15, D)
    t.set(15, 12, H)
    ent_outline(t)


def p_e_bird(t):
    t.disc(20, 9, 4, S)             # head
    t.disc(20, 9, 3, W)
    t.line(23, 9, 27, 10, S)        # beak
    t.set(21, 8, D)
    t.disc(15, 19, 6, S)            # body
    t.disc(15, 19, 5, W)
    t.set(12, 16, H)
    for i in range(5):              # wing feathers
        t.line(8, 16 + i * 2, 2, 18 + i * 2, S)
    t.line(9, 20, 4, 26, W)         # tail
    t.line(13, 25, 13, 28, S)       # legs
    t.line(17, 25, 17, 28, S)
    ent_outline(t)


def p_e_serpent(t):
    for i in range(16):             # coiled body
        x = 8 + i
        y = 24 - abs(8 - i) // 2 - (i % 3 == 0)
        t.rect(x, y, x + 1, y + 3, S)
        t.rect(x, y, x + 1, y + 1, W)
    t.disc(24, 12, 5, S)            # head
    t.disc(24, 12, 4, W)
    t.set(25, 11, D)                # eye
    t.line(24, 15, 27, 17, D)       # forked tongue
    t.line(27, 17, 29, 15, D)
    t.line(27, 17, 29, 19, D)
    t.set(22, 9, H)
    ent_outline(t)


def p_e_worm(t):
    for i, (x, y, r) in enumerate(((9, 21, 4), (13, 18, 5), (18, 17, 5),
                                  (23, 18, 4), (26, 15, 3))):
        c = W if i % 2 == 0 else S
        t.disc(x, y, r, D)
        t.disc(x, y, r - 1, c)
    t.set(26, 14, D)                # maw
    t.set(25, 13, D)
    t.line(27, 12, 29, 10, D)       # teeth
    t.set(12, 15, H)
    ent_outline(t)


def p_e_blob(t):
    t.disc(11, 21, 7, S)
    t.disc(20, 22, 6, S)
    t.disc(11, 20, 6, W)
    t.disc(20, 21, 5, W)
    t.disc(11, 19, 4, H)
    t.disc(20, 20, 3, H)
    t.set(9, 16, H)                 # shine
    t.set(10, 15, H)
    t.set(13, 13, S)                # wobble top
    t.set(18, 14, S)
    ent_outline(t)


def p_e_eye(t):
    t.disc(16, 17, 9, S)            # orb
    t.disc(16, 17, 8, W)
    t.disc(16, 17, 5, D)            # iris dark
    t.disc(16, 17, 4, S)
    t.disc(16, 17, 2, (20, 18, 28, 255))  # pupil
    t.set(13, 12, H)
    t.set(14, 11, H)
    for x, y in ((7, 8), (25, 8), (5, 17), (27, 17)):  # stalks
        t.line(16, 12, x, y, S)
        t.disc(x, y, 2, W)
        t.set(x, y, D)
    ent_outline(t)


def p_e_ant(t):
    for (x, y, r) in ((9, 21, 4), (16, 19, 5), (23, 17, 4)):
        t.disc(x, y, r, S)
        t.disc(x, y, r - 1, W)
    t.set(24, 16, D)                # mandibles
    t.set(25, 18, D)
    t.line(22, 13, 20, 9, S)        # antennae
    t.line(24, 13, 24, 9, S)
    for x in (11, 15, 19):          # six legs
        t.line(x, 22, x - 3, 28, S)
        t.line(x + 1, 22, x + 4, 28, S)
    t.set(15, 17, H)
    ent_outline(t)


def p_e_spider(t):
    t.disc(16, 19, 5, S)            # abdomen
    t.disc(16, 19, 4, W)
    t.disc(16, 12, 4, S)            # head
    t.disc(16, 12, 3, W)
    t.set(14, 11, D)
    t.set(18, 11, D)
    t.set(16, 11, D)
    for i in range(4):              # eight legs
        y = 15 + i * 2
        t.line(12, y, 3, y + 4 - i, S)
        t.line(20, y, 29, y + 4 - i, S)
    t.set(14, 17, H)
    ent_outline(t)


def p_e_dragon(t):
    for x0, d in ((3, 1), (28, -1)):  # great wings
        for i in range(9):
            t.line(x0 + d * i, 16 - i, x0 + d * (i + 1), 15 - i, S)
        t.line(x0, 16, x0 + d * 9, 7, W)
    t.rect(12, 16, 19, 26, S)       # body
    t.rect(13, 16, 18, 26, W)
    t.rect(13, 16, 14, 26, H)
    t.disc(16, 11, 5, S)            # head
    t.disc(16, 11, 4, W)
    t.line(12, 7, 10, 3, W)         # horns
    t.line(20, 7, 22, 3, W)
    t.set(14, 10, D)
    t.set(18, 10, D)
    t.line(6, 24, 2, 28, S)         # tail
    _legs(t, (13, 17), 26, 29)
    ent_outline(t)


def p_e_mimic(t):
    t.shaded_rect(7, 14, 24, 26, H, W, S)   # chest
    t.rect(7, 14, 24, 16, D)        # lid gap
    for x in (10, 13, 16, 19, 22):  # teeth
        t.line(x, 16, x + 1, 20, H)
    t.rect(14, 8, 17, 14, S)        # lock plate
    t.set(15, 11, D)
    t.rect(7, 14, 24, 15, S)
    ent_outline(t)


def p_e_lizard(t):
    t.rect(8, 18, 22, 23, S)
    t.rect(8, 18, 22, 20, W)
    t.disc(24, 19, 4, S)
    t.disc(24, 19, 3, W)
    t.set(25, 18, D)
    _legs(t, (10, 18), 23, 27)
    t.line(8, 20, 2, 22, S)         # tail
    t.line(12, 16, 12, 13, W)       # back spikes
    t.line(16, 16, 16, 13, W)
    t.line(20, 16, 20, 13, W)
    ent_outline(t)


def p_e_tentacle(t):
    for i, (x, h) in enumerate(((9, 12), (13, 18), (17, 22), (21, 16), (24, 10))):
        t.line(x, 28, x, 28 - h, S)
        t.line(x, 28, x, 28 - h, W if i % 2 == 0 else S)
        t.disc(x, 28 - h, 2, W)
        t.set(x, 28 - h, H)
    t.disc(16, 27, 6, S)            # base mound
    t.disc(16, 27, 5, D)
    ent_outline(t)


def p_e_vortex(t):
    import math
    for i in range(64):
        a = i * 0.42
        r = 2 + i * 0.17
        x = round(16 + r * math.cos(a))
        y = round(17 + r * math.sin(a) * 0.85)
        for dx, dy in ((0, 0), (1, 0), (0, 1)):
            t.set(x + dx, y + dy, W)
        t.set(x, y + 2, S)
    t.disc(16, 17, 4, D)
    t.disc(16, 17, 3, S)
    t.disc(15, 16, 1, H)
    ent_outline(t)


def p_e_mushroom(t):
    t.rect(13, 16, 18, 27, S)       # stem
    t.rect(14, 16, 17, 27, W)
    t.disc(16, 12, 9, S)            # cap
    t.disc(16, 11, 9, W)
    t.rect(7, 12, 25, 14, S)        # cap rim
    for (x, y) in ((11, 8), (17, 6), (21, 11), (13, 12)):
        t.disc(x, y, 2, H)          # spots
    ent_outline(t)


def p_e_unicorn(t):
    p_e_quadruped(t)
    t.line(22, 8, 24, 2, H)         # horn
    t.line(23, 8, 24, 2, W)
    ent_outline(t)


def p_e_dog(t):
    """Pet: fully colored (not tinted)."""
    t.disc(22, 12, 5, WOOD_D)
    t.disc(22, 12, 4, (196, 158, 104, 255))
    t.set(24, 11, INK)
    t.set(23, 15, INK)              # nose
    t.set(21, 7, WOOD_D)            # floppy ears
    t.set(24, 7, WOOD_D)
    t.rect(8, 13, 22, 21, WOOD_D)
    t.rect(8, 13, 22, 15, (196, 158, 104, 255))
    t.rect(8, 19, 22, 21, (120, 86, 52, 255))
    _legs(t, (9, 13, 17, 20), 21, 28)
    t.line(8, 14, 4, 10, WOOD_D)
    t.set(12, 14, WOOD_L)


def p_e_player(t):
    """The hero: fully colored adventurer (never tinted)."""
    BLUE = (70, 110, 200, 255)
    BLUE_D = (46, 74, 150, 255)
    BLUE_L = (120, 160, 230, 255)
    SKIN = (232, 190, 150, 255)
    t.disc(16, 8, 5, WOOD_D)        # hair/helm shadow
    t.disc(16, 8, 4, SKIN)          # face
    t.set(14, 8, INK)
    t.set(18, 8, INK)
    t.rect(11, 2, 21, 5, IRON)      # helm brim
    t.rect(11, 2, 21, 3, HI)
    t.shaded_rect(12, 13, 19, 23, BLUE_L, BLUE, BLUE_D)  # tunic
    t.rect(12, 13, 13, 23, BLUE_L)
    t.rect(9, 14, 11, 20, BLUE_D)   # arms
    t.rect(20, 14, 22, 20, BLUE_D)
    t.rect(9, 14, 9, 20, BLUE)
    t.rect(20, 14, 20, 20, BLUE)
    t.line(23, 12, 27, 6, IRON)     # raised sword
    t.line(23, 12, 27, 6, HI)
    t.rect(21, 12, 24, 14, GOLD_D)  # guard
    _legs(t, (13, 17))
    t.rect(13, 26, 14, 28, WOOD_D)
    t.rect(17, 26, 18, 28, WOOD_D)


def p_unknown(t):
    t.rect(0, 0, T - 1, T - 1, (16, 14, 22, 255))
    t.rect(2, 2, 29, 29, (36, 32, 48, 255))
    for y in range(9, 22):
        for x in range(12, 21):
            if (x + y) % 2 == 0:
                t.set(x, y, (90, 84, 110, 255))
    t.set(15, 15, HI)


# ---------------- registry ----------------
# (name, painter, tintable-at-runtime?)
TILES = [
    # terrain (fully colored)
    ("floor", p_floor, False),
    ("floor_dark", p_floor_dark, False),
    ("corridor", p_corridor, False),
    ("wall_h", p_wall_h, False),
    ("wall_v", p_wall_v, False),
    ("wall_tl", p_wall_tl, False),
    ("wall_tr", p_wall_tr, False),
    ("wall_bl", p_wall_bl, False),
    ("wall_br", p_wall_br, False),
    ("wall_t", p_wall_t, False),
    ("wall_cross", p_wall_cross, False),
    ("wall_end", p_wall_end, False),
    ("door_c", p_door_c, False),
    ("door_o", p_door_o, False),
    ("stair_up", p_stair_up, False),
    ("stair_dn", p_stair_dn, False),
    ("altar", p_altar, False),
    ("fountain", p_fountain, False),
    ("sink", p_sink, False),
    ("throne", p_throne, False),
    ("trap", p_trap, False),
    ("grass", p_grass, False),
    ("tree", p_tree, False),
    ("water", p_water, False),
    ("lava", p_lava, False),
    ("ice", p_ice, False),
    ("bars", p_bars, False),
    ("bridge", p_bridge, False),
    ("cloud", p_cloud, False),
    ("sand", p_sand, False),
    # items (fully colored)
    ("gold", p_gold, False),
    ("potion", p_potion, False),
    ("scroll", p_scroll, False),
    ("wand", p_wand, False),
    ("ring", p_ring, False),
    ("amulet", p_amulet, False),
    ("sword", p_sword, False),
    ("dagger", p_dagger, False),
    ("armor", p_armor, False),
    ("shield", p_shield, False),
    ("helm", p_helm, False),
    ("boots", p_boots, False),
    ("food", p_food, False),
    ("gem", p_gem, False),
    ("rock", p_rock, False),
    ("boulder", p_boulder, False),
    ("statue", p_statue, False),
    ("lamp", p_lamp, False),
    ("key", p_key, False),
    ("horn", p_horn, False),
    # entities (white silhouettes; renderer multiplies NH color)
    ("e_humanoid", p_e_humanoid, True),
    ("e_big_humanoid", p_e_big_humanoid, True),
    ("e_small_humanoid", p_e_small_humanoid, True),
    ("e_angel", p_e_angel, True),
    ("e_demon", p_e_demon, True),
    ("e_wraith", p_e_wraith, True),
    ("e_ghost", p_e_ghost, True),
    ("e_golem", p_e_golem, True),
    ("e_quadruped", p_e_quadruped, True),
    ("e_feline", p_e_feline, True),
    ("e_rodent", p_e_rodent, True),
    ("e_bat", p_e_bat, True),
    ("e_bird", p_e_bird, True),
    ("e_serpent", p_e_serpent, True),
    ("e_worm", p_e_worm, True),
    ("e_blob", p_e_blob, True),
    ("e_eye", p_e_eye, True),
    ("e_ant", p_e_ant, True),
    ("e_spider", p_e_spider, True),
    ("e_dragon", p_e_dragon, True),
    ("e_mimic", p_e_mimic, True),
    ("e_lizard", p_e_lizard, True),
    ("e_tentacle", p_e_tentacle, True),
    ("e_vortex", p_e_vortex, True),
    ("e_mushroom", p_e_mushroom, True),
    ("e_unicorn", p_e_unicorn, True),
    ("e_dog", p_e_dog, False),
    ("e_player", p_e_player, False),
    ("unknown", p_unknown, False),
]


# ---------------- PNG writer (stdlib) ----------------
def _chunk(typ, data):
    out = struct.pack(">I", len(data)) + typ + data
    out += struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
    return out


def write_png(path, tiles, cols):
    rows = (len(tiles) + cols - 1) // cols
    W, H = cols * T, rows * T
    img = bytearray(W * H * 4)
    for i, t in enumerate(tiles):
        ox, oy = (i % cols) * T, (i // cols) * T
        for y in range(T):
            for x in range(T):
                r, g, b, a = t.px[y * T + x]
                o = ((oy + y) * W + ox + x) * 4
                img[o:o + 4] = bytes((r, g, b, a))
    raw = bytearray()
    for y in range(H):
        raw.append(0)
        raw += img[y * W * 4:(y + 1) * W * 4]
    ihdr = struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) +
           _chunk(b"IDAT", zlib.compress(bytes(raw), 9)) +
           _chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return W, H


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    tiles, index = [], {}
    for i, (name, painter, tintable) in enumerate(TILES):
        t = Tile()
        painter(t)
        tiles.append(t)
        index[name] = {"i": i, "x": (i % COLS) * T, "y": (i // COLS) * T,
                       "tint": tintable}
    w, h = write_png(os.path.join(OUT_DIR, "atlas.png"), tiles, COLS)
    with open(os.path.join(OUT_DIR, "atlas.json"), "w") as f:
        json.dump({"tile": T, "cols": COLS, "width": w, "height": h,
                   "tiles": index}, f, indent=1)
    print(f"atlas.png {w}x{h}, {len(tiles)} tiles -> {OUT_DIR}")


if __name__ == "__main__":
    main()
