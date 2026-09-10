import { mkdir, readdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { checkCompiled } from './check-package.mjs';
const root = resolve(import.meta.dirname, '..');
// Keep shipped schemas current even when no TypeScript module imports the JSON.
await mkdir(`${root}/dist/protocol`, { recursive: true });
for (const name of ['catalog.json', 'response.schema.json']) await copyFile(`${root}/protocol/${name}`, `${root}/dist/protocol/${name}`);
const out = `${root}/dist/wasm`;
await mkdir(out, { recursive: true });
// A TS-only build must never silently bless changed compiler outputs.
await checkCompiled(out, true);
for (const name of await readdir(`${root}/wasm`)) if (name.endsWith('.mjs')) await copyFile(`${root}/wasm/${name}`, `${out}/${name}`);
const names = (await readdir(out)).filter(n => /\.(mjs|wasm|data)$/.test(n)).sort();
const required = ['neonethack-core.mjs', 'neonethack-core.wasm', 'neonethack-engine.mjs', 'neonethack-engine.wasm', 'neonethack-engine.data'];
if (required.every(n => names.includes(n))) {
  const files = {};
  for (const name of names) files[name] = createHash('sha256').update(await readFile(`${out}/${name}`)).digest('hex');
  const buildId = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  await writeFile(`${out}/manifest.json`, JSON.stringify({ version: 1, buildId, files }, null, 2) + '\n');
}

// WASM staging can run before tsc in a fresh checkout.
await chmod(`${root}/dist/mcp/cli.js`,0o755).catch(error=>{if(error.code!=='ENOENT')throw error;});
