import {rebuildLedgerSummaries} from '../src/ledger-store.ts';
if(process.argv.slice(2).some(arg=>arg!=='--apply'))throw Error('Usage: node scripts/rebuild-ledger.mjs [--apply]');
if(process.argv.includes('--apply'))console.log(JSON.stringify(await rebuildLedgerSummaries()));
else console.log('Pass --apply to rebuild public summaries additively from authoritative run records. No records are deleted.');
