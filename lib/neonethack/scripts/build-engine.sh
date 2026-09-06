#!/bin/sh
# Generate native engine/host tools/data. Never reinstall over live game data.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
UP="$HERE/engine"
PLAY="$UP/playground"
mkdir -p "$HERE/build"
# Native and WASM builds share generated host headers/data; serialize writers.
exec 9>"$HERE/build/.engine-build.lock"
flock 9
ARCHIVE="${NNH_LUA_ARCHIVE:-$HERE/third_party/lua-5.4.9.tar.gz}"
if [ -z "${LUA_HOME:-}" ] && [ -f "$ARCHIVE" ]; then
  printf '%s  %s\n' 2335b6c582a52654f94612bf10d2f4672805d05329aa6568b1d8cd9e5c6fb8e6 "$ARCHIVE" | sha256sum -c -
  LUA_HOME="$HERE/build/lua-5.4.9"
  if [ ! -d "$LUA_HOME" ]; then tar -xzf "$ARCHIVE" -C "$HERE/build"; fi
  make -C "$LUA_HOME/src" -j "${JOBS:-4}" liblua.a "CC=${CC:-cc}" "MYCFLAGS=-DLUA_USE_LINUX -ffile-prefix-map=$HERE=."
fi
if [ -z "${LUA_HOME:-}" ]; then
  if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists lua5.4; then
    LUA_HOME=$(pkg-config --variable=prefix lua5.4)
  elif command -v mise >/dev/null 2>&1; then
    LUA_HOME=$(mise where lua@5.4.9)
  else
    echo 'Set LUA_HOME to a Lua 5.4 development installation.' >&2; exit 1
  fi
fi
HEAD="$LUA_HOME/include"
[ -f "$HEAD/lua.h" ] || HEAD="$LUA_HOME/include/lua5.4"
[ -f "$HEAD/lua.h" ] || HEAD="$LUA_HOME/src"
LIB="$LUA_HOME/lib/liblua.a"
[ -f "$LIB" ] || LIB="$LUA_HOME/src/liblua.a"
if [ ! -f "$LIB" ] && command -v pkg-config >/dev/null 2>&1; then
  LIB=$(pkg-config --variable=libdir lua5.4)/liblua5.4.a
fi
if [ ! -f "$HEAD/lua.h" ] || [ ! -f "$LIB" ]; then
  echo "Lua headers/static library missing. Install Lua 5.4 or set LUA_HOME (currently $LUA_HOME)." >&2; exit 1
fi
if [ ! -f "$PLAY/nhdat" ] && [ -d "$PLAY" ] && [ -n "$(ls -A "$PLAY")" ]; then
  echo "Refusing to install over nonempty $PLAY without nhdat." >&2; exit 1
fi
NEEDS_SETUP=0
[ -f "$UP/src/Makefile" ] || NEEDS_SETUP=1
for FILE in "$UP"/sys/unix/Makefile.* "$UP/sys/unix/setup.sh" "$UP/sys/unix/hints/headless.500" "$UP"/sys/unix/hints/include/*; do
  if [ "$FILE" -nt "$UP/src/Makefile" ]; then NEEDS_SETUP=1; fi
done
if [ "$NEEDS_SETUP" = 1 ]; then (cd "$UP" && sh sys/unix/setup.sh sys/unix/hints/headless.500); fi
set -- "CC=${CC:-cc}" "LUA_MISE=$LUA_HOME" "LUAHEADERS=$HEAD" "LUATESTTARGET=$HEAD/lua.h" LUAHPREFIX= "LUATOPLIB=$LIB" LUALIB= LUALIBBUILT= "LUALIBS=$LIB -lm -ldl" "LUACFLAGS=-I$HEAD" "HACKDIR=$PLAY" "INSTDIR=$PLAY" "VARDIR=$PLAY" SHELLDIR= CHOWN=true CHGRP=true "NEONETHACK_CFLAGS=-ffile-prefix-map=$HERE=. ${NEONETHACK_CFLAGS:-}"
if [ -n "${NEONETHACK_LDFLAGS:-}" ]; then set -- "$@" "LFLAGS=$NEONETHACK_LDFLAGS"; fi
signature=$( { printf '%s\n' "$@"; "${CC:-cc}" --version; cksum "$UP/src/Makefile" "$UP/util/Makefile"; } | cksum)
previous=''
if [ -f "$HERE/build/engine.signature" ]; then IFS= read -r previous < "$HERE/build/engine.signature" || true; fi
if [ "$signature" != "$previous" ]; then
  make -C "$UP/src" clean "$@"
  make -C "$UP/util" clean "$@"
  rm -f "$UP/include/nhlua.h" # generated host include, never a source file
fi
# Top-level all/check-dlb updates the archive as well as the executable.
make -C "$UP" -j "${JOBS:-4}" "$@"
if [ ! -f "$PLAY/nhdat" ]; then
  make -C "$UP" install "$@"
else
  for name in nethack nhdat symbols license; do
    if [ "$name" = nethack ]; then source="$UP/src/$name"; else source="$UP/dat/$name"; fi
    if cmp -s "$source" "$PLAY/$name"; then continue; fi
    TEMP="$PLAY/$name.new-$$"
    trap 'rm -f "$TEMP"' EXIT HUP INT TERM
    cp "$source" "$TEMP"
    mv "$TEMP" "$PLAY/$name"
  done
fi
awk '/^\* Copyright \(C\)/ { copying=1 } copying { if ($0 ~ /^\*+\/$/) exit; sub(/^\* ?/, ""); print }' "$HEAD/lua.h" > "$HERE/build/LUA-LICENSE.txt"
test -s "$HERE/build/LUA-LICENSE.txt"
printf '%s\n' "$signature" > "$HERE/build/engine.signature"
printf '%s\n' 'Engine and data ready; existing session histories and pins were not changed.'
