import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkpointBuffers,encodeCheckpoint,decodeCheckpoint} from '../../wasm/checkpoint-codec.mjs';

test('checkpoint transfer lists deduplicate shared views and preserve exact sliced bytes',async()=>{
 const buffer=new Uint8Array([11,22,33,44]);
 const value={files:[buffer.subarray(1,3),buffer.subarray(2)],metadata:{empty:null,label:'雪'}};
 assert.deepEqual(checkpointBuffers(value),[buffer.buffer]);
 const encoded=await encodeCheckpoint(value);
 const decoded=await decodeCheckpoint(encoded.bytes,encoded.sha256);
 assert.deepEqual([...decoded.files[0]],[22,33]);
 assert.deepEqual([...decoded.files[1]],[33,44]);
 assert.deepEqual(decoded.metadata,value.metadata);
 assert.equal(checkpointBuffers(decoded).length,1);
});

test('checkpoint metadata and buffer table size limits reject before encoding a packet',async()=>{
 await assert.rejects(encodeCheckpoint({label:'x'.repeat(2*1024*1024)}),/size limit/);
 await assert.rejects(encodeCheckpoint(Array.from({length:10001},()=>new Uint8Array())),/size limit/);
});
