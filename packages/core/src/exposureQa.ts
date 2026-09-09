import { detailRegionForRig, isDetailRegionId, type DetailRegionId } from "./detailRegions.js";
import { modelingPoseValuesForRig } from "./modeling.js";
import { decodePng, type RgbaImage } from "./png.js";
import { previewParameterValuesForRig } from "./parameters.js";
import { renderRigScreenshot } from "./serverRenderer.js";
import type { ParameterValues, RigDocument } from "./types.js";

export interface ExposureSweepRequest {
  poses?: string[];
  regions?: string[];
  width?: number;
  height?: number;
  physics?: boolean;
  physicsTime?: number;
  physicsSteps?: number;
  alphaThreshold?: number;
  minLostPixels?: number;
  maxLostRatio?: number;
  motionRadius?: number;
  /** Optional fixed neutral base values for deterministic read-only gates. */
  baseValues?: ParameterValues;
}

export interface ExposureEntry {
  poseId: string;
  region: DetailRegionId;
  neutralOpaquePixels: number;
  poseOpaquePixels: number;
  lostPixels: number;
  exposedPixels: number;
  gainedPixels: number;
  lostRatio: number;
  exposedRatio: number;
  lostAreaRatio: number;
  suspect: boolean;
  lostBBox?: { left: number; top: number; width: number; height: number };
  exposedBBox?: { left: number; top: number; width: number; height: number };
}

export interface ExposureSweepResult {
  ok: boolean;
  poses: string[];
  regions: DetailRegionId[];
  width: number;
  height: number;
  alphaThreshold: number;
  minLostPixels: number;
  maxLostRatio: number;
  motionRadius: number;
  entries: ExposureEntry[];
  suspect: ExposureEntry[];
  renderedCount: number;
  summary: {
    entryCount: number;
    suspectCount: number;
    maxLostPixels: number;
    maxExposedPixels: number;
    maxExposedRatio: number;
    totalLostPixels: number;
    totalExposedPixels: number;
  };
}

const DEFAULT_POSES = ["neutral", "face-left", "face-right", "face-up", "face-down", "tilt-left", "tilt-right", "mouth-flat", "mouth-half", "mouth-open", "blink"];
const DEFAULT_REGIONS: DetailRegionId[] = ["face", "eyes", "mouth", "hair-roots", "hair-tail-left", "hair-tail-right", "neck", "shoulders"];

export async function runExposureSweep(rig: RigDocument, publicDir: string, request: ExposureSweepRequest = {}): Promise<ExposureSweepResult> {
  const poses = unique(request.poses?.length ? request.poses : DEFAULT_POSES);
  const regions = unique(request.regions?.length ? request.regions : DEFAULT_REGIONS).filter(isDetailRegionId) as DetailRegionId[];
  const width = clampInteger(request.width ?? 240, 64, 480);
  const height = clampInteger(request.height ?? 240, 64, 480);
  const physics = request.physics === true;
  const physicsTime = finite(request.physicsTime, 0);
  const physicsSteps = clampInteger(request.physicsSteps ?? 18, 0, 240);
  const alphaThreshold = clampInteger(request.alphaThreshold ?? 8, 1, 254);
  const minLostPixels = clampInteger(request.minLostPixels ?? 4, 1, width * height);
  const maxLostRatio = clampRatio(request.maxLostRatio, 0.08);
  const motionRadius = clampInteger(request.motionRadius ?? 4, 0, 16);
  const baseValues = request.baseValues ?? previewParameterValuesForRig(rig);
  const entries: ExposureEntry[] = [];

  for (const region of regions.length ? regions : ["full" as DetailRegionId]) {
    const neutral = await renderExposureImage(rig, publicDir, "neutral", region, width, height, physics, physicsTime, physicsSteps, baseValues);
    for (const poseId of poses) {
      if (poseId === "neutral") {
        const opaque = countOpaque(neutral, alphaThreshold);
        entries.push({ poseId, region, neutralOpaquePixels: opaque, poseOpaquePixels: opaque, lostPixels: 0, exposedPixels: 0, gainedPixels: 0, lostRatio: 0, exposedRatio: 0, lostAreaRatio: 0, suspect: false });
        continue;
      }
      const image = await renderExposureImage(rig, publicDir, poseId, region, width, height, physics, physicsTime, physicsSteps, baseValues);
      entries.push(compareExposure(neutral, image, poseId, region, alphaThreshold, minLostPixels, maxLostRatio, motionRadius));
    }
  }

  const suspect = entries.filter((entry) => entry.suspect);
  const maxLostPixels = entries.reduce((max, entry) => Math.max(max, entry.lostPixels), 0);
  const maxExposedPixels = entries.reduce((max, entry) => Math.max(max, entry.exposedPixels), 0);
  const maxExposedRatio = entries.reduce((max, entry) => Math.max(max, entry.exposedRatio), 0);
  const totalLostPixels = entries.reduce((sum, entry) => sum + entry.lostPixels, 0);
  const totalExposedPixels = entries.reduce((sum, entry) => sum + entry.exposedPixels, 0);
  return {
    ok: suspect.length === 0,
    poses,
    regions: regions.length ? regions : ["full"],
    width,
    height,
    alphaThreshold,
    minLostPixels,
    maxLostRatio,
    motionRadius,
    entries,
    suspect,
    renderedCount: entries.length,
    summary: { entryCount: entries.length, suspectCount: suspect.length, maxLostPixels, maxExposedPixels, maxExposedRatio: round(maxExposedRatio), totalLostPixels, totalExposedPixels }
  };
}

async function renderExposureImage(rig: RigDocument, publicDir: string, poseId: string, region: DetailRegionId, width: number, height: number, physics: boolean, physicsTime: number, physicsSteps: number, baseValues: ParameterValues): Promise<RgbaImage> {
  const values = modelingPoseValuesForRig(rig, poseId, baseValues);
  if (!values) throw new Error("unknown modeling pose: " + poseId);
  const definition = detailRegionForRig(rig, region);
  const result = await renderRigScreenshot(rig, publicDir, {
    width, height, fitPadding: 12, transparent: true, set: "single", detail: region,
    focusParts: false, partIds: [], forceParts: false,
    values, physics, physicsTime, physicsSteps, supersample: 1
  });
  return decodePng(result.png);
}

function compareExposure(neutral: RgbaImage, pose: RgbaImage, poseId: string, region: DetailRegionId, alphaThreshold: number, minLostPixels: number, maxLostRatio: number, motionRadius: number): ExposureEntry {
  const length = Math.min(neutral.width * neutral.height, pose.width * pose.height);
  let neutralOpaquePixels = 0;
  let poseOpaquePixels = 0;
  let gainedPixels = 0;
  const lostPoints: Array<{ x: number; y: number }> = [];
  const gainedPoints: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < length; index += 1) {
    const neutralOpaque = neutral.data[index * 4 + 3] >= alphaThreshold;
    const poseOpaque = pose.data[index * 4 + 3] >= alphaThreshold;
    if (neutralOpaque) neutralOpaquePixels += 1;
    if (poseOpaque) poseOpaquePixels += 1;
    const x = index % neutral.width;
    const y = Math.floor(index / neutral.width);
    if (neutralOpaque && !poseOpaque) lostPoints.push({ x, y });
    else if (!neutralOpaque && poseOpaque) {
      gainedPixels += 1;
      gainedPoints.push({ x, y });
    }
  }
  const gainedSet = new Set(gainedPoints.map((point) => point.x + ":" + point.y));
  const exposedPoints = lostPoints.filter((point) => !hasNearbyPoint(gainedSet, point, motionRadius));
  const lostBBox = bbox(lostPoints);
  const exposedBBox = bbox(exposedPoints);
  const lostPixels = lostPoints.length;
  const exposedPixels = exposedPoints.length;
  const lostRatio = lostPixels / Math.max(1, neutralOpaquePixels);
  const exposedRatio = exposedPixels / Math.max(1, neutralOpaquePixels);
  const lostAreaRatio = lostPixels / Math.max(1, length);
  const suspect = exposedPixels >= minLostPixels && exposedRatio > maxLostRatio;
  return {
    poseId, region, neutralOpaquePixels, poseOpaquePixels, lostPixels, exposedPixels, gainedPixels,
    lostRatio: round(lostRatio), exposedRatio: round(exposedRatio), lostAreaRatio: round(lostAreaRatio), suspect,
    ...(lostBBox ? { lostBBox } : {}), ...(exposedBBox ? { exposedBBox } : {})
  };
}

function hasNearbyPoint(points: Set<string>, point: { x: number; y: number }, radius: number): boolean {
  if (radius <= 0) return points.has(point.x + ":" + point.y);
  for (let y = point.y - radius; y <= point.y + radius; y += 1) {
    for (let x = point.x - radius; x <= point.x + radius; x += 1) {
      if (points.has(x + ":" + y)) return true;
    }
  }
  return false;
}

function bbox(points: Array<{ x: number; y: number }>): { left: number; top: number; width: number; height: number } | undefined {
  if (!points.length) return undefined;
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function countOpaque(image: RgbaImage, threshold: number): number {
  let count = 0;
  for (let index = 3; index < image.data.length; index += 4) if (image.data[index] >= threshold) count += 1;
  return count;
}

function unique(values: string[]): string[] { return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))]; }
function clampInteger(value: number, min: number, max: number): number { const numeric = Number(value); return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.round(numeric))) : min; }
function clampRatio(value: unknown, fallback: number): number { const numeric = Number(value); return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback; }
function finite(value: unknown, fallback: number): number { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : fallback; }
function round(value: number): number { return Math.round(value * 10000) / 10000; }

