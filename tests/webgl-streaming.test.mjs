import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebGLArtMeshRenderer } from '../packages/runtime/dist/webglMesh.js';

test('WebGL streaming reuses capacity, uploads edits and rebuilds buffers after context restoration', () => {
  const allocations = [], uploads = [], events = {};
  const gl = new Proxy({}, { get(_, key) {
    if (key === 'getExtension') return () => null;
    if (key === 'isContextLost') return () => false;
    if (key === 'finish') return () => assert.fail('synchronous finish');
    if (key === 'bufferData') return (...args) => allocations.push(args);
    if (key === 'bufferSubData') return (target, offset, data, start, length) => uploads.push({target, values: [...data.slice(start, start + length)]});
    if (String(key).startsWith('create') || key === 'getUniformLocation') return () => ({});
    if (key === 'getShaderParameter' || key === 'getProgramParameter') return () => true;
    if (String(key).toUpperCase() === key) return key;
    return () => {};
  }});
  const canvas = {width:100,height:100,getContext:()=>gl,addEventListener:(name,fn)=>{events[name]=fn;}};
  const target = {canvas,save(){},restore(){},setTransform(){},drawImage(){}};
  const renderer = new WebGLArtMeshRenderer(canvas);
  const original = globalThis.HTMLCanvasElement;
  globalThis.HTMLCanvasElement = class {};
  try {
    const image = {}, vertices = [{x:0,y:0,u:0,v:0},{x:10,y:0,u:1,v:0},{x:0,y:10,u:0,v:1}];
    assert.equal(renderer.draw(target,image,vertices,[0,1,2],1),true);
    assert.equal(allocations.length,2);
    vertices[0].x=5;
    renderer.draw(target,image,vertices,[2,1,0],1);
    assert.equal(allocations.length,2);
    assert.equal(uploads.at(-2).values[0],5);
    assert.deepEqual(uploads.at(-1).values,[2,1,0]);
    renderer.draw(target,image,[...vertices,vertices[0]],[0,1,2,1,2,3],1);
    assert.equal(allocations.length,4);
    renderer.draw(target,image,vertices,[0,1,2],1);
    assert.equal(allocations.length,4);
    assert.equal(uploads.at(-2).values.length,12);
    events.webglcontextlost({preventDefault(){}});
    assert.equal(renderer.draw(target,image,vertices,[0,1,2],1),false);
    events.webglcontextrestored();
    assert.equal(renderer.draw(target,image,vertices,[0,1,2],1),true);
    assert.equal(allocations.length,6);
    renderer.dispose();
    assert.equal(renderer.draw(target,image,vertices,[0,1,2],1),false);
    renderer.dispose();
  } finally {
    if(original === undefined) delete globalThis.HTMLCanvasElement;
    else globalThis.HTMLCanvasElement=original;
  }
});
