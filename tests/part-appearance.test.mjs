import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_TRANSFORM} from '@standrig/core/types';
import {encodePng,decodePng} from '@standrig/core/png';
import {renderRigScreenshot,screenshotOptionsFromUrl} from '@standrig/core/serverRenderer';
import {resolvePartDrawOrder,sortPartsByDrawOrder} from '@standrig/core/drawOrder';
import {resolvePartBlendColors,applyBlendColorChannel} from '@standrig/core/blendColors';
import {validateRig} from '@standrig/core/inspect';

const solid=(id,rgba)=>({id,name:id,type:'image',width:4,height:4,src:'data:image/png;base64,'+Buffer.from(encodePng({width:4,height:4,data:new Uint8ClampedArray(Array.from({length:16},()=>rgba).flat())})).toString('base64')});
const part=(id,assetId,drawOrder,extra={})=>({id,name:id,kind:'image',parentId:null,assetId,visible:true,drawOrder,transform:{...DEFAULT_TRANSFORM,x:32,y:32,scaleX:8,scaleY:8},...extra});
const rigOf=(parts,assets)=>({schemaVersion:'0.1.0',name:'compat',stage:{width:64,height:64,background:'transparent'},
 parameters:[{id:'Toggle',label:'Toggle',min:0,max:1,default:0},{id:'Mix',label:'Mix',min:0,max:1,default:0}],assets,parts,deformers:[],physics:{enabled:false,chains:[]}});
async function centerPixel(rig,values){
 const options=screenshotOptionsFromUrl(rig,new URL('http://localhost/api/screenshot?width=64&height=64&padding=0&physics=0'));
 const shot=decodePng((await renderRigScreenshot(rig,'.',{...options,values:{...options.values,...values}})).png);
 const index=(32*shot.width+32)*4;return [...shot.data.slice(index,index+4)];
}

test('keyed draw order interpolates linearly and truncates on request',()=>{
 const binding={parameters:['Toggle'],keyforms:[{inputs:{Toggle:0},value:400},{inputs:{Toggle:1},value:600}]};
 assert.equal(resolvePartDrawOrder({drawOrder:7,drawOrderBinding:binding},{Toggle:.25}),450);
 assert.equal(resolvePartDrawOrder({drawOrder:7,drawOrderBinding:{...binding,rounding:'truncate'}},{Toggle:.2537}),450);
 // A multilinear blend that lands a hair under an integer still ties with it.
 assert.equal(resolvePartDrawOrder({drawOrder:7,drawOrderBinding:{parameters:['Toggle'],keyforms:[{inputs:{Toggle:0},value:499.99997},{inputs:{Toggle:1},value:499.99997}],rounding:'truncate'}},{}),500);
 assert.equal(resolvePartDrawOrder({drawOrder:7},{Toggle:1}),7);
 assert.equal(resolvePartDrawOrder({drawOrder:7,drawOrderBinding:{parameters:['Toggle'],keyforms:[]}},{Toggle:1}),7);
});

test('keyed sorting is stable: equal draw orders keep part order',()=>{
 const a={id:'a',drawOrder:500},b={id:'b',drawOrder:500,drawOrderBinding:{parameters:['Toggle'],keyforms:[{inputs:{Toggle:0},value:500},{inputs:{Toggle:1},value:300}],rounding:'truncate'}},c={id:'c',drawOrder:400};
 assert.deepEqual(sortPartsByDrawOrder([a,b,c],{Toggle:0}).map(p=>p.id),['c','a','b']);
 assert.deepEqual(sortPartsByDrawOrder([a,b,c],{Toggle:1}).map(p=>p.id),['b','c','a']);
});

test('the renderer paints by the keyed draw order of the current pose',async()=>{
 const rig=rigOf([
  part('red','r',500,{drawOrderBinding:{parameters:['Toggle'],keyforms:[{inputs:{Toggle:0},value:400},{inputs:{Toggle:1},value:600}],rounding:'truncate'}}),
  part('blue','b',500)],[solid('r',[255,0,0,255]),solid('b',[0,0,255,255])]);
 assert.deepEqual(await centerPixel(rig,{Toggle:0}),[0,0,255,255]);
 assert.deepEqual(await centerPixel(rig,{Toggle:1}),[255,0,0,255]);
});

test('multiply and screen colors apply multiply then screen, statically and keyed',async()=>{
 assert.equal(applyBlendColorChannel(200,.5,0),100);
 assert.equal(applyBlendColorChannel(100,1,.5),Math.round(255*(100/255+.5-100/255*.5)));
 assert.equal(resolvePartBlendColors({blendColors:{multiply:[1,1,1],screen:[0,0,0]}},{}),undefined);
 const keyed={parameters:['Mix'],keyforms:[{inputs:{Mix:0},multiply:[1,1,1]},{inputs:{Mix:1},multiply:[0,1,1],screen:[0,0,.5]}]};
 assert.deepEqual(resolvePartBlendColors({blendColors:keyed},{Mix:.5}),{multiply:[.5,1,1],screen:[0,0,.25]});
 const rig=rigOf([part('gray','g',0,{blendColors:keyed})],[solid('g',[200,200,200,255])]);
 assert.deepEqual(await centerPixel(rig,{Mix:0}),[200,200,200,255]);
 assert.deepEqual(await centerPixel(rig,{Mix:1}),[0,200,Math.round(255*(200/255+.5-200/255*.5)),255]);
});

test('validation accepts the new fields, rejects broken grids and allows up to 32 clip masks',()=>{
 const masks=Array.from({length:16},(_,i)=>part('m'+i,'g',i));
 const ok=rigOf([...masks,part('clipped','g',100,{clip:{mode:'alpha',maskPartIds:masks.map(m=>m.id)},
  drawOrderBinding:{parameters:['Toggle','Mix'],keyforms:[0,1].flatMap(Toggle=>[0,1].map(Mix=>({inputs:{Toggle,Mix},value:Toggle+Mix})))},
  blendColors:{screen:[.1,.2,.3]}})],[solid('g',[1,2,3,255])]);
 const codes=r=>validateRig(r).issues.filter(i=>i.severity==='error').map(i=>i.code);
 assert.deepEqual(codes(ok).filter(c=>/clip|draw-order|blend-colors/.test(c)),[]);
 const broken=structuredClone(ok);const clipped=broken.parts.at(-1);
 clipped.drawOrderBinding.keyforms.pop();clipped.blendColors={parameters:['Nope'],keyforms:[{inputs:{Nope:0}},{inputs:{Nope:1}}]};
 clipped.clip.maskPartIds=Array.from({length:33},(_,i)=>'x'+i);
 assert.deepEqual(['invalid-draw-order-binding','invalid-blend-colors','invalid-clip-mask-parts'].filter(c=>!codes(broken).includes(c)),[]);
});

test('draw order groups sort their members as one slot (front/back legs)',async()=>{
 const {sortPartsForPaint}=await import('@standrig/core/drawOrder');
 const g=(id,parentId,drawOrder,extra={})=>({id,parentId,kind:'group',drawOrder,drawOrderGroup:true,...extra});
 const i=(id,parentId,drawOrder=500)=>({id,parentId,kind:'image',drawOrder});
 const swap={parameters:['Hip'],keyforms:[{inputs:{Hip:-30},value:499},{inputs:{Hip:30},value:501}],rounding:'truncate'};
 // Panel order: before, legs{ back-leg{a1,a2}, front-leg{b1} }, after, plus a plain (ungrouped) folder that sorts flat.
 const all=[i('before',null),{id:'folder',parentId:null,kind:'group',drawOrder:0},g('legs',null,500),g('legA','legs',499,{drawOrderBinding:swap}),i('a1','legA'),i('a2','legA',400),g('legB','legs',500),i('b1','legB'),i('after',null),i('inFolder','folder',450)];
 const images=all.filter(p=>p.kind==='image');
 const order=v=>sortPartsForPaint(all,images,v).map(p=>p.id).join(' ');
 assert.equal(order({Hip:-30}),'inFolder before a2 a1 b1 after');
 assert.equal(order({Hip:15}),'inFolder before a2 a1 b1 after');   // 500.5 truncates to 500: ties keep panel order
 assert.equal(order({Hip:30}),'inFolder before b1 a2 a1 after');
 // Without any group flag the same parts sort flat, ties in array order.
 assert.equal(sortPartsForPaint(all.map(p=>({...p,drawOrderGroup:undefined})),images,{}).map(p=>p.id).join(' '),'a2 inFolder before a1 b1 after');
});

test('an inverted clip shows the content only where its masks do not cover it',async()=>{
 // A full red square clipped by a half-coverage mask (left half opaque, right half clear).
 const half={id:'half',name:'half',type:'image',width:4,height:4,src:'data:image/png;base64,'+Buffer.from(encodePng({width:4,height:4,data:new Uint8ClampedArray(Array.from({length:16},(_,i)=>i%4<2?[255,255,255,255]:[0,0,0,0]).flat())})).toString('base64')};
 const make=(invert)=>rigOf([part('mask','half',0,{visible:false}),part('content','red',1,{clip:{mode:'alpha',maskPartIds:['mask'],maskOpacity:'ignore',...(invert===undefined?{}:{invert})}})],[half,solid('red',[255,0,0,255])]);
 const pixelAt=async(rig,x)=>{const options=screenshotOptionsFromUrl(rig,new URL('http://localhost/api/screenshot?width=64&height=64&padding=0&physics=0'));const shot=decodePng((await renderRigScreenshot(rig,'.',options)).png);return shot.data[(32*shot.width+x)*4+3];};
 // The 4 px images are drawn 32 px wide around the centre: x 16..31 is the mask's opaque half, 32..47 its clear half.
 assert.equal(await pixelAt(make(),20),255);assert.equal(await pixelAt(make(),44),0);
 assert.equal(await pixelAt(make(true),20),0);assert.equal(await pixelAt(make(true),44),255);
 assert.equal(await pixelAt(make(false),44),0,'invert:false is a normal clip');
 const codes=r=>validateRig(r).issues.filter(i=>i.severity==='error').map(i=>i.code);
 assert.deepEqual(codes(make(true)).filter(c=>/clip/.test(c)),[]);
 const broken=make(true);broken.parts[1].clip.invert='yes';
 assert.ok(codes(broken).includes('invalid-clip-invert'));
 // Inverted and normal clips over the same masks are separate clip groups.
 const {sameResolvedPartClip,createPartClipResolver}=await import('@standrig/core/mask');
 const both=rigOf([part('mask','half',0),part('a','red',1,{clip:{mode:'alpha',maskPartIds:['mask']}}),part('b','red',2,{clip:{mode:'alpha',maskPartIds:['mask'],invert:true}})],[half,solid('red',[255,0,0,255])]);
 const resolve=createPartClipResolver(both);
 assert.equal(sameResolvedPartClip(resolve(both.parts[1]),resolve(both.parts[2])),false);
});
