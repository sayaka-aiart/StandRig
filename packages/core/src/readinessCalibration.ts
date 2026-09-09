import { decodePng, type RgbaImage } from "./png.js";
import { defaultParameterValues } from "./parameters.js";
import { renderRigScreenshot } from "./serverRenderer.js";
import { evaluateRigReadiness, type ReadinessMeasurementId, type ReadinessPoint, type ReadinessRect } from "./readiness.js";
import type { ParameterValues, RigDocument, RigPartRole } from "./types.js";

export interface ReadinessCalibrationOptions {
  width?: number;
  height?: number;
  fitPadding?: number;
  alphaThreshold?: number;
}

export interface ReadinessCalibrationMeasurement {
  id: ReadinessMeasurementId;
  label: string;
  status: "calibrated" | "missing";
  coordinateSpace: "stage-render";
  value?: number | ReadinessPoint;
  stageBBox?: ReadinessRect;
  pixelBBox?: ReadinessRect;
  centroid?: ReadinessPoint;
  sourcePartIds: string[];
  opaquePixels: number;
  confidence: number;
  note: string;
}

export interface RigReadinessCalibrationReport {
  format: "standrig-readiness-calibration-report";
  version: 1;
  source: {
    name: string;
    schemaVersion: string;
    stage: { width: number; height: number };
  };
  neutral: {
    pose: "neutral";
    values: ParameterValues;
    physics: false;
    physicsTime: 0;
    physicsSteps: 0;
  };
  render: {
    width: number;
    height: number;
    fitPadding: number;
    alphaThreshold: number;
    scale: number;
    offset: ReadinessPoint;
    coordinateSpace: "stage";
    method: "role-alpha-mask";
  };
  status: "calibrated" | "partial" | "missing";
  items: ReadinessCalibrationMeasurement[];
  readiness: {
    L1: number;
    L2: number;
    L3: number;
    requestedLevel: "L2";
    requestedLevelReady: boolean;
  };
  nextAction: string;
}

interface AlphaStats {
  opaquePixels: number;
  pixelBBox?: ReadinessRect;
  stageBBox?: ReadinessRect;
  centroid?: ReadinessPoint;
}

const DEFAULT_WIDTH = 768;
const DEFAULT_ALPHA_THRESHOLD = 8;

export async function calibrateRigReadiness(rig: RigDocument, publicDir: string, options: ReadinessCalibrationOptions = {}): Promise<RigReadinessCalibrationReport> {
  const width = clampInteger(options.width ?? DEFAULT_WIDTH, 256, 1536);
  const height = clampInteger(options.height ?? Math.round(width * rig.stage.height / Math.max(1, rig.stage.width)), 256, 2048);
  const fitPadding = clampInteger(options.fitPadding ?? 16, 0, 128);
  const alphaThreshold = clampInteger(options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD, 1, 254);
  const scale = Math.max(0.001, Math.min((width - fitPadding * 2) / Math.max(1, rig.stage.width), (height - fitPadding * 2) / Math.max(1, rig.stage.height)));
  const offset = {
    x: (width - rig.stage.width * scale) / 2,
    y: (height - rig.stage.height * scale) / 2
  };
  const imageByKey = new Map<string, RgbaImage>();
  const itemSpecs = calibrationSpecs(rig);
  const items: ReadinessCalibrationMeasurement[] = [];
  for (const spec of itemSpecs) {
    const sourcePartIds = spec.partIds;
    const key = sourcePartIds.join(",");
    let image = imageByKey.get(key);
    if (!image && sourcePartIds.length) {
      const result = await renderRigScreenshot(rig, publicDir, {
        width,
        height,
        fitPadding,
        transparent: true,
        set: "single",
        detail: "full",
        focusParts: false,
        partIds: sourcePartIds,
        forceParts: false,
        values: defaultParameterValues(rig),
        physics: false,
        physicsTime: 0,
        physicsSteps: 0,
        supersample: 1
      });
      image = decodePng(result.png);
      imageByKey.set(key, image);
    }
    const stats = image ? alphaStats(image, alphaThreshold, scale, offset) : { opaquePixels: 0 };
    items.push(measurementFromStats(spec.id, spec.label, spec.partIds, stats, spec.note));
  }
  const status = items.every((item) => item.status === "calibrated") ? "calibrated" : items.some((item) => item.status === "calibrated") ? "partial" : "missing";
  const readiness = evaluateRigReadiness(rig, { level: "L2" });
  return {
    format: "standrig-readiness-calibration-report",
    version: 1,
    source: { name: rig.name, schemaVersion: rig.schemaVersion, stage: { width: rig.stage.width, height: rig.stage.height } },
    neutral: { pose: "neutral", values: defaultParameterValues(rig), physics: false, physicsTime: 0, physicsSteps: 0 },
    render: { width, height, fitPadding, alphaThreshold, scale: round(scale), offset: { x: round(offset.x), y: round(offset.y) }, coordinateSpace: "stage", method: "role-alpha-mask" },
    status,
    items,
    readiness: { L1: readiness.levels.L1.coverageRatio, L2: readiness.levels.L2.coverageRatio, L3: readiness.levels.L3.coverageRatio, requestedLevel: "L2", requestedLevelReady: readiness.requestedLevelReady },
    nextAction: status === "calibrated"
      ? "Use these stage-render landmarks to calibrate recipe ratios; keep the proxy measurements as provenance."
      : "Resolve missing visible role pixels before promoting the recipe."
  };
}

interface CalibrationSpec {
  id: ReadinessMeasurementId;
  label: string;
  partIds: string[];
  note: string;
}

function calibrationSpecs(rig: RigDocument): CalibrationSpec[] {
  const roleParts = (role: Exclude<RigPartRole, "unknown">) => rig.parts.filter((part) => part.kind === "image" && part.assetId && part.visible !== false && part.role === role && part.roleStatus === "confirmed");
  const byId = (role: Exclude<RigPartRole, "unknown">) => roleParts(role).map((part) => part.id);
  const shoulderParts = roleParts("clothing").filter((part) => /肩|服首|首下|胸元フリル|shoulder|collar/i.test(part.name) || (part.tags ?? []).some((tag) => /shoulder|collar/i.test(tag)));
  const shoulderIds = (shoulderParts.length ? shoulderParts : roleParts("clothing")).map((part) => part.id);
  return [
    { id: "eye-center-left", label: "Left eye center", partIds: byId("eye-left"), note: "Neutral rendered alpha centroid of confirmed left-eye image parts." },
    { id: "eye-center-right", label: "Right eye center", partIds: byId("eye-right"), note: "Neutral rendered alpha centroid of confirmed right-eye image parts." },
    { id: "jaw-tip", label: "Jaw tip", partIds: byId("face"), note: "Bottom-center of the neutral rendered face-role mask." },
    { id: "neck-width", label: "Neck width", partIds: byId("neck"), note: "Width of the neutral rendered neck-role mask." },
    { id: "shoulder-span", label: "Shoulder span", partIds: shoulderIds, note: "Width of the neutral rendered shoulder/collar subset; falls back to clothing role when no shoulder subset exists." },
    { id: "hairline", label: "Hairline top", partIds: byId("hair-front"), note: "Top edge of the neutral rendered front-hair role mask." }
  ];
}

function measurementFromStats(id: ReadinessMeasurementId, label: string, sourcePartIds: string[], stats: AlphaStats, note: string): ReadinessCalibrationMeasurement {
  const value = stats.stageBBox ? id === "eye-center-left" || id === "eye-center-right"
    ? stats.centroid
    : id === "jaw-tip"
      ? { x: stats.stageBBox.left + stats.stageBBox.width / 2, y: stats.stageBBox.top + stats.stageBBox.height }
      : id === "neck-width" || id === "shoulder-span"
        ? stats.stageBBox.width
        : stats.stageBBox.top
    : undefined;
  return {
    id, label, status: value === undefined ? "missing" : "calibrated", coordinateSpace: "stage-render", value: value === undefined ? undefined : roundValue(value),
    ...(stats.stageBBox ? { stageBBox: roundRect(stats.stageBBox) } : {}),
    ...(stats.pixelBBox ? { pixelBBox: stats.pixelBBox } : {}),
    ...(stats.centroid ? { centroid: roundPoint(stats.centroid) } : {}),
    sourcePartIds, opaquePixels: stats.opaquePixels, confidence: value === undefined ? 0 : 0.85, note
  };
}

function alphaStats(image: RgbaImage, threshold: number, scale: number, offset: ReadinessPoint): AlphaStats {
  let opaquePixels = 0;
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  let weight = 0;
  let centroidX = 0;
  let centroidY = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.data[(y * image.width + x) * 4 + 3];
      if (alpha < threshold) continue;
      opaquePixels += 1;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      const pointWeight = alpha / 255;
      weight += pointWeight;
      centroidX += ((x + 0.5 - offset.x) / scale) * pointWeight;
      centroidY += ((y + 0.5 - offset.y) / scale) * pointWeight;
    }
  }
  if (!opaquePixels) return { opaquePixels };
  const pixelBBox = { left, top, width: right - left + 1, height: bottom - top + 1 };
  const stageBBox = { left: (left - offset.x) / scale, top: (top - offset.y) / scale, width: (right + 1 - left) / scale, height: (bottom + 1 - top) / scale };
  return { opaquePixels, pixelBBox, stageBBox, centroid: { x: centroidX / Math.max(weight, 0.0001), y: centroidY / Math.max(weight, 0.0001) } };
}

function roundValue(value: number | ReadinessPoint): number | ReadinessPoint {
  return typeof value === "number" ? round(value) : roundPoint(value);
}
function roundPoint(point: ReadinessPoint): ReadinessPoint { return { x: round(point.x), y: round(point.y) }; }
function roundRect(rect: ReadinessRect): ReadinessRect { return { left: round(rect.left), top: round(rect.top), width: round(rect.width), height: round(rect.height) }; }
function round(value: number): number { return Math.round(value * 10000) / 10000; }
function clampInteger(value: number, min: number, max: number): number { const numeric = Number(value); return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.round(numeric))) : min; }
