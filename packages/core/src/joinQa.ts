import { runExposureSweep, type ExposureSweepResult } from "./exposureQa.js";
import { resolvePartClip } from "./mask.js";
import { modelingPoseValuesForRig } from "./modeling.js";
import { previewParameterValuesForRig } from "./parameters.js";
import { decodePng, type RgbaImage } from "./png.js";
import { renderRigScreenshot } from "./serverRenderer.js";
import { readRigGlue, readRigGlueCandidates } from "./glue.js";
import type { RigDocument, RigPart } from "./types.js";

export interface JoinQaPairInput {
  partAId: string;
  partBId: string;
  source?: string;
  maxGapDistance?: number;
}

export interface JoinQaRequest {
  poses?: string[];
  pairs?: JoinQaPairInput[];
  includeCandidates?: boolean;
  width?: number;
  height?: number;
  alphaThreshold?: number;
  contactRadius?: number;
  maxGapDistance?: number;
  maxGapPixels?: number;
  strict?: boolean;
  physics?: boolean;
  physicsTime?: number;
  physicsSteps?: number;
  includeMaskAudit?: boolean;
  includeExposure?: boolean;
}

export interface JoinQaPairEntry {
  poseId: string;
  source: string;
  partAId: string;
  partBId: string;
  partAExists: boolean;
  partBExists: boolean;
  partAPixels: number;
  partBPixels: number;
  overlapPixels: number;
  overlapRatio: number;
  boundaryAPixels: number;
  boundaryBPixels: number;
  contactAPixels: number;
  contactBPixels: number;
  contactRatio: number;
  gapPixels: number;
  minGapDistance: number | null;
  maxGapDistance: number;
  pass: boolean;
  issues: string[];
}

export interface MaskQaEntry {
  poseId: string;
  ownerPartId: string;
  contentPartIds: string[];
  maskPartIds: string[];
  contentPixels: number;
  maskPixels: number;
  maskLeakPixels: number;
  maskLeakRatio: number;
  pass: boolean;
  issues: string[];
}

export interface DrawOrderQaResult {
  imagePartCount: number;
  duplicateDrawOrders: Array<{ drawOrder: number; partIds: string[] }>;
  clipOwners: Array<{ ownerPartId: string; contentPartIds: string[]; maskPartIds: string[] }>;
  pass: boolean;
}

export interface JoinQaResult {
  ok: boolean;
  poses: string[];
  width: number;
  height: number;
  alphaThreshold: number;
  contactRadius: number;
  strict: boolean;
  includeCandidates: boolean;
  pairs: JoinQaPairEntry[];
  failedPairs: JoinQaPairEntry[];
  masks: MaskQaEntry[];
  failedMasks: MaskQaEntry[];
  drawOrder: DrawOrderQaResult;
  exposure?: ExposureSweepResult;
  summary: {
    pairCount: number;
    failedPairCount: number;
    maskCount: number;
    failedMaskCount: number;
    maxGapPixels: number;
    maxMinGapDistance: number;
    maxMaskLeakPixels: number;
    maxExposedPixels: number;
  };
}

const DEFAULT_POSES = ["neutral", "face-left", "face-right", "face-up", "face-down", "body-left", "body-right", "mouth-open", "blink"];

export async function runJoinQa(rig: RigDocument, publicDir: string, request: JoinQaRequest = {}): Promise<JoinQaResult> {
  const poses = unique(request.poses?.length ? request.poses : DEFAULT_POSES);
  const width = clampInteger(request.width ?? 160, 64, 480);
  const height = clampInteger(request.height ?? 160, 64, 480);
  const alphaThreshold = clampInteger(request.alphaThreshold ?? 8, 1, 254);
  const contactRadius = clampInteger(request.contactRadius ?? 4, 0, 32);
  const defaultMaxGapDistance = clampNumber(request.maxGapDistance, 0, 64, contactRadius);
  const strict = request.strict === true;
  const defaultMaxGapPixels = clampInteger(request.maxGapPixels ?? 0, 0, width * height);
  const pairInputs = normalizePairs(rig, request.pairs, request.includeCandidates === true);
  const imageCache = new Map<string, Promise<RgbaImage>>();
  const pairs: JoinQaPairEntry[] = [];

  for (const poseId of poses) {
    for (const pair of pairInputs) {
      const partA = rig.parts.find((part) => part.id === pair.partAId);
      const partB = rig.parts.find((part) => part.id === pair.partBId);
      const imageA = partA?.kind === "image" && partA.assetId ? await cachedPartImage(imageCache, rig, publicDir, poseId, partA.id, width, height, request) : undefined;
      const imageB = partB?.kind === "image" && partB.assetId ? await cachedPartImage(imageCache, rig, publicDir, poseId, partB.id, width, height, request) : undefined;
      const maxGapDistance = clampNumber(pair.maxGapDistance, 0, 64, defaultMaxGapDistance);
      pairs.push(comparePair(poseId, pair.source ?? "manual", pair.partAId, pair.partBId, imageA, imageB, Boolean(partA?.visible && partA.transform.opacity > 0), Boolean(partB?.visible && partB.transform.opacity > 0), alphaThreshold, contactRadius, maxGapDistance, strict, defaultMaxGapPixels));
    }
  }

  const masks = request.includeMaskAudit === false ? [] : await auditMasks(rig, publicDir, poses, width, height, alphaThreshold, request, imageCache);
  const drawOrder = auditDrawOrder(rig);
  const exposure = request.includeExposure === false ? undefined : await runExposureSweep(rig, publicDir, {
    poses,
    regions: ["mouth", "hair-roots", "neck", "shoulders"],
    width,
    height,
    physics: request.physics,
    physicsTime: request.physicsTime,
    physicsSteps: request.physicsSteps,
    alphaThreshold,
    maxLostRatio: 0.08,
    motionRadius: 4
  });
  const failedPairs = pairs.filter((entry) => !entry.pass);
  const failedMasks = masks.filter((entry) => !entry.pass);
  const maxMinGapDistance = pairs.reduce((max, entry) => Math.max(max, entry.minGapDistance ?? 0), 0);
  const maxExposedPixels = exposure?.summary.maxExposedPixels ?? 0;
  const ok = failedPairs.length === 0 && failedMasks.length === 0 && drawOrder.pass && (!exposure || exposure.suspect.length === 0);
  return {
    ok, poses, width, height, alphaThreshold, contactRadius, strict, includeCandidates: request.includeCandidates === true, pairs, failedPairs, masks, failedMasks, drawOrder, exposure,
    summary: {
      pairCount: pairs.length,
      failedPairCount: failedPairs.length,
      maskCount: masks.length,
      failedMaskCount: failedMasks.length,
      maxGapPixels: pairs.reduce((max, entry) => Math.max(max, entry.gapPixels), 0),
      maxMinGapDistance,
      maxMaskLeakPixels: masks.reduce((max, entry) => Math.max(max, entry.maskLeakPixels), 0),
      maxExposedPixels
    }
  };
}

function normalizePairs(rig: RigDocument, input: JoinQaPairInput[] | undefined, includeCandidates = false): JoinQaPairInput[] {
  if (Array.isArray(input) && input.length) {
    return input.filter((pair) => typeof pair?.partAId === "string" && typeof pair?.partBId === "string" && pair.partAId !== pair.partBId).slice(0, 64);
  }
  const result: JoinQaPairInput[] = [];
  const keys = new Set<string>();
  const push = (partAId: string, partBId: string, source: string) => {
    if (!rig.parts.some((part) => part.id === partAId) || !rig.parts.some((part) => part.id === partBId) || partAId === partBId) return;
    const key = [partAId, partBId].sort().join("|");
    if (keys.has(key)) return;
    keys.add(key);
    result.push({ partAId, partBId, source });
  };
  for (const glue of readRigGlue(rig).filter((entry) => entry.enabled && entry.status === "active")) push(glue.partAId, glue.partBId, "glue:" + glue.id);
  for (const candidate of readRigGlueCandidates(rig).filter((entry) => entry.enabled && (entry.status === "accepted" || (includeCandidates && entry.status === "candidate")))) push(candidate.partAId, candidate.partBId, "candidate:" + candidate.id);
  return result;
}

function comparePair(poseId: string, source: string, partAId: string, partBId: string, imageA: RgbaImage | undefined, imageB: RgbaImage | undefined, partAActive: boolean, partBActive: boolean, threshold: number, radius: number, maxGapDistance: number, strict: boolean, maxGapPixels: number): JoinQaPairEntry {
  const partAExists = Boolean(imageA);
  const partBExists = Boolean(imageB);
  if (!imageA || !imageB) {
    return { poseId, source, partAId, partBId, partAExists, partBExists, partAPixels: 0, partBPixels: 0, overlapPixels: 0, overlapRatio: 0, boundaryAPixels: 0, boundaryBPixels: 0, contactAPixels: 0, contactBPixels: 0, contactRatio: 0, gapPixels: 0, minGapDistance: null, maxGapDistance, pass: false, issues: ["missing-image-part"] };
  }
  if (!partAActive || !partBActive) {
    return { poseId, source, partAId, partBId, partAExists, partBExists, partAPixels: 0, partBPixels: 0, overlapPixels: 0, overlapRatio: 0, boundaryAPixels: 0, boundaryBPixels: 0, contactAPixels: 0, contactBPixels: 0, contactRatio: 0, gapPixels: 0, minGapDistance: null, maxGapDistance, pass: true, issues: ["non-rendering-part"] };
  }
  const maskA = alphaMask(imageA, threshold);
  const maskB = alphaMask(imageB, threshold);
  const boundaryA = boundaryPoints(maskA, imageA.width, imageA.height);
  const boundaryB = boundaryPoints(maskB, imageA.width, imageA.height);
  const contactA = boundaryA.filter((point) => hasNearby(maskB, imageA.width, imageA.height, point.x, point.y, radius)).length;
  const contactB = boundaryB.filter((point) => hasNearby(maskA, imageA.width, imageA.height, point.x, point.y, radius)).length;
  const gapPixels = (boundaryA.length - contactA) + (boundaryB.length - contactB);
  const minGapDistance = minBoundaryDistance(boundaryA, boundaryB, radius + 32);
  let overlapPixels = 0;
  let partAPixels = 0;
  let partBPixels = 0;
  for (let index = 0; index < maskA.length; index += 1) {
    if (maskA[index]) partAPixels += 1;
    if (maskB[index]) partBPixels += 1;
    if (maskA[index] && maskB[index]) overlapPixels += 1;
  }
  const overlapRatio = overlapPixels / Math.max(1, Math.min(partAPixels, partBPixels));
  const contactRatio = (contactA + contactB) / Math.max(1, boundaryA.length + boundaryB.length);
  const issues: string[] = [];
  if (!partAPixels || !partBPixels) issues.push("empty-part");
  if (minGapDistance !== null && minGapDistance > maxGapDistance) issues.push("seam-distance");
  if (strict && gapPixels > maxGapPixels) issues.push("gap-pixels");
  return { poseId, source, partAId, partBId, partAExists, partBExists, partAPixels, partBPixels, overlapPixels, overlapRatio: round(overlapRatio), boundaryAPixels: boundaryA.length, boundaryBPixels: boundaryB.length, contactAPixels: contactA, contactBPixels: contactB, contactRatio: round(contactRatio), gapPixels, minGapDistance: minGapDistance === null ? null : round(minGapDistance), maxGapDistance, pass: issues.length === 0, issues };
}

async function auditMasks(rig: RigDocument, publicDir: string, poses: string[], width: number, height: number, threshold: number, request: JoinQaRequest, cache: Map<string, Promise<RgbaImage>>): Promise<MaskQaEntry[]> {
  const groups = new Map<string, { owner: RigPart; contentPartIds: string[]; maskPartIds: string[] }>();
  for (const part of rig.parts.filter((entry) => entry.kind === "image" && entry.assetId)) {
    const resolved = resolvePartClip(rig, part);
    if (!resolved) continue;
    const group = groups.get(resolved.owner.id) ?? { owner: resolved.owner, contentPartIds: [], maskPartIds: resolved.maskPartIds };
    group.contentPartIds.push(part.id);
    groups.set(resolved.owner.id, group);
  }
  const entries: MaskQaEntry[] = [];
  for (const poseId of poses) {
    for (const group of groups.values()) {
      const content = await cachedPartSetImage(cache, rig, publicDir, poseId, group.contentPartIds, width, height, request);
      const masks = await Promise.all(group.maskPartIds.map((partId) => cachedPartImage(cache, rig, publicDir, poseId, partId, width, height, request)));
      const mask = unionImages(masks, width, height);
      let contentPixels = 0;
      let maskPixels = 0;
      let maskLeakPixels = 0;
      for (let index = 0; index < width * height; index += 1) {
        const contentAlpha = content.data[index * 4 + 3] ?? 0;
        const maskAlpha = mask.data[index * 4 + 3] ?? 0;
        if (contentAlpha >= threshold) contentPixels += 1;
        if (maskAlpha >= threshold) maskPixels += 1;
        if (contentAlpha >= threshold && maskAlpha < threshold) maskLeakPixels += 1;
      }
      const maskLeakRatio = maskLeakPixels / Math.max(1, contentPixels);
      entries.push({ poseId, ownerPartId: group.owner.id, contentPartIds: group.contentPartIds, maskPartIds: group.maskPartIds, contentPixels, maskPixels, maskLeakPixels, maskLeakRatio: round(maskLeakRatio), pass: maskLeakPixels === 0, issues: maskLeakPixels ? ["mask-leak"] : [] });
    }
  }
  return entries;
}

function auditDrawOrder(rig: RigDocument): DrawOrderQaResult {
  const imageParts = rig.parts.filter((part) => part.kind === "image" && part.assetId && part.visible);
  const byOrder = new Map<number, string[]>();
  for (const part of imageParts) {
    const ids = byOrder.get(part.drawOrder) ?? [];
    ids.push(part.id);
    byOrder.set(part.drawOrder, ids);
  }
  const duplicateDrawOrders = [...byOrder.entries()].filter(([, ids]) => ids.length > 1).map(([drawOrder, partIds]) => ({ drawOrder, partIds }));
  const clipOwners = new Map<string, { ownerPartId: string; contentPartIds: string[]; maskPartIds: string[] }>();
  for (const part of imageParts) {
    const resolved = resolvePartClip(rig, part);
    if (!resolved) continue;
    const item = clipOwners.get(resolved.owner.id) ?? { ownerPartId: resolved.owner.id, contentPartIds: [], maskPartIds: resolved.maskPartIds };
    item.contentPartIds.push(part.id);
    clipOwners.set(resolved.owner.id, item);
  }
  return { imagePartCount: imageParts.length, duplicateDrawOrders, clipOwners: [...clipOwners.values()], pass: duplicateDrawOrders.length === 0 };
}

async function cachedPartImage(cache: Map<string, Promise<RgbaImage>>, rig: RigDocument, publicDir: string, poseId: string, partId: string, width: number, height: number, request: JoinQaRequest): Promise<RgbaImage> {
  const key = poseId + ":" + partId + ":" + width + ":" + height + ":" + (request.physics === true) + ":" + (request.physicsTime ?? 0) + ":" + (request.physicsSteps ?? 18);
  const existing = cache.get(key);
  if (existing) return existing;
  const promise = renderPartSet(rig, publicDir, poseId, [partId], width, height, request);
  cache.set(key, promise);
  return promise;
}

async function cachedPartSetImage(cache: Map<string, Promise<RgbaImage>>, rig: RigDocument, publicDir: string, poseId: string, partIds: string[], width: number, height: number, request: JoinQaRequest): Promise<RgbaImage> {
  const key = poseId + ":set:" + [...partIds].sort().join(",") + ":" + width + ":" + height + ":" + (request.physics === true) + ":" + (request.physicsTime ?? 0) + ":" + (request.physicsSteps ?? 18);
  const existing = cache.get(key);
  if (existing) return existing;
  const promise = renderPartSet(rig, publicDir, poseId, partIds, width, height, request);
  cache.set(key, promise);
  return promise;
}

async function renderPartSet(rig: RigDocument, publicDir: string, poseId: string, partIds: string[], width: number, height: number, request: JoinQaRequest): Promise<RgbaImage> {
  const values = modelingPoseValuesForRig(rig, poseId, previewParameterValuesForRig(rig));
  if (!values) throw new Error("unknown modeling pose: " + poseId);
  const result = await renderRigScreenshot(rig, publicDir, {
    width, height, fitPadding: 12, transparent: true, set: "single", detail: "full",
    focusParts: false, partIds, forceParts: true, values,
    physics: request.physics === true, physicsTime: finite(request.physicsTime, 0), physicsSteps: clampInteger(request.physicsSteps ?? 18, 0, 240), supersample: 1
  });
  return decodePng(result.png);
}

function unionImages(images: Array<RgbaImage | undefined>, width: number, height: number): RgbaImage {
  const output = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (const image of images) {
    if (!image) continue;
    for (let index = 0; index < width * height; index += 1) output.data[index * 4 + 3] = Math.max(output.data[index * 4 + 3] ?? 0, image.data[index * 4 + 3] ?? 0);
  }
  return output;
}

function alphaMask(image: RgbaImage, threshold: number): Uint8Array {
  const mask = new Uint8Array(image.width * image.height);
  for (let index = 0; index < mask.length; index += 1) mask[index] = (image.data[index * 4 + 3] ?? 0) >= threshold ? 1 : 0;
  return mask;
}

function boundaryPoints(mask: Uint8Array, width: number, height: number): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = y * width + x;
    if (!mask[index]) continue;
    if (!mask[index - 1] || !mask[index + 1] || !mask[index - width] || !mask[index + width]) points.push({ x, y });
  }
  return points;
}

function hasNearby(mask: Uint8Array, width: number, height: number, x: number, y: number, radius: number): boolean {
  for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy += 1) for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx += 1) if (mask[yy * width + xx]) return true;
  return false;
}

function minBoundaryDistance(a: Array<{ x: number; y: number }>, b: Array<{ x: number; y: number }>, maxRadius: number): number | null {
  if (!a.length || !b.length) return null;
  let min = maxRadius + 1;
  for (const point of a) for (let radius = 0; radius <= maxRadius && radius < min; radius += 1) {
    if (b.some((other) => Math.max(Math.abs(other.x - point.x), Math.abs(other.y - point.y)) <= radius)) {
      min = radius;
      break;
    }
  }
  return min;
}

function alphaMaskPointCount(image: RgbaImage, threshold: number): number {
  let count = 0;
  for (let index = 3; index < image.data.length; index += 4) if ((image.data[index] ?? 0) >= threshold) count += 1;
  return count;
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInteger(value: unknown, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : min;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
