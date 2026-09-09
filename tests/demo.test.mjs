import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { demoParameters, sampleDemo } from '@standrig/runtime/demo';
import { motionPreviewValues, SHOWCASE_ACTIVE_CYCLE_SECONDS } from '@standrig/runtime/motionPreview';
import { parameterDefinitionsForRig, previewParameterValuesForRig } from '@standrig/core/parameters';
import { PlaybackSession } from '../apps/service/dist/playback.js';

const sample = JSON.parse(await readFile(new URL('../examples/sample.standrig.json', import.meta.url), 'utf8'));
const base = previewParameterValuesForRig(sample);

test('ported fast showcase and mouse expressions preserve choreography and custom ranges', () => {
  const defs = parameterDefinitionsForRig(sample);
  assert.equal(SHOWCASE_ACTIVE_CYCLE_SECONDS, 18 / 1.3);
  for (const mode of ['showcase-active', 'mouse-expression']) {
    for (let t = 0; t < 30; t += 0.05) {
      const frame = sampleDemo(defs, base, mode, t, { x: 1, y: -1 });
      for (const p of defs) assert.ok(Number.isFinite(frame[p.id]) && frame[p.id] >= p.min && frame[p.id] <= p.max, `${mode}:${p.id}`);
    }
  }
  const mouse = motionPreviewValues(base, 'mouse-expression', 1.125, { x: 1, y: -1 });
  assert.equal(mouse.ParamAngleX, 30); assert.equal(mouse.ParamAngleY, -30);
  assert.equal(mouse.ParamBodyAngleY, -28); assert.ok(mouse.ParamMouthOpen > 0.18);
  const wink = motionPreviewValues(base, 'mouse-expression', 2.65);
  assert.ok(wink.ParamEyeLOpen < 0.001); assert.equal(wink.ParamEyeROpen, 1);
  const narrow = [{ id: 'ParamAngleX', min: -5, max: 5, default: 0 }];
  assert.equal(sampleDemo(narrow, base, 'mouse-expression', 1, { x: 1, y: 0 }).ParamAngleX, 5);
});

test('demo state is transient, validates input atomically and restores manual control', async () => {
  const rig = structuredClone(sample), original = JSON.stringify(rig);
  const session = new PlaybackSession(rig);
  try {
    session.input({source:'manual', sequence:1, values:{ParamAngleZ:12}});
    const before = session.snapshot();
    session.control('demo-start');
    assert.equal(session.snapshot().demo.mode, 'showcase-active');
    await delay(120);
    assert.notDeepEqual(session.snapshot().values, before.values);
    assert.throws(() => session.control('demo-start', {mode:'bad'}));
    assert.throws(() => session.input({source:'manual',sequence:2,values:{ParamAngleZ:1000}}));
    assert.equal(session.snapshot().demo.active,true);
    session.control('demo-stop');
    assert.deepEqual(session.snapshot().values,before.values);
    assert.equal(session.snapshot().playing,before.playing);
    const revision = session.snapshot().revision;
    await delay(90);
    assert.equal(session.snapshot().revision,revision);
    session.control('demo-start',{mode:'mouse-expression'});
    assert.throws(() => session.control('demo-pointer',{x:Infinity,y:0}));
    session.control('demo-pointer',{x:1,y:-1});
    await delay(120);
    assert.ok(session.snapshot().values.ParamAngleX > 20);
    assert.ok(session.snapshot().values.ParamBodyAngleY < -20);
    session.input({source:'manual',sequence:2,values:{ParamMouthOpen:0.6}});
    assert.equal(session.snapshot().demo.active,false);
    assert.equal(session.snapshot().values.ParamAngleZ,12);
    assert.equal(session.snapshot().values.ParamMouthOpen,0.6);
    session.control('demo-start'); session.control('pause');
    assert.equal(session.snapshot().demo.active,false); assert.equal(session.snapshot().playing,false);
    session.control('demo-start'); session.reload(rig);
    assert.equal(session.snapshot().demo.active,false);
    session.control('demo-start'); session.close();
    assert.equal(session.snapshot().demo.active,false);
    assert.equal(JSON.stringify(rig),original);
  } finally { session.close(); }
});

test('unrigged models do not offer demo, disabled meshes do not count as authored movement', () => {
  const empty = {...structuredClone(sample), parts:[], deformers:[]};
  empty.metadata = {bindings:[{parameter:'ParamAngleX'}]};
  assert.deepEqual(demoParameters(empty),[]);
  const session = new PlaybackSession(empty);
  assert.throws(() => session.control('demo-start'), /No authored/);
  assert.equal(session.snapshot().demo.active,false);
  empty.parts=[{artMesh:{enabled:false,bindings:[{parameter:'ParamAngleX'}]}}];
  assert.deepEqual(demoParameters(empty),[]);
  empty.parts=[{bindings:[{parameter:'CustomOnly'}]}];
  empty.parameters=[{id:'CustomOnly',min:0,max:1,default:0}];
  assert.deepEqual(demoParameters(empty),[]);
});
