import { normalizeArtPath, resolveArtPath, validateArtPath } from "./artPath.js";
import { parameterDefinitionsForRig, previewParameterValuesForRig } from "./parameters.js";
import type { ParameterValues, RigDocument, RigPart } from "./types.js";

export interface ArtPathQaRequest {
  partIds?: string[];
  sampleInputs?: number[];
  width?: number;
  height?: number;
  minStrokeWidth?: number;
  maxStrokeWidth?: number;
}

export interface ArtPathQaEntry {
  partId: string;
  pathId: string;
  pointCount: number;
  bindingCount: number;
  enabled: boolean;
  pass: boolean;
  issues: string[];
  samples: Array<{ input: number; pointCount: number; strokeWidth: number; opacity: number; finite: boolean }>;
}

export interface ArtPathQaResult {
  ok: boolean;
  width: number;
  height: number;
  sampleInputs: number[];
  entries: ArtPathQaEntry[];
  failed: ArtPathQaEntry[];
  summary: { partCount: number; pathCount: number; enabledPathCount: number; pointCount: number; failedCount: number; bindingCount: number };
}

export function runArtPathQa(rig: RigDocument, request: ArtPathQaRequest = {}): ArtPathQaResult {
  const width = positiveInt(request.width, 240);
  const height = positiveInt(request.height, 240);
  const sampleInputs = normalizeSamples(request.sampleInputs);
  const minStrokeWidth = finiteOr(request.minStrokeWidth, 0.25);
  const maxStrokeWidth = finiteOr(request.maxStrokeWidth, 64);
  const values = previewParameterValuesForRig(rig);
  const selected = request.partIds?.length ? new Set(request.partIds) : undefined;
  const entries: ArtPathQaEntry[] = [];
  let pointCount = 0;
  let bindingCount = 0;
  for (const part of rig.parts) {
    if (part.kind !== "image" || (selected && !selected.has(part.id))) continue;
    for (const sourcePath of part.artPaths ?? []) {
      const path = structuredClone(sourcePath);
      normalizeArtPath(path);
      const issues = validateArtPath(path);
      const samples: ArtPathQaEntry["samples"] = [];
      const pathBindingCount = (path.bindings?.length ?? 0) + path.points.reduce((sum, point) => sum + (point.bindings?.length ?? 0), 0);
      pointCount += path.points.length;
      bindingCount += pathBindingCount;
      for (const input of sampleInputs) {
        const sampledValues: ParameterValues = { ...values };
        for (const binding of path.bindings ?? []) sampledValues[binding.parameter] = input;
        for (const point of path.points) for (const binding of point.bindings ?? []) sampledValues[binding.parameter] = input;
        const resolved = resolveArtPath(path, sampledValues, width, height);
        const finite = Boolean(resolved && resolved.points.every((point) => Number.isFinite(point.u) && Number.isFinite(point.v)) && Number.isFinite(resolved.strokeWidth) && Number.isFinite(resolved.opacity));
        const strokeWidth = resolved?.strokeWidth ?? Number.NaN;
        const opacity = resolved?.opacity ?? Number.NaN;
        if (!finite) issues.push(`non-finite-sample:${input}`);
        if (resolved && (strokeWidth < minStrokeWidth || strokeWidth > maxStrokeWidth)) issues.push(`stroke-width-out-of-range:${input}`);
        samples.push({ input, pointCount: resolved?.points.length ?? 0, strokeWidth, opacity, finite });
      }
      if (path.points.some((point) => !Number.isFinite(point.u) || !Number.isFinite(point.v) || point.u < 0 || point.u > 1 || point.v < 0 || point.v > 1)) issues.push("point-coordinate-out-of-range");
      entries.push({ partId: part.id, pathId: path.id, pointCount: path.points.length, bindingCount: pathBindingCount, enabled: path.enabled, pass: issues.length === 0, issues: [...new Set(issues)], samples });
    }
  }
  const failed = entries.filter((entry) => !entry.pass);
  return {
    ok: failed.length === 0,
    width,
    height,
    sampleInputs,
    entries,
    failed,
    summary: {
      partCount: new Set(entries.map((entry) => entry.partId)).size,
      pathCount: entries.length,
      enabledPathCount: entries.filter((entry) => entry.enabled).length,
      pointCount,
      failedCount: failed.length,
      bindingCount
    }
  };
}

function normalizeSamples(samples: number[] | undefined): number[] {
  const source = Array.isArray(samples) && samples.length ? samples : [0, 0.5, 1];
  return [...new Set(source.map(Number).filter(Number.isFinite).map((value) => Math.min(1, Math.max(0, value))))].slice(0, 9);
}

function positiveInt(value: number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(4096, Math.round(parsed)) : fallback;
}

function finiteOr(value: number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
