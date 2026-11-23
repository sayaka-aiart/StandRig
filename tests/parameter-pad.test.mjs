import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { modelingPosePresetById } from '../packages/core/dist/modeling.js';
import { DEFAULT_PARAMETERS } from '../packages/core/dist/parameters.js';

const source = await readFile(new URL('../apps/preview/src/parameterControls.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { padValue, padPatch, restorePads } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const parameter = (id, min, max, step = 0.1) => ({ id, label: id, min, max, default: min, step });
const definitions = [parameter('x', -30, 30, 1), parameter('y', 0, 1, 0.01), parameter('z', -10, 10), parameter('w', 2, 4)];

test('XY coordinates respect asymmetric bounds, steps, vertical direction and atomic pairs', () => {
  assert.deepEqual(padPatch(definitions.slice(0, 2), 0, 0), { x: -30, y: 1 });
  assert.deepEqual(padPatch(definitions.slice(0, 2), 1, 1), { x: 30, y: 0 });
  assert.deepEqual(padPatch(definitions.slice(0, 2), 0.75, 0.25), { x: 15, y: 0.75 });
  assert.deepEqual(padPatch(definitions.slice(0, 2), -2, 4), { x: -30, y: 0 });
  assert.equal(padValue(definitions[1], 0.333), 0.33);
  assert.equal(padValue(parameter('uneven', 2, 3, 0.3), 1), 3);
  const pose = { x: 0, y: 0, z: 4, w: 3 };
  Object.assign(pose, padPatch([definitions[0], definitions[2]], 0.5, 0.1));
  assert.deepEqual(pose, { x: 0, y: 0, z: 8, w: 3 });
});

test('dragging above or below center uses the StandRig Face Up or Face Down pitch', () => {
  const yaw = DEFAULT_PARAMETERS.find(parameter => parameter.id === 'ParamAngleX');
  const pitch = DEFAULT_PARAMETERS.find(parameter => parameter.id === 'ParamAngleY');
  assert.deepEqual(padPatch([yaw, pitch], 0.5, 0.25), {
    ParamAngleX: 0,
    ParamAngleY: modelingPosePresetById('face-up').values.ParamAngleY
  });
  assert.deepEqual(padPatch([yaw, pitch], 0.5, 0.75), {
    ParamAngleX: 0,
    ParamAngleY: modelingPosePresetById('face-down').values.ParamAngleY
  });
  assert.equal(padPatch([pitch, yaw], 0.75, 0.5).ParamAngleY, 15);
});

test('four or more parameters survive persistence and axis changes with safe model reconciliation', () => {
  const group = { name: 'four axes', parameters: ['x', 'y', 'z', 'w'], axes: ['z', 'w'] };
  const original = JSON.stringify(group);
  assert.deepEqual(restorePads(JSON.parse(JSON.stringify([group])), definitions), [group]);
  assert.equal(JSON.stringify(group), original);
  const reconciled = restorePads([group], definitions.slice(0, 3));
  assert.deepEqual(reconciled, [{ name: group.name, parameters: ['x', 'y', 'z'], axes: ['z', 'x'] }]);
  assert.deepEqual(restorePads([{ ...group, axes: ['x', 'x'] }], definitions)[0].axes, ['x', 'y']);
  assert.deepEqual(restorePads([group], definitions.slice(0, 1)), []);
  assert.deepEqual(restorePads([null, {}, { name: 'invalid', parameters: [1, null, 'missing'] }], definitions), []);
  assert.deepEqual(restorePads([group, { ...group, name: 'duplicate' }], definitions), [group]);
  assert.deepEqual(restorePads({}, definitions), []);
});
