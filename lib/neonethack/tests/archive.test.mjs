import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readTar, sourcePath, hostPathLeak } from '../scripts/archive.mjs';
function entry(name, data = '', type = '0', mode = 0o644) {
  const header = Buffer.alloc(512), bytes = Buffer.from(data);
  header.write(name, 0, 100); header.write(mode.toString(8).padStart(7, '0'), 100);
  header.write(bytes.length.toString(8).padStart(11, '0'), 124); header[156] = type.charCodeAt(0);
  header.fill(32, 148, 156);
  header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, bytes, Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length)]);
}
const archive = (...entries) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
test('archive policies retain required SDK source and virtual paths, not generated files or host paths', () => {
  sourcePath('lib/neonethack/third_party/emscripten-runtime/system/lib/libc/musl/dist/config.mak');
  for (const p of ['lib/neonethack/dist/a.js', 'lib/neonethack/build/file', 'sessions/meta.json', 'lib/neonethack/third_party/emscripten-runtime/system/lib/libc/musl/dist/compiled.o']) assert.throws(() => sourcePath(p));
  assert.equal(hostPathLeak('FS.mkdir("/home");FS.mkdir("/home/web_user");'), null);
  assert.equal(hostPathLeak('HOME:"/home/web_user"'), null);
  assert.equal(hostPathLeak('/home/owner/source/file.c'), '/home/owner');
  assert.equal(hostPathLeak('/Users/owner'), '/Users/owner');
});
test('checked archive reader supports regular files and GNU long names', () => {
  const name = 'package/' + 'long/'.repeat(30) + 'file';
  const files = readTar(archive(entry('package/a', 'hello'), entry('././@LongLink', name + '\0', 'L'), entry('ignored', 'long')), 'package');
  assert.equal(files.get('a').data.toString(), 'hello'); assert.equal(files.get(name.slice(8)).data.toString(), 'long');
});
test('checked archives reject traversal, duplicates, links, special files/permissions and corruption before extraction', () => {
  for (const name of ['../outside', '/outside', 'package/../../outside', 'wrong/a', 'package/a\\b'])
    assert.throws(() => readTar(archive(entry(name)), 'package'));
  for (const type of ['1', '2', '3', '4', '6', 'x', 'g']) assert.throws(() => readTar(archive(entry('package/file', '', type)), 'package'), /Unsupported tar entry/);
  assert.throws(() => readTar(archive(entry('package/a'), entry('package/a')), 'package'), /Duplicate/);
  assert.throws(() => readTar(archive(entry('package/a'), entry('package/a/b')), 'package'), /parent directory/);
  assert.throws(() => readTar(archive(entry('package/a', '', '0', 0o4755)), 'package'), /permissions/);
  const damaged = entry('package/a'); damaged[5] ^= 1;
  assert.throws(() => readTar(archive(damaged), 'package'), /checksum/);
  assert.throws(() => readTar(gzipSync(entry('package/a')), 'package'), /end marker/);
  assert.throws(() => readTar(archive(entry('././@LongLink', '../escape\0', 'L'), entry('package/a')), 'package'));
  assert.throws(() => readTar(archive(entry('././@LongLink', 'package/a\0', 'L')), 'package'));
});
