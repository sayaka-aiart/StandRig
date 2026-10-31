import { applyParameterInterpolation, normalizeParameterInterpolation } from "./bindings.js";
import type { ParameterCurve, ParameterInterpolation, ParameterValues } from "./types.js";
import { evaluationCache } from "./evaluationCache.js";

export type GridParameters = [string, string] | [string, string, string];
interface GridKey { inputs: Record<string, number> }

interface GridIndex<T> { axes: number[][]; points: Map<string, T> }
function indexGrid<T extends GridKey>(parameters: GridParameters, keys: readonly T[]): GridIndex<T> {
  const axes = parameters.map(() => new Set<number>()), points = new Map<string, T>();
  for (const key of keys ?? []) {
    const coordinates = parameters.map(p => key?.inputs?.[p]);
    if (!coordinates.every(Number.isFinite)) continue;
    coordinates.forEach((value, axis) => axes[axis].add(value));
    points.set(coordinates.join("|"), key);
  }
  return { axes: axes.map(axis => [...axis].sort((a, b) => a - b)), points };
}

/** Missing cells yield no sample rather than inventing a deformation. */
export function sampleParameterGrid<T extends GridKey>(parameters: GridParameters, keys: readonly T[], values: ParameterValues,
  interpolation?: ParameterInterpolation, curve?: ParameterCurve): Array<{ key: T; weight: number }> {
  if (!validGridParameters(parameters)) return [];
  const indexes = Array.isArray(keys) ? evaluationCache()?.get("parameter-grids", keys, () => new WeakMap<object, GridIndex<T>>()) : undefined;
  let index = indexes?.get(parameters);
  if (!index) { index = indexGrid(parameters, keys); indexes?.set(parameters, index); }
  const { axes, points } = index;
  const spans = axes.map((ordered, i) => {
    if (ordered.length < 2) return undefined;
    const raw = values[parameters[i]] ?? 0;
    const value = Math.max(ordered[0], Math.min(ordered.at(-1)!, raw));
    let lo = 0, hi = ordered.length - 2;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (ordered[mid + 1] < value) lo = mid + 1; else hi = mid; }
    const low = ordered[lo], high = ordered[lo + 1];
    return { low, high, t: applyParameterInterpolation(normalizeParameterInterpolation(interpolation), (value - low) / (high - low), curve) };
  });
  if (spans.some(span => !span)) return [];
  const result: Array<{ key: T; weight: number }> = [];
  for (let corner = 0; corner < 2 ** parameters.length; corner++) {
    let weight = 1;
    const coordinates = spans.map((span, axis) => {
      const high = Boolean(corner & (1 << axis)); weight *= high ? span!.t : 1 - span!.t;
      return high ? span!.high : span!.low;
    });
    const key = points.get(coordinates.join("|"));
    if (!key) return [];
    // Keep zero-weight corners: legacy replacement mesh bindings still clear
    // offsets for IDs authored only at the other end of an enclosing cell.
    result.push({ key, weight });
  }
  return result;
}

export function validGridParameters(parameters: unknown): parameters is GridParameters {
  return Array.isArray(parameters) && [2, 3].includes(parameters.length) &&
    parameters.every(p => typeof p === "string" && p.trim().length > 0) && new Set(parameters).size === parameters.length;
}

export function parameterGridIssues(parameters: GridParameters, keys: readonly GridKey[], known: ReadonlySet<string>): string[] {
  if (!validGridParameters(parameters) || parameters.some(p => !known.has(p)) || !Array.isArray(keys) || !keys.length)
    return ["Grid needs two or three distinct known parameters and finite keyforms"];
  const issues: string[] = [], axes = parameters.map(() => new Set<number>()), cells = new Set<string>();
  for (const key of keys) {
    const values = parameters.map(p => key?.inputs?.[p]);
    if (!values.every(Number.isFinite)) { issues.push("Grid inputs must be finite"); continue; }
    values.forEach((value, i) => axes[i].add(value));
    const cell = values.join("|"); if (cells.has(cell)) issues.push("Duplicate grid keyform inputs"); cells.add(cell);
  }
  if (axes.some(axis => axis.size < 2) || cells.size !== axes.reduce((count, axis) => count * axis.size, 1))
    issues.push("Keyforms must fill the enclosing rectangular grid");
  return issues;
}
