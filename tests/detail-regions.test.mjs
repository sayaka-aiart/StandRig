import {test} from 'node:test';
import assert from 'node:assert/strict';
import {detailRegionForRig} from '@standrig/core/detailRegions';
import {DEFAULT_TRANSFORM} from '@standrig/core/types';
const make=(x,y,hidden=false)=>({stage:{width:4000,height:8000},assets:[{id:'a',width:300,height:600}],parameters:[],parts:[{id:'g',name:'Group',kind:'group',parentId:null,visible:!hidden,transform:{...DEFAULT_TRANSFORM,x,y}},{id:'p',name:'Neck',kind:'image',parentId:'g',visible:true,assetId:'a',tags:['neck'],transform:{...DEFAULT_TRANSFORM,x:1500,y:1600}}]});
test('detail QA regions follow ancestor translations rather than cropping empty source coordinates',()=>{
 const neutral=detailRegionForRig(make(0,0),'neck'),translated=detailRegionForRig(make(400,100),'neck');
 assert.equal(translated.rect.x-neutral.rect.x,400);assert.equal(translated.rect.y-neutral.rect.y,100);assert.equal(translated.rect.width,neutral.rect.width);assert.equal(translated.rect.height,neutral.rect.height);
});
test('hidden ancestor folders do not enlarge QA detail regions',()=>{assert.equal(detailRegionForRig(make(0,0,true),'neck').partIds.length,0);});
