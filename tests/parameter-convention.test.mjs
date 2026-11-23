import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createModelBundle, packModelBundle, parseModelBundle } from '@standrig/core/bundle';
import { fitHeadProxy, headProxyPoseCandidates } from '@standrig/core/headProxy';
import { summarizeRig } from '@standrig/core/inspect';
import { CUBISM_PARAMETERS, parameterDefinitionsForRig, previewParameterValuesForRig } from '@standrig/core/parameters';
import { modelingPoseValuesForRig } from '@standrig/core/modeling';
import { referenceSheetDefinitionsForRig } from '@standrig/core/reference';
import { renderRigScreenshot, screenshotOptionsFromUrl } from '@standrig/core/serverRenderer';
import { createDefaultTracking } from '@standrig/core/tracking';
import { sampleDemo } from '@standrig/runtime/demo';

const sample = JSON.parse(await readFile(new URL('../examples/sample.standrig.json', import.meta.url), 'utf8'));

function modelWithPitch(pitchUp) {
  const rig = structuredClone(sample);
  if (pitchUp > 0) {
    rig.metadata = { parameterConvention: 'cubism' };
    rig.parameters = structuredClone(CUBISM_PARAMETERS);
    const mouth = rig.parts.find(part => part.id === 'mouth');
    for (const binding of mouth.bindings) {
      if (binding.parameter === 'ParamMouthOpen') binding.parameter = 'ParamMouthOpenY';
    }
  }
  const head = rig.parts.find(part => part.id === 'head-group');
  head.bindings.push({
    parameter: 'ParamAngleY',
    property: 'y',
    additive: true,
    keys: [-30, 0, 30].map(input => ({ input, value: -input * pitchUp }))
  });
  rig.parts.find(part => part.id === 'head').role = 'face';
  return rig;
}

test('new and legacy models render the same face pose after a bundle round trip', async () => {
  const positive = modelWithPitch(1);
  const packed = packModelBundle(createModelBundle(positive));
  const restored = parseModelBundle(JSON.parse(JSON.stringify(packed))).rig;
  const legacy = modelWithPitch(-1);
  assert.equal(summarizeRig(restored).parameterConvention, 'cubism');
  assert.equal(summarizeRig(legacy).parameterConvention, 'standrig-legacy');
  const url = new URL('http://localhost/api/screenshot?set=angles&width=96&height=96&physics=0');
  const positiveSheet = await renderRigScreenshot(restored, '.', screenshotOptionsFromUrl(restored, url));
  const legacySheet = await renderRigScreenshot(legacy, '.', screenshotOptionsFromUrl(legacy, url));
  const up = sheet => sheet.presets.find(preset => preset.id === 'angle-y-up');
  assert.equal(up(positiveSheet).values.ParamAngleY, 15);
  assert.equal(up(legacySheet).values.ParamAngleY, -15);
  // Render each preset on its own to compare pixels without the different sign labels.
  const shot = (rig, values) => renderRigScreenshot(rig, '.', { ...screenshotOptionsFromUrl(rig, url), set: 'single', values });
  assert.deepEqual((await shot(restored, up(positiveSheet).values)).png, (await shot(legacy, up(legacySheet).values)).png);
  const down = positiveSheet.presets.find(preset => preset.id === 'angle-y-down');
  assert.notDeepEqual((await shot(restored, up(positiveSheet).values)).png, (await shot(restored, down.values)).png);
});

test('pose generators and tracking respect each model convention', () => {
  const positive = modelWithPitch(1);
  const legacy = modelWithPitch(-1);
  const proxyPose = (rig, pitch) => headProxyPoseCandidates(fitHeadProxy(rig))
    .find(candidate => candidate.values.ParamAngleX === 0 && candidate.values.ParamAngleY === pitch);
  const positiveUp = proxyPose(positive, 30);
  const legacyUp = proxyPose(legacy, -30);
  assert.deepEqual(positiveUp.landmarkOffsets, legacyUp.landmarkOffsets);
  const mappings = new Map(createDefaultTracking(positive).mappings.map(mapping => [mapping.source, mapping]));
  assert.equal(mappings.get('bodyPitch').max, 10);
  assert.equal(mappings.get('mouthOpen').parameter, 'ParamMouthOpenY');
  assert.equal(mappings.get('mouthSmile').parameter, 'ParamMouthForm');
  assert.equal(mappings.get('mouthForm').parameter, 'ParamMouthRound');
  const demo = rig => sampleDemo(parameterDefinitionsForRig(rig), previewParameterValuesForRig(rig),
    'mouse-expression', 1, { x: 0, y: -0.5 }, rig);
  const newer = demo(positive);
  const older = demo(legacy);
  assert.equal(newer.ParamAngleY, 15);
  assert.equal(older.ParamAngleY, -15);
  assert.equal(newer.ParamBodyAngleY, -older.ParamBodyAngleY / 3);
  assert.equal(newer.ParamEyeBallY, -older.ParamEyeBallY);
  assert.equal(newer.ParamMouthOpenY, older.ParamMouthOpen);
  const eyes = modelingPoseValuesForRig(positive, 'blink');
  assert.equal(eyes.ParamEyeLOpen, 0);
  assert.equal(eyes.ParamEyeROpen, 0);
  const smile = modelingPoseValuesForRig(positive, 'mouth-smile');
  assert.equal(smile.ParamMouthForm, 1);
  assert.equal(smile.ParamMouthRound, -0.25);
  const references = referenceSheetDefinitionsForRig(positive).find(sheet => sheet.id === 'reference-all').poses;
  assert.equal(references.find(pose => pose.id === 'gaze-up').values.ParamEyeBallY, 1);
  assert.ok(references.find(pose => pose.id === 'body-up').values.ParamBodyAngleY > 0);
});
