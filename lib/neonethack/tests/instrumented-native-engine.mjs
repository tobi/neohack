import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
export async function instrumentedNativeEngine(t, include, prepare) {
  const temp = await mkdtemp('/tmp/nnh-disclosed-engine-');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const cwd = `${root}/engine/src`;
  const flags = async expression => (await run('make', ['-s', '--eval', `nnh-test-flags:;@echo ${expression}`, 'nnh-test-flags'], { cwd })).stdout.trim().split(/\s+/);
  const compile = await flags('$(TARGET_CC) $(TARGET_CFLAGS)');
  const link = await flags('$(TARGET_LINK) $(TARGET_LFLAGS) $(HOBJ) $(DATE_O) $(GENTILEOFILE) $(TARGET_HACKLIB) $(WINLIB) $(TARGET_LIBS) $(LUALIBS) $(AUTOLIBS)');
  let source = await readFile(`${root}/engine/win/headless/winheadless.c`, 'utf8');
  const needle = '        headless_flush();\n        hl_perception();';
  assert.ok(source.includes(needle));
  source = source.replace('static char *\nhl_input(', `#include ${JSON.stringify(include)}\nstatic char *\nhl_input(`).replace(needle, `    ${prepare}();\n${needle}`);
  await writeFile(`${temp}/winheadless.c`, source);
  await run(compile[0], [...compile.slice(1), `-I${root}/engine/win/headless`, '-c', `${temp}/winheadless.c`, '-o', `${temp}/winheadless.o`], { cwd });
  const header = /#include "([^"]*lua.h)"/.exec(await readFile(`${root}/engine/include/nhlua.h`, 'utf8'))?.[1];
  assert.ok(header);
  let lua;
  for (const path of [resolve(dirname(header), 'liblua.a'), resolve(dirname(header), '../lib/liblua.a')]) {
    if (await access(path).then(() => true, () => false)) { lua = path; break; }
  }
  assert.ok(lua);
  await run(link[0], [...link.slice(1).map(a => a === 'winheadless.o' ? `${temp}/winheadless.o` : /lua.*\.a$/.test(a) ? lua : a), '-o', `${temp}/engine`], { cwd });
  return `${temp}/engine`;
}
