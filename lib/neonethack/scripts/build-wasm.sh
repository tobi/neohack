#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
if ! command -v emcmake >/dev/null 2>&1; then
  if [ -n "${EMSDK:-}" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
    . "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
  else
    echo 'Activate Emscripten (tested: 6.0.9), or set EMSDK to its SDK directory.' >&2
    exit 1
  fi
fi
# Build host tools/generated headers/static data before cross-compiling.
sh scripts/build-engine.sh
emcmake cmake -S . -B "${1:-build/wasm}" -G "${2:-Ninja}" -DCMAKE_BUILD_TYPE=Release
cmake --build "${1:-build/wasm}" --target wasm -j "${JOBS:-4}"
