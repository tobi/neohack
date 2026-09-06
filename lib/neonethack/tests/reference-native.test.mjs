import { fixture, root } from './native-fixture.mjs';
import { referenceContracts } from './reference-client-contracts.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
referenceContracts('native', async t => {
  const backend = await fixture(t);
  // Actual local runtime inputs, not protocol libraryVersion or source HEAD.
  // Installed releases should use their matching complete release manifest.
  const manifest = {};
  for (const path of ['build/native/neonethack', 'engine/playground/nethack',
    'engine/playground/nhdat', 'engine/playground/symbols', 'engine/playground/sysconf']) {
    manifest[path] = createHash('sha256').update(await readFile(`${root}/${path}`)).digest('hex');
  }
  return { ...backend, packageId: `local-native-inputs-sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}` };
});
