import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_TRANSFORM} from '@standrig/core/types';
import {createRectArtMesh} from '@standrig/core/artMesh';
import {encodePng,decodePng} from '@standrig/core/png';
import {renderRigScreenshot,screenshotOptionsFromUrl} from '@standrig/core/serverRenderer';
test('stationary canonical meshes retain identical pixels when a distant shared warp is active',async()=>{
 const asset={id:'a',name:'pixel',type:'image',width:4,height:4,src:'data:image/png;base64,'+Buffer.from(encodePng({width:4,height:4,data:new Uint8ClampedArray(Array.from({length:16},(_,i)=>[40+i*5,100,200,128]).flat())})).toString('base64')};
 const rig={schemaVersion:'0.1.0',name:'foot test',stage:{width:64,height:64,background:'transparent'},parameters:[{id:'ParamAngleX',label:'X',min:-30,max:30,default:0}],assets:[asset],parts:[{id:'p',name:'Foot',kind:'image',parentId:null,assetId:'a',visible:true,drawOrder:0,deformerId:'d',transform:{...DEFAULT_TRANSFORM,x:20.3,y:40.2,scaleX:3.1,scaleY:3.1},artMesh:createRectArtMesh(4,4,{preset:'outline',columns:3,rows:3})}],deformers:[{id:'d',name:'upper only',kind:'warp',parentId:null,visible:true,origin:{x:0,y:0},transform:{...DEFAULT_TRANSFORM},sharedWarp:{version:1,enabled:true,bounds:{left:0,top:0,width:64,height:10},grid:{columns:1,rows:1},controlPoints:[{id:'a',column:0,row:0,offsetX:0,offsetY:0,bindings:[{parameter:'ParamAngleX',property:'offsetX',keys:[{input:0,value:0},{input:30,value:10}]}]},{id:'b',column:1,row:0,offsetX:0,offsetY:0},{id:'c',column:0,row:1,offsetX:0,offsetY:0},{id:'e',column:1,row:1,offsetX:0,offsetY:0}]}}],physics:{enabled:false,chains:[]}};
 const options=screenshotOptionsFromUrl(rig,new URL('http://localhost/api/screenshot?width=96&height=96&padding=0&physics=0'));
 const a=await renderRigScreenshot(rig,'.',options),b=await renderRigScreenshot(rig,'.',{...options,values:{...options.values,ParamAngleX:30}});
 assert.deepEqual(decodePng(a.png).data,decodePng(b.png).data);
});
