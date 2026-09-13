#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
if ! command -v emcmake >/dev/null 2>&1; then
  echo 'Enter nix develop from the repository root for the pinned Emscripten toolchain.' >&2
  exit 1
fi
# Build host tools/generated headers/static data before cross-compiling.
sh scripts/build-engine.sh
NNH_WASM_BUILD=${1:-build/wasm}
NNH_GENERATOR=${2:-Ninja}
NNH_TOOLCHAIN="${EMSCRIPTEN_ROOT:?Enter nix develop}/cmake/Modules/Platform/Emscripten.cmake"
set --
# Refresh discovery only when the locked compiler changes; ordinary builds
# retain their object/dependency cache. A missing toolchain denotes a native
# or incomplete cache and cannot safely be reused for WASM.
if [ -f "$NNH_WASM_BUILD/CMakeCache.txt" ]; then
  NNH_CACHED_TOOLCHAIN=$(sed -n 's/^CMAKE_TOOLCHAIN_FILE:[^=]*=//p' "$NNH_WASM_BUILD/CMakeCache.txt")
  if [ "$NNH_CACHED_TOOLCHAIN" != "$NNH_TOOLCHAIN" ]; then set -- --fresh; fi
fi
emcmake cmake "$@" -S . -B "$NNH_WASM_BUILD" -G "$NNH_GENERATOR" -DCMAKE_BUILD_TYPE=Release \
  "-DNNH_NODE=$(command -v node)"
cmake --build "$NNH_WASM_BUILD" --target wasm -j "${JOBS:-4}"
