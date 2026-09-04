#!/bin/sh
# neonethack wasm build: compile the headless NetHack engine to WebAssembly.
# Two-stage: data files come from the existing NATIVE playground build
# (host tools makedefs/lev_comp/dgn_comp already ran); only the engine
# itself is recompiled with emcc, and the playground data is preloaded
# into the virtual FS at /nh.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UP="$ROOT/upstream"
OUT="$ROOT/client/wasm"
LUA="$ROOT/wasm/lua-5.4.9/src"
. "$ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1

mkdir -p "$OUT" "$ROOT/wasm/obj" "$ROOT/wasm/luaobj"

# Mirror the native compile flags (see: touch src/allmain.c && make -n).
# Dropped vs native: -DGNU_LIBC (emscripten is musl),
# -DSIG_RET_TYPE (musl has no __sighandler_t), -DNHUUID (no libuuid),
# -DTIMED_DELAY (setitimer/pause don't exist in the browser).
# HACKDIR points at the preloaded virtual FS mount.
CFLAGS="-O2 -I$UP/include -I$LUA \
 -DNOTTYGRAPHICS -DHEADLESS_GRAPHICS \
 -DDLB -DHACKDIR=\"/nh\" -DDEFAULT_WINDOW_SYS=\"headless\" \
 -DSYSCF -DSYSCF_FILE=\"/nh/sysconf\" -DSECURE \
 -DDUMPLOG -DCONFIG_ERROR_SECURE=FALSE \
 -DCOMPRESS=\"/bin/gzip\" -DCOMPRESS_EXTENSION=\".gz\" \
 -DSELF_RECOVER -DNOSTATICFN"

echo "== lua =="
for f in "$LUA/"*.c; do
  c="$(basename "$f" .c)"
  case "$c" in lua|luac) continue;; esac
  [ -f "$ROOT/wasm/luaobj/$c.o" ] || \
    emcc $CFLAGS -c "$f" -o "$ROOT/wasm/luaobj/$c.o"
done

echo "== engine =="
> "$ROOT/wasm/objs.txt"
while IFS= read -r src; do
  obj="$ROOT/wasm/obj/$(echo "$src" | tr '/' '_').o"
  [ -f "$obj" ] || emcc $CFLAGS -c "$UP/$src" -o "$obj"
  echo "$obj" >> "$ROOT/wasm/objs.txt"
done < "$ROOT/wasm/srcs.txt"
emcc $CFLAGS -c "$ROOT/wasm/nh_wasm.c" -o "$ROOT/wasm/obj/nh_wasm.o"
echo "$ROOT/wasm/obj/nh_wasm.o" >> "$ROOT/wasm/objs.txt"

echo "== stage data =="
rm -rf "$ROOT/wasm/stage"
mkdir -p "$ROOT/wasm/stage/nh"
for f in nhdat sysconf symbols license options logfile record xlogfile perm; do
  [ -e "$UP/playground/$f" ] && cp -r "$UP/playground/$f" "$ROOT/wasm/stage/nh/"
done
mkdir -p "$ROOT/wasm/stage/nh/save"
# wasm has no host binaries: drop host-path entries that fail sysconf
# validation (a sysconf error is fatal at startup: nh_terminate(FAILURE)).
sed -i '/^GREPPATH=/d; /^COMPRESS=/d' "$ROOT/wasm/stage/nh/sysconf"

echo "== link =="
emcc @"$ROOT/wasm/objs.txt" "$ROOT/wasm/luaobj/"*.o \
  -O2 --profiling-funcs -sASYNCIFY=1 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sSTACK_SIZE=8MB \
  -sENVIRONMENT=web,worker,node -sEXIT_RUNTIME=1 \
  -sMODULARIZE=1 -sEXPORT_NAME=createNetHack \
  -sFORCE_FILESYSTEM=1 \
  --preload-file "$ROOT/wasm/stage/nh@/nh" \
  -o "$OUT/nethack.js"
ls -la "$OUT"
