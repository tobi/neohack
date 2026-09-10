import {read, update} from './storage.ts';
import {ledgerRun, renameLedgerRun} from './ledger-store.ts';
import {publishManifest} from './protocol-replays.ts';
import {publicReplayStorage} from './public-replay-store.ts';
import {displayDocument} from '../.generated/public-names.mjs';

/** Operator-only correction of derived presentation, never journal contents.
 * Repeating an interrupted operation repairs remaining projections. */
export async function renamePublicRun(id: string, original: string, name: string) {
  const run = await ledgerRun(id);
  if (!run || (run.name !== original && !(run.name === name && run.nameOverride?.original === original)))
    throw Error('Run name changed; review before renaming');
  const correction = {original, name};
  await renameLedgerRun(id, original, name);
  if (await read('input-runs/' + id + '.json')) {
    await update<any,void>('input-runs/' + id + '.json', () => {throw Error('Missing input head');}, doc => {
      if (JSON.stringify(doc.nameOverride) === JSON.stringify(correction)) return;
      doc.nameOverride = correction;
      doc.generation++;
    });
    await publishManifest(id);
  }
  const store = publicReplayStorage(true), path = 'chronicles/' + id + '/story.json';
  const story = await store.read(path);
  if (story) {
    const corrected = displayDocument(story.value, correction);
    if (JSON.stringify(corrected) !== JSON.stringify(story.value))
      await store.write(path, corrected, story.etag);
  }
  return {id, name, chronicle: !!story};
}
