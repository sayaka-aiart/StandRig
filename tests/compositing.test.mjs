import {test} from 'node:test';
import assert from 'node:assert/strict';
import {blendChannel,compositeRgba,layerCompositingPlan,paintLayerPlan} from '@standrig/core/compositing';
const pixel=(r,g,b,a=255)=>({width:1,height:1,data:new Uint8ClampedArray([r,g,b,a])});
const part=(id,color,options={})=>({id,name:id,kind:'image',parentId:null,visible:true,drawOrder:0,color,opacity:1,...options});
function render(parts){
 const output=pixel(0,0,0,0),byId=new Map(parts.map(p=>[p.id,p]));
 const state=p=>({visible:p.visible,opacity:p.opacity*(p.parentId?state(byId.get(p.parentId)).opacity:1)});
 paintLayerPlan(layerCompositingPlan({parts}),output,{create:()=>pixel(0,0,0,0),release:()=>{},state,
 draw:(target,p,scale,mode)=>compositeRgba(target,pixel(...p.color),mode,state(p).opacity*scale),compose:compositeRgba,
 mask:(surface,p)=>{surface.data[3]=Math.round(surface.data[3]*byId.get(p.rasterMaskPartId).color[3]/255);}});return [...output.data];
}
test('separable modes follow boundary cases and soft-light branches',()=>{
 assert.equal(blendChannel(0,1,'color-dodge'),0);assert.equal(blendChannel(.4,1,'color-dodge'),1);
 assert.equal(blendChannel(.2,.5,'overlay'),.2);assert.equal(blendChannel(.8,.5,'overlay'),.8);
 assert.equal(blendChannel(.25,0,'soft-light'),.0625);assert.equal(blendChannel(.25,1,'soft-light'),.5);
 assert.equal(blendChannel(.81,1,'soft-light'),.9);
});
test('clipped multiply keeps the base color backdrop and its partial alpha',()=>{
 assert.deepEqual(render([part('base',[200,100,50,128]),part('shadow',[128,128,128],{drawOrder:1,blendMode:'multiply',clippingBaseId:'base'})]),[100,50,25,128]);
});
test('normal clipping cannot expand alpha and applies base opacity only once',()=>{
 assert.deepEqual(render([part('base',[255,0,0],{opacity:.5}),part('overlay',[0,255,0],{drawOrder:1,clippingBaseId:'base'})]),[0,255,0,128]);
 assert.deepEqual(render([part('base',[255,0,0,0]),part('overlay',[0,255,0],{drawOrder:1,clippingBaseId:'base'})]),[0,0,0,0]);
});
test('isolated group opacity applies after overlapping children',()=>{
 assert.deepEqual(render([part('group',null,{kind:'group',opacity:.5,compositing:'isolate'}),part('a',[255,0,0],{parentId:'group'}),part('b',[0,0,255],{parentId:'group',drawOrder:1})]),[0,0,255,128]);
});
test('group blend applies to merged children against the external backdrop',()=>{
 assert.deepEqual(render([part('bg',[200,100,50]),part('g',null,{kind:'group',drawOrder:1,compositing:'isolate',blendMode:'multiply'}),part('a',[128,128,128],{parentId:'g'}),part('b',[64,64,64],{parentId:'g',drawOrder:1})]),[50,25,13,255]);
});
test('hidden clipping bases and hidden ancestor groups hide their clipped content',()=>{
 assert.deepEqual(render([part('base',[255,0,0],{visible:false}),part('overlay',[0,255,0],{drawOrder:1,clippingBaseId:'base'})]),[0,0,0,0]);
 assert.deepEqual(render([part('g',null,{kind:'group',visible:false,compositing:'isolate'}),part('a',[255,0,0],{parentId:'g'})]),[0,0,0,0]);
});
test('a soft raster mask applies once to merged group content before group opacity',()=>{
 assert.deepEqual(render([part('mask',[255,255,255,128],{visible:false}),part('g',null,{kind:'group',opacity:.5,compositing:'isolate',rasterMaskPartId:'mask'}),part('a',[255,0,0],{parentId:'g'}),part('b',[0,0,255],{parentId:'g',drawOrder:1})]),[0,0,255,64]);
});
