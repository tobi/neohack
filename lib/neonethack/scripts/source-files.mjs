// One explicit source selection for provenance and distribution. No live
// playgrounds, cached binaries, dependencies, Git state or private root files.
import { readdir, lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
export const root = resolve(import.meta.dirname, '..');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function safePath(path) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(s => !s || s === '.' || s === '..') || /[\x00-\x1f\x7f]/.test(path)) throw Error(`Unsafe source path: ${path}`);
  return path;
}
async function sourceDirectory(path) {
  if (!(await lstat(path)).isDirectory()) throw Error(`Source directory is not a regular directory (symlink/non-directory): ${path}`);
}
// Check every component beneath the explicitly supplied source root, not just
// the leaf. Callers must keep this trusted tree stable during snapshotting;
// these checks are not protection against a concurrent hostile filesystem.
export async function regularSource(base, path, directories = new Set()) {
  safePath(path);
  const parents = [base];
  for (const part of path.split('/').slice(0, -1)) parents.push(`${parents.at(-1)}/${part}`);
  for (const parent of parents) if (!directories.has(parent)) {
    await sourceDirectory(parent); directories.add(parent);
  }
  if (!(await lstat(`${base}/${path}`)).isFile()) throw Error(`Source is not a regular file: ${path}`);
}
export async function walk(directory, prefix = '') {
  await sourceDirectory(directory);
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw Error(`Symlink not allowed in source inventory: ${directory}/${entry.name}`);
    if (entry.isDirectory()) files.push(...await walk(`${directory}/${entry.name}`, `${name}/`));
    else if (entry.isFile()) files.push(name);
    else throw Error(`Nonregular source: ${name}`);
  }
  return files.sort();
}
export async function sourceFiles(base = root) {
  const directories = new Set();
  await regularSource(base, 'engine/SOURCES.json', directories);
  const engine = JSON.parse(await readFile(`${base}/engine/SOURCES.json`, 'utf8'));
  if (!Array.isArray(engine) || engine.length < 1000 || new Set(engine).size !== engine.length || !engine.includes('dat/license')) throw Error('Incomplete engine source inventory');
  const files = ['CMakeLists.txt', 'Makefile', 'README.md', 'NOTICE.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'engine/SOURCES.json', ...engine.map(p => `engine/${safePath(p)}`)];
  for (const dir of ['src', 'include', 'cli', 'protocol', 'typescript', 'mcp', 'wasm', 'scripts', 'tests', 'docs']) {
    for (const path of await walk(`${base}/${dir}`)) {
      const vector = dir === 'protocol' && /^engine\/vectors\/(?:(?:errors|gameplay|handshake)\.jsonl|generate\.py)$/.test(path);
      const document = dir === 'docs' && path.endsWith('.html');
      if (!vector && !document && !/\.(c|h|inc|ts|mts|mjs|md|json|sh|txt|in|cmake)$/.test(path) && path !== 'CMakeLists.txt') throw Error(`Unexpected source file: ${dir}/${path}`);
      files.push(`${dir}/${path}`);
    }
  }
  for (const path of files) await regularSource(base, path, directories);
  return [...new Set(files)].sort();
}
export async function sourceState(base = root) {
  const files = {};
  for (const path of await sourceFiles(base)) files[path] = sha256(await readFile(`${base}/${path}`));
  return { hash: sha256(JSON.stringify(files)), files };
}
