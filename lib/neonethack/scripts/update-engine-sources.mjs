// Maintainer operation only. Ordinary builds and source packages need no Git.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sourcePath, regularSource } from './source-files.mjs';
const root = resolve(import.meta.dirname, '..');
const prefix = 'lib/neonethack/engine/';
const repo = resolve(root, '../..');
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', prefix], { cwd: repo }).toString().split('\0');
const files = [...new Set(paths.filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length)))].filter(p => p !== 'SOURCES.json').sort();
if (files.length < 1000) throw Error('Unexpected engine inventory; inspect Git/ignore rules before proceeding');
const directories = new Set();
for (const path of files) {
  sourcePath(`${prefix}${path}`);
  await regularSource(root, `engine/${path}`, directories);
}
await writeFile(`${root}/engine/SOURCES.json`, JSON.stringify(files, null, 2) + '\n');
console.log(`Recorded ${files.length} engine source files`);
