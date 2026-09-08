/* Exact-package WASM checkpoints. Used only at quiescent protocol boundaries. */
Module['nnhCheckpoint'] = {
  capture() {
    if (Asyncify.state !== 0 || Asyncify.exportCallStack.length) throw Error('Engine is not at a checkpoint boundary');
    // Trailing zero pages need no bytes in an immutable checkpoint. Preserve
    // the original capacity separately, including allocator-owned zero pages.
    var last=HEAPU32.length;while(last&&HEAPU32[last-1]===0)last--;
    return {memory:HEAPU8.slice(0,last*4),memorySize:HEAPU8.byteLength,stack:stackSave(),asyncData:Asyncify.currData};
  },
  restore(value) {
    if (Asyncify.state !== 0 || Asyncify.exportCallStack.length) throw Error('Engine is not at a checkpoint boundary');
    if (!!Asyncify.currData !== !!value.asyncData) throw Error('Checkpoint continuation differs');
    if(!(value.memory instanceof Uint8Array)||!Number.isSafeInteger(value.memorySize)||value.memorySize%65536||value.memorySize<65536||value.memorySize>256*1024*1024||value.memory.byteLength>value.memorySize||!Number.isSafeInteger(value.stack)||value.stack<0||value.stack>=value.memorySize||value.asyncData!==null&&(!Number.isSafeInteger(value.asyncData)||value.asyncData<0||value.asyncData+12>=value.memorySize))throw Error('Invalid checkpoint memory');
    if(value.memorySize>HEAPU8.byteLength){wasmMemory.grow((value.memorySize-HEAPU8.byteLength)/65536);updateMemoryViews();}
    HEAPU8.fill(0);HEAPU8.set(value.memory);stackRestore(value.stack);Asyncify.currData=value.asyncData;
  }
};
