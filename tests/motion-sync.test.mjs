import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { activeVisemeBank, exportMotionSync, importMotionSync } from '@standrig/core/motionSync';
import { createModelBundle, packModelBundle, parseModelBundle } from '@standrig/core/bundle';
import { defaultParameterValues } from '@standrig/core/parameters';
import { FacialController } from '@standrig/runtime/facial';
import { createLocalService } from '../apps/service/dist/service.js';

const sample = JSON.parse(await readFile(new URL('../examples/sample.standrig.json', import.meta.url), 'utf8'));
const manual = { mode: 'pose', fadeInTime: 0, fadeOutTime: 0, presets: [
  { id: 'A', values: { ParamMouthOpen: 0.82, ParamMouthForm: 0.21 } }
] };
const pose = (open, form) => ({ ParamMouthOpenY: open, ParamMouthForm: form, ParamMouthSmile: 0.2 });
const vowels = { Silence: pose(0, 0), A: pose(0.6, -0.25), I: pose(0.37, 0.56),
  U: pose(0.3, -0.8), E: pose(0.58, 0.75), O: pose(0.77, -0.7) };
const file = {
  Version: 1,
  Meta: { SettingCount: 1, Dictionary: [{ Id: 'MotionSyncSetting', Name: '口形テスト' }] },
  Settings: [{
    Id: 'MotionSyncSetting', AnalysisType: 'CRI', UseCase: 'Mouth',
    CubismParameters: Object.keys(vowels.A).map(id => ({
      Id: id, Name: id, Min: id === 'ParamMouthOpenY' ? 0 : -1, Max: 1, Damper: 0.2, Smooth: 28
    })),
    AudioParameters: Object.keys(vowels).map(id => ({ Id: id, Name: id, Min: 0, Max: 1, Scale: 1.5, Enabled: true })),
    Mappings: Object.entries(vowels).map(([id, values]) => ({
      Id: id, Type: 'Shape', Targets: Object.entries(values).map(([Id, Value]) => ({ Id, Value }))
    })),
    PostProcessing: { BlendRatio: 0.75, Smoothing: 40, SampleRate: 50 }
  }]
};
const fixture = () => ({ ...structuredClone(sample), facialPresets: { version: 1, expressions: [], visemes: structuredClone(manual) } });

test('MotionSync preserves profile settings and the legacy model’s independent manual registrations', () => {
  const rig = fixture();
  const second = structuredClone(file.Settings[0]);
  second.Id = 'Alternate';
  const document = {
    ...file,
    Meta: { SettingCount: 2, Dictionary: [...file.Meta.Dictionary, { Id: second.Id, Name: 'Alternate' }] },
    Settings: [...file.Settings, second]
  };
  let nextId = 1;
  rig.facialPresets.motionSync = importMotionSync(document, rig, () => String(nextId++));
  assert.deepEqual(rig.facialPresets.visemes, manual);
  assert.equal(rig.facialPresets.motionSync.profiles.length, 2);
  assert.deepEqual(exportMotionSync(rig), file);
  rig.facialPresets.motionSync = importMotionSync(file, rig, () => String(nextId++));
  assert.equal(rig.facialPresets.motionSync.profiles.length, 3);
  const packed = JSON.parse(JSON.stringify(packModelBundle(createModelBundle(rig))));
  const portable = parseModelBundle(packed).rig;
  assert.deepEqual(portable.facialPresets, rig.facialPresets);
  const active = activeVisemeBank(portable.facialPresets, portable);
  assert.deepEqual(active.presets.find(p => p.id === 'A').values,
    { ParamMouthOpen: 0.6, ParamMouthForm: -0.25, ParamMouthSmile: 0.2 });
  const controller = new FacialController(portable);
  assert.deepEqual(controller.catalog(), portable.facialPresets);
  assert.deepEqual(controller.playbackCatalog().visemes, active);
  controller.command({ action: 'visemes', weights: { A: 0.5, I: 0.5 } }, 0);
  const frame = controller.evaluate(defaultParameterValues(portable), 100);
  assert.equal(frame.ParamMouthOpen, (0.6 + 0.37) / 2);
  assert.equal(frame.ParamMouthSmile, 0.2);

  delete portable.facialPresets.motionSync.selectedId;
  assert.deepEqual(activeVisemeBank(portable.facialPresets, portable), manual);
  const manualExport = exportMotionSync(portable);
  assert.ok(manualExport.Settings[0].CubismParameters.some(p => p.Id === 'ParamMouthOpenY'));
  portable.facialPresets.motionSync = importMotionSync(manualExport, portable, () => String(nextId++));
  assert.deepEqual(activeVisemeBank(portable.facialPresets, portable).presets, manual.presets);
});

test('MotionSync rejects invalid targets and skips disabled mappings while preserving their settings', () => {
  const rig = fixture();
  const original = structuredClone(rig);
  const change = (edit, error) => {
    const bad = structuredClone(file);
    edit(bad, bad.Settings[0]);
    assert.throws(() => importMotionSync(bad, rig, () => 'example'), error);
    assert.deepEqual(rig, original);
  };
  change(d => d.Version = 2, /Version 1/);
  change(d => d.Meta.SettingCount = 2, /SettingCount/);
  change((_, s) => s.CubismParameters.push({ ...s.CubismParameters[0] }), /Duplicate/);
  change((_, s) => s.CubismParameters.push({ ...s.CubismParameters[0], Id: 'ParamOther' }), /Unknown.*ParamOther/);
  change((_, s) => s.Mappings[1].Targets[0].Value = 1.1, /file range/);
  change((_, s) => s.Mappings[1].Targets.pop(), /same parameter IDs/);

  const disabled = structuredClone(file);
  disabled.Settings[0].AudioParameters.find(p => p.Id === 'I').Enabled = false;
  rig.facialPresets.motionSync = importMotionSync(disabled, rig, () => 'disabled-test');
  assert.ok(!activeVisemeBank(rig.facialPresets, rig).presets.some(p => p.id === 'I'));
  assert.deepEqual(exportMotionSync(rig), disabled);
});

test('service saves, previews and switches MotionSync profiles through the model transaction and bundle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'standrig-motion-sync-'));
  let service;
  try {
    service = await createLocalService({ dataDir: root, port: 0 });
    async function call(route, body) {
      const response = await fetch(service.url + route, body && {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return data;
    }
    const qa = { poses: ['neutral'], regions: ['full'], width: 96, height: 96, physics: false };
    const rig = fixture();
    const revision = (await call('/api/context')).context.revision;
    const imported = await call('/api/modeling/transaction', { kind: 'import', expectedRevision: revision, rig, commit: true, qa });
    const next = { ...rig.facialPresets, motionSync: importMotionSync(file, rig, () => 'selected') };
    async function save(presets, expectedRevision) {
      return call('/api/modeling/transaction', {
        expectedRevision, commit: true, qa, operations: [{
          id: 'mouth-profile', name: 'Save mouth profile', target: {}, action: { type: 'facial-presets-set', presets }
        }]
      });
    }
    const selected = await save(next, imported.revisionAfter);
    assert.deepEqual((await call('/api/playback/facial')).presets, next);
    assert.deepEqual((await call('/api/bundle')).rig.facialPresets, next);
    await call('/api/playback/facial', { action: 'viseme', id: 'A' });
    // Pause-independent facial fades advance with the service clock.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await call('/api/playback')).playback.values.ParamMouthOpen, 0.6);
    delete next.motionSync.selectedId;
    await save(next, selected.revisionAfter);
    const played = await call('/api/playback/facial', { action: 'viseme', id: 'A' });
    assert.equal(played.playback.values.ParamMouthOpen, 0.82);
    assert.deepEqual((await call('/api/playback/facial')).presets.visemes, manual);
  } finally {
    await service?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
