import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSharedWarpSampler,sampleSharedWarpField} from '../packages/core/dist/sharedWarp.js';
import {createSharedWarpProjector,projectSharedWarpPoint} from '../packages/core/dist/sharedWarpProjection.js';
const field={version:1,enabled:true,bounds:{left:-10,top:-20,width:100,height:80},grid:{columns:2,rows:2},controlPoints:[{id:'a',column:0,row:0,offsetX:3,offsetY:-4},{id:'b',column:1,row:1,offsetX:8,offsetY:9},{id:'c',column:2,row:2,offsetX:20,offsetY:-5,enabled:false},{id:'d',column:1,row:1,offsetX:-3,offsetY:2}]};
test('prepared projection exactly matches reference with nested, sparse, duplicate and disabled controls',()=>{
 const part={a:.8,b:.3,c:-.2,d:1.2,e:14,f:-9},base={a:2,b:.1,c:.2,d:1.5,e:40,f:20};
 for(const fields of [undefined,[],[field],[field,{...field,enabled:false}],[field,{...field,bounds:{...field.bounds,left:30}}]]){
 const project=createSharedWarpProjector(part,base,fields);
 for(let x=-100;x<=200;x+=7)for(let y=-100;y<=200;y+=11)assert.deepEqual(project({x,y}),projectSharedWarpPoint({x,y},part,base,fields));
 }
});
test('prepared samples are frame snapshots and rebuilding sees edits',()=>{
 const f=structuredClone(field),sample=createSharedWarpSampler(f),before=sample(40,20);
 assert.deepEqual(before,sampleSharedWarpField(f,40,20));
 f.controlPoints[3].offsetX=50;f.bounds.width=120;
 assert.deepEqual(sample(40,20),before);assert.deepEqual(createSharedWarpSampler(f)(40,20),sampleSharedWarpField(f,40,20));
 assert.notDeepEqual(sampleSharedWarpField(f,40,20),before);
});
