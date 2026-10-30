import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeCanvas, writePsdUint8Array } from 'ag-psd';
import { createRigFromPsdFile } from '@standrig/core/importers';
import { encodePng, decodePng } from '@standrig/core/png';

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
test('PSD clipping stacks reference the preceding sibling base, including group bases',async()=>{
 const rig=await createRigFromPsdFile(psd([{name:'Base',children:[layer('Ink')]},{...layer('Shade'),blendMode:'multiply',clipping:true},{...layer('Glow'),blendMode:'linear dodge',clipping:true},layer('Next'),{...layer('Next shade'),clipping:true}]));
 const p=name=>rig.parts.find(p=>p.name===name);
 assert.equal(p('Shade').clippingBaseId,p('Base').id);assert.equal(p('Glow').clippingBaseId,p('Base').id);
 assert.equal(p('Next shade').clippingBaseId,p('Next').id);assert.equal(p('Glow').blendMode,'additive');
 assert.ok(!rig.metadata.importReport.warnings.some(w=>w.includes('clipping-layer-not-applied')));
});
test('PSD preserves group opacity, isolation and supported highlight modes',async()=>{
 const rig=await createRigFromPsdFile(psd([{name:'G',opacity:.5,blendMode:'multiply',children:[{...layer('Dodge'),blendMode:'color dodge'},{...layer('Soft'),blendMode:'soft light'},{...layer('Overlay'),blendMode:'overlay'}]}]));
 const p=name=>rig.parts.find(p=>p.name===name);
 assert.equal(p('G').compositing,'isolate');assert.equal(p('G').blendMode,'multiply');assert.ok(Math.abs(p('G').transform.opacity-.5)<.005);
 assert.equal(p('Dodge').blendMode,'color-dodge');assert.equal(p('Soft').blendMode,'soft-light');assert.equal(p('Overlay').blendMode,'overlay');
});
test('PSD raster masks retain coordinates, grayscale alpha and group ownership',async()=>{
 const mask={left:2,top:3,defaultColor:0,imageData:{width:2,height:1,data:new Uint8ClampedArray([128,128,128,255,0,0,0,255])}};
 const rig=await createRigFromPsdFile(psd([{name:'G',blendMode:'multiply',mask,children:[layer('A'),layer('B')]}]));
 const group=rig.parts.find(p=>p.name==='G'),source=rig.parts.find(p=>p.id===group.rasterMaskPartId);
 assert.equal(source.visible,false);assert.equal(source.parentId,group.parentId);assert.equal(source.transform.x,2);assert.equal(source.transform.y,3);
 const asset=rig.assets.find(a=>a.id===source.assetId),image=decodePng(Buffer.from(asset.src.split(',')[1],'base64'));
 assert.deepEqual([...image.data],[255,255,255,128,255,255,255,0]);
});
test('disabled PSD raster masks are ignored and unsupported white outside masks are reported',async()=>{
 for(const [disabled,defaultColor,warning]of [[true,0,false],[false,255,true]]){
  const mask={left:0,top:0,disabled,defaultColor,imageData:{width:1,height:1,data:new Uint8ClampedArray([255,255,255,255])}};
  const rig=await createRigFromPsdFile(psd([{...layer('A'),mask},layer('B')]));
  assert.ok(!rig.parts.find(p=>p.name==='A').rasterMaskPartId);
  assert.equal(rig.metadata.importReport.warnings.some(w=>w.includes('unsupported-white-outside-raster-mask')),warning);
 }
});
test('a mask is not a second animation part and orphan clipping is reported',async()=>{
 const mask={left:0,top:0,defaultColor:0,imageData:{width:1,height:1,data:new Uint8ClampedArray([255,255,255,255])}};
 await assert.rejects(()=>createRigFromPsdFile(psd([{...layer('Single'),mask}])),/パーツ分け済みPSDのみ/);
 const rig=await createRigFromPsdFile(psd([{...layer('Orphan'),clipping:true},layer('Next')]));
 assert.ok(rig.metadata.importReport.warnings.some(w=>w.includes('clipping-base-missing')));
});
