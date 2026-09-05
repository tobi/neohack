// Strict reader for the regular-file/directory/GNU-long-name tar subset emitted
// by our preview recipe. Reject links, devices, PAX overrides, duplicate paths,
// bad checksums and traversal BEFORE writing anything. Not a general tar tool.
import { gunzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safePath } from './source-files.mjs';
const decoder = new TextDecoder('utf-8', { fatal: true });
export function sourcePath(path) {
  safePath(path);
  // Required musl source template, not generated dist output.
  const template = path === 'lib/neonethack/third_party/emscripten-runtime/system/lib/libc/musl/dist/config.mak';
  if (!template && /(^|\/)(\.git|node_modules|playground|build|dist|sessions|__pycache__)(\/|$)/.test(path)) throw Error(`Non-source path: ${path}`);
}
export function hostPathLeak(bytes) {
  // Bound at quotes: do not span adjacent strings in minified JS. The
  // Emscripten MEMFS home is a virtual path, never the user's real home.
  for (const home of bytes.toString().matchAll(/\/(?:home|Users)\/([^/"'\s\0]+)/g))
    if (home[1] !== 'web_user') return home[0];
  return null;
}
function text(bytes) {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function octal(bytes) {
  const value = text(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw Error('Unsupported tar numeric field');
  const number = parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw Error('Oversized tar numeric field');
  return number;
}
export function readTar(compressed, prefix) {
  safePath(prefix);
  const bytes = gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map(), names = new Set();
  let at = 0, longName = null, ended = false, headers = 0;
  while (at + 512 <= bytes.length) {
    const header = bytes.subarray(at, at + 512); at += 512;
    if (header.every(byte => byte === 0)) {
      if (longName || bytes.length - at < 512 || bytes.subarray(at).some(byte => byte !== 0)) throw Error('Invalid tar end marker');
      ended = true; break;
    }
    if (++headers > 40000) throw Error('Too many tar headers');
    const checksum = [...header].reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== octal(header.subarray(148, 156))) throw Error('Tar header checksum mismatch');
    const size = octal(header.subarray(124, 136)), mode = octal(header.subarray(100, 108));
    const next = at + Math.ceil(size / 512) * 512;
    if (next > bytes.length) throw Error('Truncated tar payload');
    const data = bytes.subarray(at, at + size); at = next;
    const type = header[156] ? String.fromCharCode(header[156]) : '0';
    if (type === 'L') {
      if (longName || !size || size > 8192 || data[size - 1] !== 0 || data.subarray(0, -1).includes(0)) throw Error('Invalid GNU long name');
      longName = text(data); continue;
    }
    if (type !== '0' && type !== '5') throw Error(`Unsupported tar entry type: ${type}`);
    let name = text(header.subarray(0, 100));
    const ustar = text(header.subarray(257, 263)) === 'ustar';
    const parent = ustar ? text(header.subarray(345, 500)) : '';
    name = longName ?? (parent ? `${parent}/${name}` : name); longName = null;
    if (type === '5' && name.endsWith('/')) name = name.slice(0, -1);
    safePath(name);
    if (name !== prefix && !name.startsWith(prefix + '/')) throw Error(`Wrong archive root: ${name}`);
    if (names.has(name)) throw Error(`Duplicate tar path: ${name}`);
    names.add(name);
    if (mode & ~0o777) throw Error(`Special tar permissions: ${name}`);
    if (type === '5') { if (size) throw Error('Directory with payload'); continue; }
    if (name === prefix) throw Error('Archive root must be a directory');
    files.set(name.slice(prefix.length + 1), { data, mode });
  }
  if (!ended || longName) throw Error('Missing tar end marker');
  for (const name of files.keys()) {
    let parent = dirname(name);
    while (parent !== '.') {
      if (files.has(parent)) throw Error(`File is also a parent directory: ${parent}`);
      parent = dirname(parent);
    }
  }
  return files;
}
export async function extract(files, directory) {
  await mkdir(directory); // must be a new owned directory, never merge
  for (const [name, { data, mode }] of files) {
    await mkdir(dirname(`${directory}/${name}`), { recursive: true });
    await writeFile(`${directory}/${name}`, data, { flag: 'wx', mode });
  }
}
