import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { detailRegionForRig, isDetailRegionId, type DetailRegionId } from "./detailRegions.js";
import { decodeDataUrl } from "./assetManifest.js";
import { inferPartRole } from "./partRoles.js";
import { decodePng, type RgbaImage } from "./png.js";
import type { RigDocument, RigPart } from "./types.js";

export interface GenerationRequestInput {
  role?: string;
  partId?: string;
  region?: string;
  prompt?: string;
  targetWidth?: number;
  targetHeight?: number;
  acceptance?: Partial<GenerationAcceptanceCriteria>;
  provenance?: Record<string, unknown>;
}

export interface GenerationAcceptanceCriteria {
  minWidth: number;
  minHeight: number;
  maxAspectDrift: number;
  minAlphaCoverage: number;
  maxAlphaCoverage: number;
  maxMeanColorDelta: number;
  maxEdgeColorDelta: number;
  minSsim: number;
  requireSsim: boolean;
}

export interface GenerationImageStats {
  width: number;
  height: number;
  alphaCoverage: number;
  meanRgb: [number, number, number];
  edgeMeanRgb: [number, number, number];
  darkPixelRatio: number;
  palette: Array<{ rgb: [number, number, number]; ratio: number }>;
}

export interface GenerationRequest {
  id: string;
  status: "issued" | "accepted" | "rejected";
  createdAt: string;
  baseRevision: string;
  role: string;
  partId?: string;
  region: DetailRegionId;
  source: {
    partId?: string;
    assetId: string;
    assetSha256: string;
    width: number;
    height: number;
    crop: { x: number; y: number; width: number; height: number };
  };
  target: { width: number; height: number };
  styleHints: {
    source: GenerationImageStats;
    lineWidthProxy: number;
  };
  acceptance: GenerationAcceptanceCriteria;
  provenance: {
    prompt: string;
    sourceRegion: string;
    sourcePartIds: string[];
    createdAt: string;
    [key: string]: unknown;
  };
}

export type GeneratedAssetStatus = "active" | "superseded" | "deleted";

export interface GeneratedAssetRecord {
  requestId: string;
  assetId: string;
  path: string;
  sha256: string;
  createdAt: string;
  status: GeneratedAssetStatus;
  deletedAt?: string;
  supersededBy?: string;
  parentAssetId?: string;
  generationIndex?: number;
  provenance: Record<string, unknown>;
  checks: GenerationAcceptanceCheck[];
  metrics: GenerationAcceptanceResult["metrics"];
}

export interface GeneratedAssetListing {
  format: "standrig-generated-assets";
  version: 1;
  entries: GeneratedAssetRecord[];
}

export interface GeneratedAssetDeleteResult {
  ok: boolean;
  assetId: string;
  requestedCommit: boolean;
  committed: boolean;
  status: GeneratedAssetStatus;
  path?: string;
  reason?: string;
}
export interface GenerationAcceptanceInput {
  requestId: string;
  pngBase64?: string;
  png?: string;
  mediaType?: string;
  referencePngBase64?: string;
  acceptance?: Partial<GenerationAcceptanceCriteria>;
  provenance?: Record<string, unknown>;
  assetId?: string;
  commit?: boolean;
}

export interface GenerationAcceptanceCheck {
  id: string;
  pass: boolean;
  value: number | boolean | null;
  threshold?: number;
}

export interface GenerationAcceptanceResult {
  ok: boolean;
  accepted: boolean;
  requestedCommit: boolean;
  committed: false;
  request: GenerationRequest;
  currentRevision: string;
  checks: GenerationAcceptanceCheck[];
  metrics: {
    image: GenerationImageStats;
    sha256: string;
    aspectDrift: number;
    meanColorDelta: number;
    edgeColorDelta: number;
    ssim: number | null;
  };
  assetCandidate: {
    assetId: string;
    path: string;
    sha256: string;
    mediaType: "image/png";
    bytes: number;
  };
  provenance: Record<string, unknown>;
  bytes: Uint8Array;
}

const REQUESTS = new Map<string, GenerationRequest>();
const DEFAULT_ACCEPTANCE: GenerationAcceptanceCriteria = {
  minWidth: 32,
  minHeight: 32,
  maxAspectDrift: 0.45,
  minAlphaCoverage: 0.01,
  maxAlphaCoverage: 1,
  maxMeanColorDelta: 72,
  maxEdgeColorDelta: 96,
  minSsim: 0.75,
  requireSsim: false
};

export async function createGenerationRequest(rig: RigDocument, publicDir: string, revision: string, input: GenerationRequestInput): Promise<GenerationRequest> {
  const part = input.partId ? rig.parts.find((entry) => entry.id === input.partId) : undefined;
  if (input.partId && !part) throw new Error("part not found: " + input.partId);
  const region = isDetailRegionId(input.region) ? input.region : "full";
  const regionDefinition = detailRegionForRig(rig, region);
  const sourcePart = part ?? rig.parts.find((entry) => entry.id !== undefined && regionDefinition.partIds.includes(entry.id) && entry.kind === "image" && Boolean(entry.assetId));
  if (!sourcePart?.assetId) throw new Error("a part with an image asset is required");
  const asset = rig.assets.find((entry) => entry.id === sourcePart.assetId);
  if (!asset) throw new Error("asset not found: " + sourcePart.assetId);
  const sourceBytes = await loadAssetBytes(asset, publicDir);
  const sourceImage = decodePng(sourceBytes);
  const sourceStats = analyzeImage(sourceImage);
  const inferred = inferPartRole(sourcePart);
  const role = String(input.role ?? sourcePart.role ?? inferred?.role ?? "unknown");
  const createdAt = new Date().toISOString();
  const target = {
    width: clampInteger(input.targetWidth ?? 240, 32, 1024),
    height: clampInteger(input.targetHeight ?? 240, 32, 1024)
  };
  const acceptance = normalizeAcceptance(input.acceptance);
  const prompt = String(input.prompt ?? input.provenance?.prompt ?? "inpaint exposed region while preserving the source style");
  const provenance = {
    ...(input.provenance ?? {}),
    prompt,
    sourceRegion: region,
    sourcePartIds: regionDefinition.partIds,
    ...(sourcePart ? { sourcePartId: sourcePart.id } : {}),
    sourceAssetId: asset.id,
    targetWidth: target.width,
    targetHeight: target.height,
    createdAt
  };
  const request: GenerationRequest = {
    id: "gen-" + randomUUID(),
    status: "issued",
    createdAt,
    baseRevision: revision,
    role,
    ...(sourcePart ? { partId: sourcePart.id } : {}),
    region,
    source: {
      ...(sourcePart ? { partId: sourcePart.id } : {}),
      assetId: asset.id,
      assetSha256: asset.sha256 ?? sha256(sourceBytes),
      width: sourceImage.width,
      height: sourceImage.height,
      crop: regionDefinition.rect
    },
    target,
    styleHints: { source: sourceStats, lineWidthProxy: round(sourceStats.darkPixelRatio * 12) },
    acceptance,
    provenance
  };
  REQUESTS.set(request.id, request);
  return request;
}

export function listGenerationRequests(): GenerationRequest[] {
  return [...REQUESTS.values()].slice(-50);
}

export function getGenerationRequest(id: string): GenerationRequest | undefined {
  return REQUESTS.get(id);
}

export async function evaluateGenerationAsset(rig: RigDocument, publicDir: string, currentRevision: string, input: GenerationAcceptanceInput): Promise<GenerationAcceptanceResult> {
  const request = REQUESTS.get(input.requestId);
  if (!request) throw new Error("generation request not found: " + input.requestId);
  const bytes = decodeInputBytes(input.pngBase64 ?? input.png);
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("generated PNG exceeds 8 MiB limit");
  const image = decodePng(bytes);
  const mediaType = String(input.mediaType ?? "image/png").toLowerCase();
  if (mediaType !== "image/png") throw new Error("only image/png generated assets are accepted");
  const criteria = normalizeAcceptance({ ...request.acceptance, ...(input.acceptance ?? {}) });
  const stats = analyzeImage(image);
  const sourceStats = request.styleHints.source;
  const aspectDrift = Math.abs((image.width / Math.max(1, image.height)) / (request.target.width / Math.max(1, request.target.height)) - 1);
  const meanColorDelta = colorDistance(stats.meanRgb, sourceStats.meanRgb);
  const edgeColorDelta = colorDistance(stats.edgeMeanRgb, sourceStats.edgeMeanRgb);
  const reference = input.referencePngBase64 ? decodePng(decodeInputBytes(input.referencePngBase64)) : undefined;
  const ssim = reference ? ssimLuma(image, reference) : null;
  const provenance = { ...request.provenance, ...(input.provenance ?? {}) };
  const checks: GenerationAcceptanceCheck[] = [
    { id: "revision-match", pass: currentRevision === request.baseRevision, value: currentRevision === request.baseRevision },
    { id: "png-format", pass: true, value: true },
    { id: "width", pass: image.width >= criteria.minWidth, value: image.width, threshold: criteria.minWidth },
    { id: "height", pass: image.height >= criteria.minHeight, value: image.height, threshold: criteria.minHeight },
    { id: "aspect-drift", pass: aspectDrift <= criteria.maxAspectDrift, value: round(aspectDrift), threshold: criteria.maxAspectDrift },
    { id: "alpha-coverage-min", pass: stats.alphaCoverage >= criteria.minAlphaCoverage, value: round(stats.alphaCoverage), threshold: criteria.minAlphaCoverage },
    { id: "alpha-coverage-max", pass: stats.alphaCoverage <= criteria.maxAlphaCoverage, value: round(stats.alphaCoverage), threshold: criteria.maxAlphaCoverage },
    { id: "mean-color-delta", pass: meanColorDelta <= criteria.maxMeanColorDelta, value: round(meanColorDelta), threshold: criteria.maxMeanColorDelta },
    { id: "edge-color-delta", pass: edgeColorDelta <= criteria.maxEdgeColorDelta, value: round(edgeColorDelta), threshold: criteria.maxEdgeColorDelta },
    { id: "ssim", pass: ssim === null ? !criteria.requireSsim : ssim >= criteria.minSsim, value: ssim === null ? null : round(ssim), threshold: criteria.minSsim },
    { id: "provenance", pass: typeof provenance.prompt === "string" && String(provenance.prompt).trim().length > 0 && typeof provenance.sourceRegion === "string" && String(provenance.sourceRegion).trim().length > 0, value: typeof provenance.prompt === "string" && String(provenance.prompt).trim().length > 0 }
  ];
  if (request.provenance.trigger === "exposure-qa") {
    const bbox = provenance.exposedBBox as { left?: unknown; top?: unknown; width?: unknown; height?: unknown } | undefined;
    const validBBox = Boolean(bbox && typeof bbox === "object" && Number.isFinite(Number(bbox.left)) && Number.isFinite(Number(bbox.top)) && Number.isFinite(Number(bbox.width)) && Number(bbox.width) > 0 && Number.isFinite(Number(bbox.height)) && Number(bbox.height) > 0);
    const exposureProvenancePass = typeof provenance.poseId === "string" && provenance.poseId.trim().length > 0 && provenance.sweepRevision === request.baseRevision && validBBox;
    checks.push({ id: "exposure-provenance", pass: exposureProvenancePass, value: exposureProvenancePass });
  }
  const accepted = checks.every((check) => check.pass);
  request.status = accepted ? "accepted" : "rejected";
  const assetId = String(input.assetId ?? request.id + "--generated");
  const hash = sha256(bytes);
  const fileName = sanitizeFileName(assetId) + "-" + hash.slice(0, 12) + ".png";
  return {
    ok: accepted,
    accepted,
    requestedCommit: input.commit === true,
    committed: false,
    request,
    currentRevision,
    checks,
    metrics: { image: stats, sha256: hash, aspectDrift: round(aspectDrift), meanColorDelta: round(meanColorDelta), edgeColorDelta: round(edgeColorDelta), ssim: ssim === null ? null : round(ssim) },
    assetCandidate: { assetId, path: "/assets/generated/" + fileName, sha256: hash, mediaType: "image/png", bytes: bytes.byteLength },
    provenance,
    bytes
  };
}

export async function persistAcceptedGeneration(publicDir: string, result: GenerationAcceptanceResult): Promise<{ manifestPath: string; provenancePath: string }> {
  if (!result.accepted) throw new Error("cannot persist a rejected generated asset");
  const relativeAssetPath = result.assetCandidate.path.replace(/^\/+/, "");
  const absoluteAssetPath = path.resolve(publicDir, relativeAssetPath);
  if (!absoluteAssetPath.startsWith(path.resolve(publicDir) + path.sep)) throw new Error("generated asset path escaped public directory");
  await mkdir(path.dirname(absoluteAssetPath), { recursive: true });
  await writeFile(absoluteAssetPath, result.bytes);
  const manifestPath = path.resolve(publicDir, "assets-manifest.json");
  const existing = await readFile(manifestPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => ({ format: "standrig-assets", version: 1, entries: [] }));
  const entries = Array.isArray(existing.entries) ? existing.entries.filter((entry: { assetId?: string }) => entry.assetId !== result.assetCandidate.assetId) : [];
  entries.push({ assetId: result.assetCandidate.assetId, path: result.assetCandidate.path, sha256: result.assetCandidate.sha256, mediaType: "image/png", bytes: result.assetCandidate.bytes });
  await writeFile(manifestPath, JSON.stringify({ format: "standrig-assets", version: 1, entries }, null, 2), "utf8");
  const provenancePath = path.resolve(publicDir, "generated-assets.json");
  const provenanceDocument = await readFile(provenancePath, "utf8").then((raw) => JSON.parse(raw)).catch(() => ({ format: "standrig-generated-assets", version: 1, entries: [] }));
  const provenanceEntries = Array.isArray(provenanceDocument.entries) ? provenanceDocument.entries.filter((entry: { assetId?: string }) => entry.assetId !== result.assetCandidate.assetId) : [];
  const parentAssetId = typeof result.provenance.parentAssetId === "string" ? result.provenance.parentAssetId : undefined;
  const generationIndex = Number.isFinite(Number(result.provenance.generationIndex)) ? Number(result.provenance.generationIndex) : undefined;
  const record: GeneratedAssetRecord = {
    requestId: result.request.id,
    assetId: result.assetCandidate.assetId,
    path: result.assetCandidate.path,
    sha256: result.assetCandidate.sha256,
    createdAt: new Date().toISOString(),
    status: "active",
    ...(parentAssetId ? { parentAssetId } : {}),
    ...(generationIndex !== undefined ? { generationIndex } : {}),
    provenance: result.provenance,
    checks: result.checks,
    metrics: { ...result.metrics, image: { ...result.metrics.image, palette: result.metrics.image.palette } }
  };
  const supersedes = typeof result.provenance.supersedes === "string" ? result.provenance.supersedes : undefined;
  if (supersedes) {
    for (const entry of provenanceEntries as GeneratedAssetRecord[]) {
      if (entry.assetId === supersedes && entry.status !== "deleted") {
        entry.status = "superseded";
        entry.supersededBy = result.assetCandidate.assetId;
      }
    }
  }
  provenanceEntries.push(record);
  await writeFile(provenancePath, JSON.stringify({ format: "standrig-generated-assets", version: 1, entries: provenanceEntries }, null, 2), "utf8");
  return { manifestPath, provenancePath };
}

export async function listPersistedGeneratedAssets(publicDir: string): Promise<GeneratedAssetListing> {
  const provenancePath = path.resolve(publicDir, "generated-assets.json");
  const document = await readFile(provenancePath, "utf8").then((raw) => JSON.parse(raw) as Partial<GeneratedAssetListing>).catch(() => undefined);
  const entries = Array.isArray(document?.entries) ? document.entries.filter((entry): entry is GeneratedAssetRecord => Boolean(entry && typeof entry.assetId === "string" && typeof entry.path === "string")).map((entry) => ({ ...entry, status: entry.status ?? "active" as const })) : [];
  return { format: "standrig-generated-assets", version: 1, entries };
}

export async function regenerateGenerationRequest(rig: RigDocument, publicDir: string, revision: string, input: { assetId?: string; requestId?: string; prompt?: string; provenance?: Record<string, unknown>; acceptance?: Partial<GenerationAcceptanceCriteria>; targetWidth?: number; targetHeight?: number }): Promise<GenerationRequest> {
  const listing = await listPersistedGeneratedAssets(publicDir);
  const existing = listing.entries.find((entry) => (input.assetId && entry.assetId === input.assetId) || (input.requestId && entry.requestId === input.requestId));
  if (!existing) throw new Error("generated asset not found");
  if (existing.status === "deleted") throw new Error("cannot regenerate a deleted generated asset");
  const sourceRequest = REQUESTS.get(existing.requestId);
  const sourcePartId = sourceRequest?.partId ?? (typeof existing.provenance.sourcePartId === "string" ? existing.provenance.sourcePartId : undefined);
  const sourceRegion = sourceRequest?.region ?? String(existing.provenance.sourceRegion ?? "full");
  const generationIndex = Number(existing.generationIndex ?? 0) + 1;
  return createGenerationRequest(rig, publicDir, revision, {
    ...(sourcePartId ? { partId: sourcePartId } : {}),
    region: sourceRegion,
    role: sourceRequest?.role,
    prompt: input.prompt ?? String(existing.provenance.prompt ?? "regenerate generated asset while preserving source style"),
    targetWidth: input.targetWidth ?? sourceRequest?.target.width ?? Number(existing.provenance.targetWidth),
    targetHeight: input.targetHeight ?? sourceRequest?.target.height ?? Number(existing.provenance.targetHeight),
    acceptance: { ...(sourceRequest?.acceptance ?? {}), ...(input.acceptance ?? {}) },
    provenance: {
      ...existing.provenance,
      ...(input.provenance ?? {}),
      parentAssetId: existing.assetId,
      supersedes: existing.assetId,
      generationIndex,
      regeneratedFromRequestId: existing.requestId,
      createdAt: new Date().toISOString()
    }
  });
}

export async function deletePersistedGeneratedAsset(publicDir: string, assetId: string, commit: boolean): Promise<GeneratedAssetDeleteResult> {
  const listing = await listPersistedGeneratedAssets(publicDir);
  const entry = listing.entries.find((candidate) => candidate.assetId === assetId);
  if (!entry) return { ok: false, assetId, requestedCommit: commit, committed: false, status: "deleted", reason: "generated asset not found" };
  if (entry.status === "deleted") return { ok: true, assetId, requestedCommit: commit, committed: false, status: "deleted", path: entry.path, reason: "already deleted" };
  if (!commit) return { ok: true, assetId, requestedCommit: false, committed: false, status: entry.status, path: entry.path, reason: "dry-run" };
  const absoluteAssetPath = path.resolve(publicDir, entry.path.replace(/^\/+/, ""));
  if (!absoluteAssetPath.startsWith(path.resolve(publicDir) + path.sep) || !absoluteAssetPath.includes(path.sep + "generated" + path.sep)) throw new Error("only generated asset paths may be deleted");
  await unlink(absoluteAssetPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  const deletedAt = new Date().toISOString();
  const updatedEntries = listing.entries.map((candidate) => candidate.assetId === assetId ? { ...candidate, status: "deleted" as const, deletedAt } : candidate);
  await writeFile(path.resolve(publicDir, "generated-assets.json"), JSON.stringify({ format: "standrig-generated-assets", version: 1, entries: updatedEntries }, null, 2), "utf8");
  const manifestPath = path.resolve(publicDir, "assets-manifest.json");
  const manifest = await readFile(manifestPath, "utf8").then((raw) => JSON.parse(raw) as { format?: string; version?: number; entries?: Array<{ assetId?: string }> }).catch(() => ({ format: "standrig-assets", version: 1, entries: [] }));
  const manifestEntries = Array.isArray(manifest.entries) ? manifest.entries.filter((candidate) => candidate.assetId !== assetId) : [];
  await writeFile(manifestPath, JSON.stringify({ format: "standrig-assets", version: 1, entries: manifestEntries }, null, 2), "utf8");
  return { ok: true, assetId, requestedCommit: true, committed: true, status: "deleted", path: entry.path };
}
async function loadAssetBytes(asset: { src: string }, publicDir: string): Promise<Uint8Array> {
  const embedded = decodeDataUrl(asset.src);
  if (embedded) return embedded.bytes;
  if (/^https?:\/\//i.test(asset.src) || asset.src.startsWith("asset://")) throw new Error("source asset is not locally readable");
  const absolute = path.resolve(publicDir, asset.src.replace(/^\/+/, ""));
  if (!absolute.startsWith(path.resolve(publicDir) + path.sep)) throw new Error("source asset path escaped public directory");
  return new Uint8Array(await readFile(absolute));
}

function decodeInputBytes(value: string | undefined): Uint8Array {
  if (!value) throw new Error("pngBase64 or png is required");
  const embedded = decodeDataUrl(value);
  if (embedded) {
    if (embedded.mediaType !== "image/png") throw new Error("input data URL must be image/png");
    return embedded.bytes;
  }
  return new Uint8Array(Buffer.from(value.replace(/\s/g, ""), "base64"));
}

function analyzeImage(image: RgbaImage): GenerationImageStats {
  const step = Math.max(1, Math.floor(Math.sqrt((image.width * image.height) / 200000)));
  let sampled = 0;
  let opaque = 0;
  let dark = 0;
  const sum = [0, 0, 0];
  const edgeSum = [0, 0, 0];
  let edgeCount = 0;
  const bins = new Map<string, number>();
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const offset = (y * image.width + x) * 4;
      const alpha = image.data[offset + 3] / 255;
      sampled += 1;
      if (alpha <= 0.03) continue;
      opaque += 1;
      const rgb: [number, number, number] = [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
      sum[0] += rgb[0]; sum[1] += rgb[1]; sum[2] += rgb[2];
      const luma = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      if (luma < 64) dark += 1;
      const key = rgb.map((value) => Math.floor(value / 16)).join(",");
      bins.set(key, (bins.get(key) ?? 0) + 1);
      if (x < step || y < step || x >= image.width - step || y >= image.height - step) {
        edgeSum[0] += rgb[0]; edgeSum[1] += rgb[1]; edgeSum[2] += rgb[2]; edgeCount += 1;
      }
    }
  }
  const mean = opaque ? [sum[0] / opaque, sum[1] / opaque, sum[2] / opaque] : [0, 0, 0];
  const edgeMean = edgeCount ? [edgeSum[0] / edgeCount, edgeSum[1] / edgeCount, edgeSum[2] / edgeCount] : mean;
  const palette = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, count]) => ({ rgb: key.split(",").map((value) => Number(value) * 16 + 8) as [number, number, number], ratio: round(count / Math.max(1, opaque)) }));
  return { width: image.width, height: image.height, alphaCoverage: round(opaque / Math.max(1, sampled)), meanRgb: mean.map(round) as [number, number, number], edgeMeanRgb: edgeMean.map(round) as [number, number, number], darkPixelRatio: round(dark / Math.max(1, opaque)), palette };
}

function normalizeAcceptance(input: Partial<GenerationAcceptanceCriteria> | undefined): GenerationAcceptanceCriteria {
  const value = { ...DEFAULT_ACCEPTANCE, ...(input ?? {}) };
  return {
    minWidth: clampInteger(value.minWidth, 1, 4096),
    minHeight: clampInteger(value.minHeight, 1, 4096),
    maxAspectDrift: clampRatio(value.maxAspectDrift, DEFAULT_ACCEPTANCE.maxAspectDrift),
    minAlphaCoverage: clampRatio(value.minAlphaCoverage, DEFAULT_ACCEPTANCE.minAlphaCoverage),
    maxAlphaCoverage: clampRatio(value.maxAlphaCoverage, DEFAULT_ACCEPTANCE.maxAlphaCoverage),
    maxMeanColorDelta: clampNumber(value.maxMeanColorDelta, 0, 442, DEFAULT_ACCEPTANCE.maxMeanColorDelta),
    maxEdgeColorDelta: clampNumber(value.maxEdgeColorDelta, 0, 442, DEFAULT_ACCEPTANCE.maxEdgeColorDelta),
    minSsim: clampRatio(value.minSsim, DEFAULT_ACCEPTANCE.minSsim),
    requireSsim: value.requireSsim === true
  };
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function ssimLuma(a: RgbaImage, b: RgbaImage): number {
  const count = 4096;
  const valuesA: number[] = [];
  const valuesB: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const x = index % 64;
    const y = Math.floor(index / 64);
    valuesA.push(lumaAt(a, x, y, 64, 64));
    valuesB.push(lumaAt(b, x, y, 64, 64));
  }
  const meanA = valuesA.reduce((sum, value) => sum + value, 0) / count;
  const meanB = valuesB.reduce((sum, value) => sum + value, 0) / count;
  const varianceA = valuesA.reduce((sum, value) => sum + (value - meanA) ** 2, 0) / count;
  const varianceB = valuesB.reduce((sum, value) => sum + (value - meanB) ** 2, 0) / count;
  const covariance = valuesA.reduce((sum, value, index) => sum + (value - meanA) * (valuesB[index] - meanB), 0) / count;
  const c1 = 6.5025;
  const c2 = 58.5225;
  return ((2 * meanA * meanB + c1) * (2 * covariance + c2)) / ((meanA * meanA + meanB * meanB + c1) * (varianceA + varianceB + c2));
}

function lumaAt(image: RgbaImage, x: number, y: number, targetWidth: number, targetHeight: number): number {
  const sourceX = Math.min(image.width - 1, Math.max(0, Math.floor((x + 0.5) * image.width / targetWidth)));
  const sourceY = Math.min(image.height - 1, Math.max(0, Math.floor((y + 0.5) * image.height / targetHeight)));
  const offset = (sourceY * image.width + sourceX) * 4;
  return image.data[offset] * 0.2126 + image.data[offset + 1] * 0.7152 + image.data[offset + 2] * 0.0722;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "generated";
}

function clampInteger(value: unknown, min: number, max: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.round(numeric))) : min;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
}

function clampRatio(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
