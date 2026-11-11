import { applyParameterInterpolation, normalizeParameterInterpolation } from "./bindings.js";
import { orderedAxis } from "./bindingPreparation.js";
import { MAX_GRID_PARAMETERS } from "./parameterGrid.js";
import type { MultiParameterBinding, MultiParameterKeyform, ParameterCurve, ParameterInterpolation, ParameterValues } from "./types.js";

/**
 * Samples a scalar keyform grid over two or more parameters (for example opacity driven by
 * eye-open, smile and a toggle).
 * The value is interpolated axis by axis in parameter order, so a two-parameter grid evaluates
 * exactly like the original bilinear sampler.
 */
export function sampleMultiParameterBinding(
  binding: MultiParameterBinding,
  values: ParameterValues
): number | undefined {
  const parameters = binding.parameters;
  if (!Array.isArray(parameters) || parameters.length < 2 || parameters.length > MAX_GRID_PARAMETERS) return undefined;
  return sampleKeyformGrid(parameters, binding.keyforms, keyformValue, values, binding.interpolation, binding.curve);
}

function keyformValue(keyform: MultiParameterKeyform): number {
  return keyform.value;
}

/**
 * Multilinear sample of a rectangular keyform grid over one to MAX_GRID_PARAMETERS distinct parameters.
 * Inputs outside the grid clamp to its edge; a grid with a missing enclosing corner yields
 * undefined rather than inventing a value.
 */
export function sampleKeyformGrid<T extends { inputs: Record<string, number> }>(
  parameters: readonly string[],
  keyforms: readonly T[] | undefined,
  valueOf: (keyform: T) => number,
  values: ParameterValues,
  interpolation?: ParameterInterpolation,
  curve?: ParameterCurve
): number | undefined {
  if (!Array.isArray(parameters) || parameters.length < 1 || parameters.length > MAX_GRID_PARAMETERS) return undefined;
  if (!parameters.every((parameter) => typeof parameter === "string" && parameter.length > 0) || new Set(parameters).size !== parameters.length) return undefined;

  const points = new Map<string, number>();
  const axisValues = parameters.map(() => new Set<number>());
  for (const keyform of keyforms ?? []) {
    const coordinates = parameters.map((parameter) => keyform?.inputs?.[parameter]);
    const value = keyform ? valueOf(keyform) : undefined;
    if (!coordinates.every(finite) || !finite(value)) continue;
    coordinates.forEach((coordinate, axis) => axisValues[axis].add(coordinate));
    points.set(pointKey(coordinates), value);
  }
  if (axisValues.some((axis) => axis.size < 2)) return undefined;

  const spans = axisValues.map((axis, index) => enclosingSpan(orderedAxis(axis), values[parameters[index]] ?? 0));
  if (spans.some((span) => !span)) return undefined;

  // Corner c has bit i set when axis i takes its high end.
  let level: number[] = [];
  for (let corner = 0; corner < 1 << parameters.length; corner += 1) {
    const value = points.get(pointKey(spans.map((span, axis) => (corner & (1 << axis) ? span!.high : span!.low))));
    if (!finite(value)) return undefined;
    level.push(value);
  }

  const normalized = normalizeParameterInterpolation(interpolation);
  for (let axis = 0; axis < parameters.length; axis += 1) {
    const span = spans[axis]!;
    const t = applyParameterInterpolation(normalized, ratio(values[parameters[axis]] ?? 0, span.low, span.high), curve);
    const next: number[] = [];
    for (let index = 0; index < level.length; index += 2) next.push(level[index] + (level[index + 1] - level[index]) * t);
    level = next;
  }
  return level[0];
}

/** Structural problems of a one-to-three parameter keyform grid (empty when it is usable). */
export function keyformGridIssues<T extends { inputs: Record<string, number> }>(
  parameters: unknown,
  keyforms: readonly T[] | undefined,
  valueOf: (keyform: T) => unknown,
  knownParameters: ReadonlySet<string>
): string[] {
  if (!Array.isArray(parameters) || parameters.length < 1 || parameters.length > MAX_GRID_PARAMETERS ||
    !parameters.every((parameter) => typeof parameter === "string" && parameter.trim().length > 0) || new Set(parameters).size !== parameters.length) {
    return [`parameters must list one to ${MAX_GRID_PARAMETERS} distinct parameter ids`];
  }
  const issues: string[] = [];
  for (const parameter of parameters) if (!knownParameters.has(parameter)) issues.push(`unknown parameter ${parameter}`);
  if (!Array.isArray(keyforms) || keyforms.length < 2) return [...issues, "at least two keyforms are required"];
  const axes = parameters.map(() => new Set<number>()), cells = new Set<string>();
  for (const keyform of keyforms) {
    const coordinates = parameters.map((parameter) => keyform?.inputs?.[parameter]);
    if (!coordinates.every(finite)) { issues.push("keyform inputs must be finite"); continue; }
    if (!finite(valueOf(keyform))) issues.push("keyform values must be finite");
    coordinates.forEach((coordinate, axis) => axes[axis].add(coordinate));
    const cell = pointKey(coordinates);
    if (cells.has(cell)) issues.push("duplicate keyform inputs");
    cells.add(cell);
  }
  if (axes.some((axis) => axis.size < 2) || cells.size !== axes.reduce((count, axis) => count * axis.size, 1)) {
    issues.push("keyforms must fill the rectangular grid");
  }
  return [...new Set(issues)];
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

function pointKey(coordinates: readonly number[]): string {
  return coordinates.join("\u0000");
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
