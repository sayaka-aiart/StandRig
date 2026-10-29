import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSharedWarpSampler, sampleSharedWarpField} from '../packages/core/dist/sharedWarp.js';

function fixture(columns, rows) {
  const controlPoints=[];
  for(let row=0;row<=rows;row++) for(let column=0;column<=columns;column++) {
    if((column+row)%4===0) continue;
    controlPoints.push({id:`${column}-${row}`,column,row,offsetX:column*.7-row*2.1,offsetY:row*.3+column*1.9,enabled:(column+row)%5!==0});
  }
  controlPoints.push({id:'last-disabled',column:1,row:1,offsetX:123,offsetY:456,enabled:false});
  // Out-of-grid coordinates must not alias a neighboring row in the dense table.
  controlPoints.push({id:'outside',column:columns+1,row:0,offsetX:999,offsetY:999});
  return {version:1,enabled:true,bounds:{left:-23,top:17,width:117,height:83},grid:{columns,rows},controlPoints};
}

test('dense sampling exactly matches reference at every supported grid size, boundaries and sparse/duplicate controls',()=>{
  for(let columns=1;columns<=16;columns++) for(let rows=1;rows<=16;rows++) {
    const f=fixture(columns,rows),sample=createSharedWarpSampler(f);
    for(const x of [-100,-23,-1.25,0,39.3,94,200]) for(const y of [-100,17,19.7,58.5,100,200]) {
      assert.deepEqual(sample(x,y),sampleSharedWarpField(f,x,y));
    }
  }
});

test('compiled coordinates, enabled state and grid remain snapshots while rebuilding observes edits',()=>{
  const f=fixture(2,3),sample=createSharedWarpSampler(f),before=sample(13,49);
  f.controlPoints[0].offsetX=98;f.controlPoints[0].row=2;f.controlPoints.push({id:'new',column:0,row:0,offsetX:45,offsetY:25});
  f.grid.columns=4;f.bounds.left=12;
  assert.deepEqual(sample(13,49),before);
  assert.deepEqual(createSharedWarpSampler(f)(13,49),sampleSharedWarpField(f,13,49));
  f.enabled=false;
  assert.deepEqual(createSharedWarpSampler(f)(13,49),{x:0,y:0});
  assert.deepEqual(sample(13,49),before);
});

test('nonstandard grids retain reference sampling without unbounded table allocation',()=>{
  for(const [columns,rows] of [[0,0],[1.5,2],[17,2],[1000000,2]]) {
    const f=fixture(2,2);f.grid={columns,rows};const sample=createSharedWarpSampler(f);
    for(const [x,y] of [[-23,17],[20,40],[94,100]]) assert.deepEqual(sample(x,y),sampleSharedWarpField(f,x,y));
  }
});
