import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeCanvas, writePsdUint8Array } from 'ag-psd';
import { createRigFromPsdFile } from '@standrig/core/importers';
import { encodePng } from '@standrig/core/png';

// Pixel-only canvas adapter for parser tests. Actual browser rendering is checked separately.
initializeCanvas((width,height) => {
  let pixels={width,height,data:new Uint8ClampedArray(width*height*4)};
  return {width,height,getContext:()=>({
    createImageData:(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}),
    putImageData:data=>{pixels=data;},getImageData:()=>pixels
  }),toDataURL:()=> 'data:image/png;base64,'+Buffer.from(encodePng(pixels)).toString('base64')};
});
const layer=(name,alpha=255)=>({name,left:0,top:0,imageData:{width:8,height:8,data:new Uint8ClampedArray(Array.from({length:64},()=>[40,140,180,alpha]).flat())}});
const psd=children=>new File([writePsdUint8Array({width:16,height:16,children},{generateThumbnail:false})],'test.psd');
test('layered PSD preserves separate part names and pixels', async()=>{
  const rig=await createRigFromPsdFile(psd([{name:'Face',children:[layer('Eye'),layer('Mouth')]}]));
  assert.equal(rig.assets.length,2);
  assert.ok(rig.parts.some(p=>p.name==='Eye'));
  assert.ok(rig.parts.some(p=>p.name==='Mouth'));
  assert.ok(rig.assets.every(a=>a.src.startsWith('data:image/png;base64,')));
});
test('flattened, single or empty extra layer does not pass parts requirement',async()=>{
  for(const layers of [[],[layer('Single')],[layer('Single'),layer('Empty',0)]]) await assert.rejects(()=>createRigFromPsdFile(psd(layers)),/パーツ分け済みPSDのみ/);
});
test('PNG and invalid/PSB headers rejected before image import',async()=>{
  await assert.rejects(()=>createRigFromPsdFile(new File([new Uint8Array(32)],'image.png')),/PSDのみ/);
  await assert.rejects(()=>createRigFromPsdFile(new File([new Uint8Array(32)],'bad.psd')),/有効なPSD/);
  const bytes=new Uint8Array(await psd([layer('A'),layer('B')]).arrayBuffer()); bytes[5]=2;
  await assert.rejects(()=>createRigFromPsdFile(new File([bytes],'large.psd')),/PSBは未対応/);
});
