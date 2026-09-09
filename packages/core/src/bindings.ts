import { sortedKeysOrCopy } from "./bindingPreparation.js";
import { PARAMETER_INTERPOLATIONS, type ParameterCurve, type ParameterInterpolation, type ParameterKeyframe } from "./types.js";

const INTERPOLATION_SET = new Set<string>(PARAMETER_INTERPOLATIONS);

export function isParameterInterpolation(value: unknown): value is ParameterInterpolation {
  return typeof value === "string" && INTERPOLATION_SET.has(value);
}

export function normalizeParameterInterpolation(value: unknown): ParameterInterpolation {
  return isParameterInterpolation(value) ? value : "linear";
}

interface SampleableBinding {
  keys: ParameterKeyframe[];
  interpolation?: ParameterInterpolation;
  curve?: ParameterCurve;
}

export function sampleBinding(binding: SampleableBinding, input: number): number {
  const keys = sortedKeysOrCopy(binding.keys);
  if (keys.length === 0) {
    return 0;
  }
  if (input <= keys[0].input) {
    return keys[0].value;
  }
  const last = keys[keys.length - 1];
  if (input >= last.input) {
    return last.value;
  }

  for (let index = 0; index < keys.length - 1; index += 1) {
    const from = keys[index];
    const to = keys[index + 1];
    if (input >= from.input && input <= to.input) {
      const amount = (input - from.input) / (to.input - from.input || 1);
      const eased = applyParameterInterpolation(normalizeParameterInterpolation(binding.interpolation), amount, binding.curve);
      return from.value + (to.value - from.value) * eased;
    }
  }

  return 0;
}

export function applyParameterInterpolation(interpolation: ParameterInterpolation, amount: number, curve?: ParameterCurve): number {
  const clamped = Math.min(1, Math.max(0, amount));
  if (interpolation === "smoothstep") return clamped * clamped * (3 - 2 * clamped);
  if (interpolation === "hold") return clamped >= 1 ? 1 : 0;
  if (interpolation === "arc") return Math.sin(clamped * Math.PI / 2);
  if (interpolation === "curve") return sampleParameterCurve(curve, clamped);
  return clamped;
}

export function sampleParameterCurve(curve: ParameterCurve | undefined, amount: number): number {
  const clamped = Math.min(1, Math.max(0, amount));
  const points = (curve?.controlPoints ?? [])
    .filter((point) => Number.isFinite(point?.t) && Number.isFinite(point?.value))
    .map((point) => ({ t: Math.min(1, Math.max(0, point.t)), value: Math.min(1, Math.max(0, point.value)) }))
    .sort((left, right) => left.t - right.t);
  if (points.length < 2) return clamped;
  if (clamped <= points[0].t) return points[0].value;
  const lastIndex = points.length - 1;
  if (clamped >= points[lastIndex].t) return points[lastIndex].value;
  for (let index = 0; index < lastIndex; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (clamped < from.t || clamped > to.t) continue;
    const span = to.t - from.t || 1;
    const u = (clamped - from.t) / span;
    const p0 = points[Math.max(0, index - 1)].value;
    const p1 = from.value;
    const p2 = to.value;
    const p3 = points[Math.min(lastIndex, index + 2)].value;
    const u2 = u * u;
    const u3 = u2 * u;
    const value = 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
    return Math.min(1, Math.max(0, value));
  }
  return clamped;
}