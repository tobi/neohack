// Exact inventories for this preview recipe, shared by builder and auditor.
// New public modules/install outputs must be reviewed here, not silently packed.
import assert from 'node:assert/strict';
export const distModules = [
  'typescript/index', 'typescript/client', 'typescript/types', 'typescript/requests',
  'typescript/hero', 'typescript/vocabulary', 'typescript/hero-events', 'typescript/lifecycle',
  'typescript/native', 'typescript/wasm', 'typescript/webmcp',
  'typescript/reference-client', 'typescript/public-trace', 'typescript/self-state',
  'mcp/compact', 'mcp/cli', 'mcp/server', 'mcp/tools', 'mcp/protocol-data',
];
export const distFiles = [
  ...distModules.flatMap(path => ['js', 'js.map', 'd.ts'].map(ext => `${path}.${ext}`)),
  'protocol/catalog.json', 'protocol/response.schema.json',
];
export const nativeFiles = [
  'bin/neonethack-mcp', 'bin/neonethack', 'include/neonethack.h', 'lib/libneonethack.a',
  ...['Config', 'ConfigVersion', 'Targets', 'Targets-release'].map(name => `lib/cmake/neonethack/neonethack${name}.cmake`),
  'lib/pkgconfig/neonethack.pc', 'libexec/neonethack/engine',
  ...['README.md', 'NOTICE.md', 'license', 'LUA-LICENSE.txt', 'SOURCE.json',
    'data/nhdat', 'data/symbols', 'data/sysconf', 'data/license',
    'protocol/mcp-response.schema.json', 'protocol/catalog.json', 'protocol/request.schema.json', 'protocol/response.schema.json',
  ].map(path => `share/neonethack/${path}`),
];
export const npmSourceFiles = [
  'package.json', 'README.md', 'NOTICE.md', 'include/neonethack.h',
  'protocol/mcp-response.schema.json', 'protocol/catalog.json', 'protocol/request.schema.json', 'protocol/response.schema.json',
];
export function checkInventory(actual, expected, kind) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${kind} inventory (missing or unexpected files)`);
}
export function checkNpmSources(sources, npm) {
  const prefix = 'lib/neonethack/';
  const docs = [...sources.keys()].filter(path => /^lib\/neonethack\/docs\/[^/]+\.(md|html)$/.test(path)).map(path => path.slice(prefix.length));
  const expected = [...npmSourceFiles, ...docs];
  checkInventory([...npm.keys()].filter(path => !path.startsWith('dist/')), expected, 'npm source');
  for (const path of expected) {
    const source = sources.get(prefix + path)?.data;
    assert.ok(source, `Missing npm source: ${path}`);
    const packed = npm.get(path).data;
    // npm may format package.json; every metadata value still has to match.
    if (path === 'package.json') assert.deepEqual(JSON.parse(packed), JSON.parse(source), 'Packed package metadata differs from source');
    else assert.deepEqual(packed, source, `Packed source differs: ${path}`);
  }
}
