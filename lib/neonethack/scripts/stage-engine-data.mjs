import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const stage = process.argv[2];
if (!stage) throw Error('stage directory required');
await mkdir(`${stage}/nh/save`, { recursive: true });
for (const name of ['nhdat', 'sysconf', 'symbols', 'license']) {
  const source = name === 'license' ? `${root}/engine/dat/license` : `${root}/engine/playground/${name}`;
  let data = await readFile(source);
  if (name === 'sysconf') {
    // Browser workers have no host grep/compressor/debugger binaries. Preserve all other
    // engine policy; do not copy transient logs, bones, saves or private files.
    data = Buffer.from(data.toString('utf8').split('\n').filter(line => !/^(GREPPATH|COMPRESS|GDBPATH)=/.test(line)).join('\n'));
  }
  await writeFile(`${stage}/nh/${name}`, data);
}
for (const name of ['logfile', 'record', 'xlogfile', 'perm']) await writeFile(`${stage}/nh/${name}`, '');
await writeFile(`${stage}/ready`, 'static engine data\n');
