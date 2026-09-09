import { applyParameterInterpolation, normalizeParameterInterpolation } from "./bindings.js";
import { orderedAxis } from "./bindingPreparation.js";
import type { ParameterValues, RigArtMeshBinding, RigArtMeshMultiBinding } from "./types.js";

export function sampleMultiArtMeshBinding(binding: RigArtMeshMultiBinding, values: ParameterValues): Map<string, { x: number; y: number }> {
  const [xParameter, yParameter] = binding.parameters ?? [];
  if (!xParameter || !yParameter || xParameter === yParameter) return new Map();
  const points = new Map<string, RigArtMeshMultiBinding["keyforms"][number]>();
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (const keyform of binding.keyforms ?? []) {
    const x = keyform?.inputs?.[xParameter];
    const y = keyform?.inputs?.[yParameter];
    if (!finite(x) || !finite(y)) continue;
    xs.add(x);
    ys.add(y);
    points.set(key(x, y), keyform);
  }
  const xSpan = span(orderedAxis(xs), values[xParameter] ?? 0);
  const ySpan = span(orderedAxis(ys), values[yParameter] ?? 0);
  if (!xSpan || !ySpan) return new Map();
  const corners = [
    points.get(key(xSpan.low, ySpan.low)),
    points.get(key(xSpan.high, ySpan.low)),
    points.get(key(xSpan.low, ySpan.high)),
    points.get(key(xSpan.high, ySpan.high))
  ];
  if (corners.some((corner) => !corner)) return new Map();
  const tx = applyParameterInterpolation(normalizeParameterInterpolation(binding.interpolation), ratio(values[xParameter] ?? 0, xSpan.low, xSpan.high), binding.curve);
  const ty = applyParameterInterpolation(normalizeParameterInterpolation(binding.interpolation), ratio(values[yParameter] ?? 0, ySpan.low, ySpan.high), binding.curve);
  const offsets = corners.map((corner) => offsetsForKey(corner!));
  const ids = new Set(offsets.flatMap((entry) => [...entry.keys()]));
  const result = new Map<string, { x: number; y: number }>();
  for (const id of ids) {
    const q00 = offsets[0].get(id) ?? { x: 0, y: 0 };
    const q10 = offsets[1].get(id) ?? { x: 0, y: 0 };
    const q01 = offsets[2].get(id) ?? { x: 0, y: 0 };
    const q11 = offsets[3].get(id) ?? { x: 0, y: 0 };
    result.set(id, {
      x: bilinear(q00.x, q10.x, q01.x, q11.x, tx, ty),
      y: bilinear(q00.y, q10.y, q01.y, q11.y, tx, ty)
    });
  }
  return result;
}

function offsetsForKey(keyform: RigArtMeshBinding["keys"][number] | RigArtMeshMultiBinding["keyforms"][number]) {
  const result = new Map<string, { x: number; y: number }>();
  for (const offset of keyform.offsets ?? []) {
    if (offset && typeof offset.vertexId === "string" && finite(offset.x) && finite(offset.y)) result.set(offset.vertexId, { x: offset.x, y: offset.y });
  }
  return result;
}

function span(axis: number[], value: number): { low: number; high: number } | undefined {
  if (axis.length < 2) return undefined;
  const input = Math.min(axis[axis.length - 1], Math.max(axis[0], value));
  for (let index = 0; index < axis.length - 1; index += 1) {
    if (input >= axis[index] && input <= axis[index + 1]) return { low: axis[index], high: axis[index + 1] };
  }
  return undefined;
}

function ratio(value: number, low: number, high: number) {
  return Math.min(1, Math.max(0, (value - low) / (high - low || 1)));
}


function bilinear(q00: number, q10: number, q01: number, q11: number, tx: number, ty: number) {
  return q00 * (1 - tx) * (1 - ty) + q10 * tx * (1 - ty) + q01 * (1 - tx) * ty + q11 * tx * ty;
}

function key(x: number, y: number) {
  return `${x}|${y}`;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
