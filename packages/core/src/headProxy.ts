import type { ParameterValues, RigDocument, RigPart } from "./types.js";

export type HeadProxyLandmarkId = "faceCenter" | "leftEye" | "rightEye" | "nose" | "mouth" | "chin" | "leftEar" | "rightEar";
export type HeadProxyFitMethod = "role-bounds" | "role-bounds-calibrated";

export interface HeadProxyCalibrationOverrides {
  leftEye?: { x: number; y: number };
  rightEye?: { x: number; y: number };
  chin?: { x: number; y: number };
}

export interface HeadProxyPoint {
  x: number;
  y: number;
  weight: number;
  sourcePartIds?: string[];
}

export interface HeadProxyBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface HeadProxy {
  version: 1;
  fitMethod: HeadProxyFitMethod;
  axisX: number;
  bounds: HeadProxyBounds;
  landmarks: Record<HeadProxyLandmarkId, HeadProxyPoint>;
  sourcePartIds: Record<string, string[]>;
}

export interface HeadProxyPoseCandidate {
  values: ParameterValues;
  scaleX: number;
  scaleY: number;
  landmarkOffsets: Record<HeadProxyLandmarkId, { x: number; y: number }>;
}

export function fitHeadProxy(rig: RigDocument, options: { calibration?: HeadProxyCalibrationOverrides } = {}): HeadProxy | undefined {
  const assets = new Map(rig.assets.map((asset) => [asset.id, asset]));
  const face = rig.parts.find((part) => part.role === "face" && part.assetId && assets.has(part.assetId));
  if (!face) return undefined;
  const bounds = partBounds(face, assets);
  if (!bounds) return undefined;
  const eyeLeft = options.calibration?.leftEye ?? averagePartCenter(rig.parts.filter((part) => part.role === "eye-left" && part.visible && part.assetId && assets.has(part.assetId)), assets);
  const eyeRight = options.calibration?.rightEye ?? averagePartCenter(rig.parts.filter((part) => part.role === "eye-right" && part.visible && part.assetId && assets.has(part.assetId)), assets);
  const mouthParts = rig.parts.filter((part) => part.role === "mouth" && part.visible && part.assetId && assets.has(part.assetId));
  const mouth = averagePartCenter(mouthParts, assets) ?? { x: bounds.left + bounds.width * 0.5, y: bounds.top + bounds.height * 0.76 };
  const leftEye = eyeLeft ?? { x: bounds.left + bounds.width * 0.32, y: bounds.top + bounds.height * 0.53 };
  const rightEye = eyeRight ?? { x: bounds.left + bounds.width * 0.68, y: bounds.top + bounds.height * 0.53 };
  const axisX = bounds.left + bounds.width * 0.5;
  const faceCenter = { x: axisX, y: bounds.top + bounds.height * 0.5 };
  const chin = options.calibration?.chin ?? { x: axisX, y: bounds.top + bounds.height * 0.96 };
  const landmarks: Record<HeadProxyLandmarkId, HeadProxyPoint> = {
    faceCenter: { ...faceCenter, weight: 1, sourcePartIds: [face.id] },
    leftEye: { ...leftEye, weight: 1, sourcePartIds: rig.parts.filter((part) => part.role === "eye-left" && part.visible).map((part) => part.id) },
    rightEye: { ...rightEye, weight: 1, sourcePartIds: rig.parts.filter((part) => part.role === "eye-right" && part.visible).map((part) => part.id) },
    nose: { x: (leftEye.x + rightEye.x) * 0.5, y: (leftEye.y + rightEye.y) * 0.5 + bounds.height * 0.22, weight: 0.8 },
    mouth: { ...mouth, weight: 1, sourcePartIds: mouthParts.map((part) => part.id) },
    chin: { ...chin, weight: 0.9, sourcePartIds: [face.id] },
    leftEar: { x: bounds.left + bounds.width * 0.03, y: bounds.top + bounds.height * 0.52, weight: 0.4, sourcePartIds: [face.id] },
    rightEar: { x: bounds.left + bounds.width * 0.97, y: bounds.top + bounds.height * 0.52, weight: 0.4, sourcePartIds: [face.id] }
  };
  return {
    version: 1,
    fitMethod: options.calibration ? "role-bounds-calibrated" : "role-bounds",
    axisX,
    bounds,
    landmarks,
    sourcePartIds: {
      face: [face.id],
      eyeLeft: landmarks.leftEye.sourcePartIds ?? [],
      eyeRight: landmarks.rightEye.sourcePartIds ?? [],
      mouth: landmarks.mouth.sourcePartIds ?? [],
      neck: rig.parts.filter((part) => part.role === "neck" && part.visible).map((part) => part.id)
    }
  };
}

export function headProxyPoseCandidates(proxy: HeadProxy): HeadProxyPoseCandidate[] {
  const candidates: HeadProxyPoseCandidate[] = [];
  for (const angleX of [-30, 0, 30]) {
    for (const angleY of [-30, 0, 30]) {
      const yaw = angleX / 30;
      const pitch = angleY / 30;
      const scaleX = 1 - Math.abs(yaw) * 0.055;
      const scaleY = 1 - Math.abs(pitch) * 0.045;
      const landmarkOffsets = {} as Record<HeadProxyLandmarkId, { x: number; y: number }>;
      for (const [id, point] of Object.entries(proxy.landmarks) as Array<[HeadProxyLandmarkId, HeadProxyPoint]>) {
        const relativeX = point.x - proxy.axisX;
        const relativeY = point.y - (proxy.bounds.top + proxy.bounds.height * 0.5);
        const side = relativeX === 0 ? 0 : relativeX < 0 ? -1 : 1;
        const yawShift = -yaw * proxy.bounds.width * 0.025 + side * yaw * Math.abs(relativeX) * 0.045;
        const pitchShift = pitch * proxy.bounds.height * 0.018 + pitch * relativeY * 0.035;
        landmarkOffsets[id] = { x: round(yawShift), y: round(pitchShift) };
      }
      candidates.push({
        values: { ParamAngleX: angleX, ParamAngleY: angleY },
        scaleX: round(scaleX),
        scaleY: round(scaleY),
        landmarkOffsets
      });
    }
  }
  return candidates;
}

function partBounds(part: RigPart, assets: Map<string, { id: string; width?: number; height?: number }>): HeadProxyBounds | undefined {
  const asset = part.assetId ? assets.get(part.assetId) : undefined;
  if (!asset || !Number.isFinite(asset.width) || !Number.isFinite(asset.height) || (asset.width ?? 0) <= 0 || (asset.height ?? 0) <= 0) return undefined;
  const scaleX = Number.isFinite(part.transform.scaleX) ? part.transform.scaleX : 1;
  const scaleY = Number.isFinite(part.transform.scaleY) ? part.transform.scaleY : 1;
  return { left: part.transform.x, top: part.transform.y, width: (asset.width ?? 0) * scaleX, height: (asset.height ?? 0) * scaleY };
}

function averagePartCenter(parts: RigPart[], assets: Map<string, { id: string; width?: number; height?: number }>): { x: number; y: number } | undefined {
  const centers = parts.map((part) => {
    const bounds = partBounds(part, assets);
    return bounds ? { x: bounds.left + bounds.width * 0.5, y: bounds.top + bounds.height * 0.5 } : undefined;
  }).filter((point): point is { x: number; y: number } => Boolean(point));
  if (!centers.length) return undefined;
  return { x: centers.reduce((sum, point) => sum + point.x, 0) / centers.length, y: centers.reduce((sum, point) => sum + point.y, 0) / centers.length };
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
