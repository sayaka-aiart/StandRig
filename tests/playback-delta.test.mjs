import {test} from 'node:test';import assert from 'node:assert/strict';
import {PlaybackEncoder,PlaybackDecoder} from '@standrig/runtime/playbackWire';
test('delta playback retains catalogue, merges values and requires a full resync after gaps',()=>{
 const encoder=new PlaybackEncoder(),decoder=new PlaybackDecoder();
 const base={version:1,sessionId:'s',modelVersion:1,revision:0,values:{a:0,b:1},baseValues:{a:0,b:1},playing:true,lastSource:null,parameters:[{id:'a',label:'a'.repeat(1000)}]};
 const full=encoder.encode(base);assert.deepEqual(decoder.accept(full),base);
 const next={...base,revision:1,values:{a:2,b:1},baseValues:{a:2,b:1}};
 const delta=encoder.encode(next);assert.equal(delta.state.parameters,undefined);assert.deepEqual(delta.state.values,{a:2});assert.deepEqual(decoder.accept(delta),next);
 encoder.encode({...next,revision:2});const gap=encoder.encode({...next,revision:3});assert.throws(()=>decoder.accept(gap),/gap/);
 const changed={...next,modelVersion:2,values:{c:3},baseValues:{c:3},parameters:[{id:'c'}]};assert.deepEqual(decoder.accept(encoder.encode(changed)),changed);
});
test('new clients accept an older service full-snapshot SSE response without a reload loop',()=>{
 const decoder=new PlaybackDecoder(),state={version:1,sessionId:'old-service',revision:1,modelVersion:0,playing:true,lastSource:null,values:{a:1},parameters:[{id:'a'}]};
 assert.deepEqual(decoder.accept(state),state);assert.deepEqual(decoder.accept({...state,revision:2,values:{a:2}}).values,{a:2});
 assert.throws(()=>decoder.accept({protocol:2,kind:'unknown',sequence:1,state:{}}),/Invalid/);
});
