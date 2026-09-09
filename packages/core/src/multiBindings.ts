import { applyParameterInterpolation, normalizeParameterInterpolation } from "./bindings.js";
import { orderedAxis } from "./bindingPreparation.js";
import type { MultiParameterBinding, ParameterInterpolation, ParameterValues } from "./types.js";

export function sampleMultiParameterBinding(
  binding: MultiParameterBinding,
  values: ParameterValues
): number | undefined {
  if (!Array.isArray(binding.parameters) || binding.parameters.length !== 2) return undefined;
  const [xParameter, yParameter] = binding.parameters;
  if (!xParameter || !yParameter || xParameter === yParameter) return undefined;

  const points = new Map<string, number>();
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (const keyform of binding.keyforms ?? []) {
    const x = keyform?.inputs?.[xParameter];
    const y = keyform?.inputs?.[yParameter];
    if (!finite(x) || !finite(y) || !finite(keyform.value)) continue;
    xs.add(x);
    ys.add(y);
    points.set(pointKey(x, y), keyform.value);
  }
  if (xs.size < 2 || ys.size < 2) return undefined;

  const xAxis = orderedAxis(xs);
  const yAxis = orderedAxis(ys);
  const xSpan = enclosingSpan(xAxis, values[xParameter] ?? 0);
  const ySpan = enclosingSpan(yAxis, values[yParameter] ?? 0);
  if (!xSpan || !ySpan) return undefined;

  const q00 = points.get(pointKey(xSpan.low, ySpan.low));
  const q10 = points.get(pointKey(xSpan.high, ySpan.low));
  const q01 = points.get(pointKey(xSpan.low, ySpan.high));
  const q11 = points.get(pointKey(xSpan.high, ySpan.high));
  if (![q00, q10, q01, q11].every(finite)) return undefined;

  const interpolation = normalizeParameterInterpolation(binding.interpolation);
  const tx = applyParameterInterpolation(interpolation, ratio(values[xParameter] ?? 0, xSpan.low, xSpan.high), binding.curve);
  const ty = applyParameterInterpolation(interpolation, ratio(values[yParameter] ?? 0, ySpan.low, ySpan.high), binding.curve);
  const bottom = q00! + (q10! - q00!) * tx;
  const top = q01! + (q11! - q01!) * tx;
  return bottom + (top - bottom) * ty;
}

function enclosingSpan(axis: number[], input: number): { low: number; high: number } | undefined {
  if (axis.length < 2) return undefined;
  const clamped = Math.min(axis[axis.length - 1], Math.max(axis[0], input));
  for (let index = 0; index < axis.length - 1; index += 1) {
    if (clamped >= axis[index] && clamped <= axis[index + 1]) {
      return { low: axis[index], high: axis[index + 1] };
    }
  }
  return { low: axis[axis.length - 2], high: axis[axis.length - 1] };
}

function ratio(value: number, low: number, high: number): number {
  return Math.min(1, Math.max(0, (value - low) / (high - low || 1)));
}


function pointKey(x: number, y: number): string {
  return `${x}\u0000${y}`;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
