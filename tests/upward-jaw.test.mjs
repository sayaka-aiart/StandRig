import assert from 'node:assert/strict';
import {ContourShadeProcessor,validateContourShade} from '@standrig/core/contourShade';
const width=101,height=101,source={width,height,data:new Uint8ClampedArray(width*height*4)};
for(let x=5;x<96;x++){const bottom=Math.round(98-Math.abs(x-50)*.3);for(let y=5;y<=bottom;y++)source.data.set(y>bottom-3?[70,40,35,180]:[230,210,200,255],(y*width+x)*4);}
const pristine=source.data.slice(),shade={color:'#96606e',width:.24,strength:.38,axisStrength:.8,yawParameter:'X',pitchParameter:'Y',maxYaw:30,maxPitch:30,profile:'cheek',nearContourFade:1,upContourFade:.96,upShadowStrength:.24};
const p=new ContourShadeProcessor(source,shade),legacy=new ContourShadeProcessor(source,{...shade,upContourFade:0,upShadowStrength:0}),px=(r,x,y)=>r.data[(y*width+x)*4];
const up=p.render({X:0,Y:-30});assert(px(up,50,97)>180,'upward central jaw ink must yield to skin');assert(px(up,50,92)<230,'broad shadow replaces the jaw line');assert.equal(px(up,50,70),230,'mouth/central face skin is untouched');
for(const y of [0,15,30])for(const x of [-30,0,30])assert.deepEqual(p.render({X:x,Y:y}).data,legacy.render({X:x,Y:y}).data,'neutral/downward and yaw-only must be exact');
for(let x=0;x<width;x++)for(let y=0;y<height;y++)assert.equal(px(up,x,y),px(up,width-1-x,y),'pitch-only effect must be symmetric');
let last=70;for(let y=0;y>=-30;y--){const r=p.render({X:0,Y:y}),v=px(r,50,97);assert(v>=last);assert(v-last<12);last=v;for(let i=3;i<pristine.length;i+=4)assert.equal(r.data[i],pristine[i],'alpha must stay unchanged');}
for(const key of ['upContourFade','upShadowStrength'])for(const value of [-1,2,NaN,Infinity])assert(!validateContourShade({...shade,[key]:value}));
const shadowOnly=new ContourShadeProcessor(source,{...shade,strength:0,nearContourFade:0,upContourFade:0});assert(px(shadowOnly.render({Y:-30}),50,92)<230);
assert.deepEqual(source.data,pristine);console.log('Upward jaw: pitch sign, progressive fade, broad shadow, symmetry, unchanged neutral/down/yaw and alpha passed.');
