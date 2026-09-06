#!/bin/sh
# Build in an isolated musl environment; never replace host engine outputs.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT=${1:-$HERE/build/bundle/neohack-mcp}
image="neohack-mcp-build-$$"
container="neohack-mcp-artifact-$$"
cleanup() { podman rm -f "$container" >/dev/null 2>&1 || :; podman rmi "$image" >/dev/null 2>&1 || :; }
trap cleanup EXIT HUP INT TERM
podman build --ignorefile "$HERE/scripts/bundle.ignore" -f "$HERE/scripts/Containerfile.bundle" -t "$image" "$HERE"
podman create --name "$container" "$image" >/dev/null
mkdir -p "$(dirname -- "$OUT")"
podman cp "$container:/src/build/bundle/neonethack-mcp" "$OUT"
chmod 755 "$OUT"
printf 'Bundled native executable: %s\n' "$OUT"
