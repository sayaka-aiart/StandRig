import { parameterDefinitionsForRig } from '@standrig/core/parameters';
import type { ParameterDefinition, ParameterValues, RigDocument } from '@standrig/core/types';
import { motionPreviewValues, type MotionPreviewMode, type MotionPreviewPointer } from './motionPreview.js';

/** Discover authored controls without traversing assets, metadata or physics outputs. */
export function demoParameters(rig: RigDocument): ParameterDefinition[] {
  const ids = new Set<string>();
  const choreographed = new Set(['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamBreath', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamMouthOpen', 'ParamMouthForm', 'ParamMouthSmile', 'ParamCheek']);
  function visit(value: unknown) {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.enabled === false) return;
    if (typeof record.parameter === 'string') ids.add(record.parameter);
    if (Array.isArray(record.parameters)) for (const id of record.parameters) if (typeof id === 'string') ids.add(id);
    for (const key of ['yawParameter', 'pitchParameter']) if (typeof record[key] === 'string') ids.add(record[key] as string);
    for (const key of ['bindings', 'multiBindings', 'blendShapes', 'warp', 'pins', 'artMesh', 'artPaths', 'points', 'alphaReveal', 'contourShade']) visit(record[key]);
  }
  visit(rig.parts); visit(rig.deformers); visit((rig.glue??[]).filter(g=>g.status==="active"));
  return parameterDefinitionsForRig(rig).filter(p => ids.has(p.id) && choreographed.has(p.id) && p.max > p.min);
}

/** Keep the original choreography, clamped to each model's declared ranges. */
export function sampleDemo(parameters: ParameterDefinition[], base: ParameterValues, mode: MotionPreviewMode, elapsedSeconds: number, pointer: MotionPreviewPointer) {
  const generated = motionPreviewValues(base, mode, elapsedSeconds, pointer);
  const values = { ...base };
  for (const p of parameters) values[p.id] = Math.max(p.min, Math.min(p.max, generated[p.id] ?? base[p.id] ?? p.default));
  return values;
}
