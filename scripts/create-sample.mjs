import { writeFile } from 'node:fs/promises';
import { createBlankRgba, encodePng } from '@standrig/core/png';
import { DEFAULT_TRANSFORM } from '@standrig/core/types';
import { emptyRig } from './init-empty.mjs';

const rig = emptyRig();
rig.name = 'Sample Bot — geometric API demo';
rig.stage = { width: 320, height: 360, background: 'transparent' };
function layer(id, width, height, color, test = () => true) {
  const image = createBlankRgba(width,height);
  for (let y=0;y<height;y++) for(let x=0;x<width;x++) if(test(x,y)) image.data.set(color,(y*width+x)*4);
  rig.assets.push({ id, name:id, type:'image', width, height, src:'data:image/png;base64,'+Buffer.from(encodePng(image)).toString('base64') });
}
layer('head',112,104,[104,215,190,255],(x,y)=>((x-55.5)/55)**2+((y-51.5)/51)**2<1);
layer('body',88,112,[54,112,154,255],(x,y)=>x>Math.abs(y-55)*0.12 && x<87-Math.abs(y-55)*0.12);
layer('eye',12,20,[20,37,49,255]);
layer('mouth',26,8,[20,37,49,255]);
function part(id,assetId,x,y,parentId='root') {
  const p={id,name:id,kind:'image',parentId,assetId,visible:true,drawOrder:rig.parts.length,transform:{...DEFAULT_TRANSFORM,x,y}};
  rig.parts.push(p);return p;
}
part('body','body',160,242).bindings=[{parameter:'ParamBodyAngleZ',property:'rotation',keys:[{input:-10,value:-10},{input:0,value:0},{input:10,value:10}]}];
rig.parts.push({id:'head-group',name:'Head group',kind:'group',parentId:'root',visible:true,drawOrder:2,transform:{...DEFAULT_TRANSFORM,x:160,y:119,pivotX:0,pivotY:0},bindings:[{parameter:'ParamAngleZ',property:'rotation',keys:[{input:-30,value:-30},{input:0,value:0},{input:30,value:30}]}]});
part('head','head',0,0,'head-group');
for (const [id,x,param] of [['left-eye',-23,'ParamEyeLOpen'],['right-eye',23,'ParamEyeROpen']]) part(id,'eye',x,-7,'head-group').bindings=[{parameter:param,property:'scaleY',keys:[{input:0,value:-0.9},{input:1,value:0}],additive:true}];
part('mouth','mouth',0,26,'head-group').bindings=[{parameter:'ParamMouthOpen',property:'scaleY',keys:[{input:0,value:0},{input:1,value:2}],additive:true}];
await writeFile(new URL('../examples/sample.standrig.json',import.meta.url),JSON.stringify(rig,null,2)+'\n');
