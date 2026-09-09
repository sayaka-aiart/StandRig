import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runQaCheck } from '@standrig/core/qaCheck';
import { renderQaFailureComparison } from '@standrig/core/qaFailureImage';
import { decodePng } from '@standrig/core/png';

const sample=JSON.parse(await readFile(new URL('../examples/sample.standrig.json',import.meta.url),'utf8'));
test('failure comparison reproduces custom poseSamples instead of looking up a missing named pose',async()=>{
  const result=await runQaCheck(sample,'.',{poseSamples:[{poseId:'custom-neutral',values:{ParamAngleZ:0}},{poseId:'custom-roll',values:{ParamAngleZ:25}}],regions:['full'],minCoverage:1});
  assert.equal(result.ok,false);
  const request=result.failureRegions.find(f=>f.poseId==='custom-roll').imageRequest;
  const image=decodePng(await renderQaFailureComparison(sample,'.',request));
  assert.equal(image.width,720);
  assert.equal(image.height,240);
  let differencePixels=0;
  for(let y=0;y<240;y++)for(let x=480;x<720;x++)if(image.data[(y*720+x)*4+3])differencePixels++;
  assert.ok(differencePixels>0,'comparison must contain the actual changed-pose pixels');
});
test('QA rejects unknown poses/regions and duplicate custom labels rather than silently testing a subset',async()=>{
  for(const request of [{poses:['neutral','misspelled']},{regions:['full','misspelled']},{poseSamples:[{poseId:'same',values:{}},{poseId:'same',values:{ParamAngleZ:25}}]},{poseSamples:[{poseId:'bad',values:{ParamAngleZ:NaN}}]}]) {
    await assert.rejects(runQaCheck(sample,'.',request));
  }
});
