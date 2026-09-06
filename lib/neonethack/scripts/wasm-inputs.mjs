import { sourceState, root, sha256 } from './source-files.mjs';
export const toolchain = { emscripten: '6.0.9', lua: '5.4.9', profile: 'wasm-release-v1' };
// Include compiler sources, generated dispatch, engine data and build recipes.
// Browser glue, TypeScript clients, documentation and tests do not compile C.
export function compileIdentity(files) {
  const selected = Object.fromEntries(Object.entries(files).filter(([path]) =>
    /^(engine\/|src\/|include\/)/.test(path) ||
    /^wasm\/.*\.(c|h|txt)$/.test(path) ||
    ['CMakeLists.txt', 'Makefile', 'wasm/CMakeLists.txt', 'scripts/build-engine.sh',
      'scripts/build-wasm.sh', 'scripts/stage-wasm.mjs',
      'scripts/stage-engine-data.mjs', 'scripts/wasm-inputs.mjs'].includes(path)
  ).sort(([a], [b]) => a.localeCompare(b, 'en')));
  return sha256(JSON.stringify({ toolchain, files: selected }));
}
export async function wasmInputs(base = root) { return compileIdentity((await sourceState(base)).files); }
