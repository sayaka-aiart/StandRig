import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWebGLPartGeometry } from '../packages/runtime/dist/webglGeometry.js';
import { normalizeWarpDeformer, warpPoint } from '../packages/core/dist/warp.js';
import { transformMatrixPoint } from '../packages/core/dist/evaluator.js';

test('GPU geometry applies warp, shared projection, stitch and screen transform in Canvas order', () => {
  const matrix={a:2,b:.2,c:-.3,d:1.1,e:5,f:8};
  const warp=normalizeWarpDeformer({enabled:true,grid:{columns:2,rows:2},bendX:.2});
  const mesh={vertices:[{id:'v',x:20,y:30,u:.2,v:.3}],triangles:[]};
  const project=p=>({x:p.x+7,y:p.y-3});
  const options={left:-50,top:-40,width:100,height:100,matrix,warp,mesh,project,stitchOffsets:new Map([['v',{dx:4,dy:-2}]])};
  const actual=buildWebGLPartGeometry(options).vertices[0];
  const warped=warpPoint(-30,-10,{left:-50,top:-40,width:100,height:100},warp);
  const projected=project(warped);
  assert.deepEqual(actual,{...transformMatrixPoint(matrix,projected.x+4,projected.y-2),u:.2,v:.3});
});

test('GPU fallback grid preserves Canvas diagonal, UVs, dimensions and shared vertices', () => {
  const result=buildWebGLPartGeometry({left:10,top:20,width:80,height:60,matrix:{a:1,b:0,c:0,d:1,e:0,f:0},sharedGrid:{columns:2,rows:3}});
  assert.equal(result.vertices.length,12);
  assert.equal(result.triangles.length,36);
  assert.deepEqual(result.triangles.slice(0,6),[0,1,4,0,4,3]);
  assert.deepEqual(result.vertices[0],{x:10,y:20,u:0,v:0});
  assert.deepEqual(result.vertices.at(-1),{x:90,y:80,u:1,v:1});
  assert.ok(result.triangles.every(i=>i>=0&&i<result.vertices.length));
});
