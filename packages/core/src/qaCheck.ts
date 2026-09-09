import { auditRgbaImage, diffRgbaImages, type RgbaImageAudit } from "./imageAudit.js";
import { isDetailRegionId, type DetailRegionId } from "./detailRegions.js";
import { modelingPoseValuesForRig } from "./modeling.js";
import { decodePng } from "./png.js";
import { renderRigScreenshot, type ScreenshotOptions } from "./serverRenderer.js";
import { previewParameterValuesForRig } from "./parameters.js";
import { auditRigArtMeshDistortion, type ArtMeshDistortionAudit } from "./artMeshDistortion.js";
import { auditMotionSweep, type MotionSweepAudit, type MotionSweepRequest } from "./motionSweep.js";
import type { ParameterValues, RigDocument } from "./types.js";

export interface QaCheckPoseSample { poseId: string; values: ParameterValues; }
export interface QaCheckRequest { poses?: string[]; poseSamples?: QaCheckPoseSample[]; regions?: string[]; width?: number; height?: number; physics?: boolean; physicsTime?: number; physicsSteps?: number; minCoverage?: number; failOnEdgeContact?: boolean; expectedHashes?: Record<string, string>; checkTriangleDistortion?: boolean; maxTriangleStretchRatio?: number; maxTriangleCompressionRatio?: number; maxTriangleAnisotropy?: number; motionSweep?: boolean | MotionSweepRequest; supersample?: number; }
export interface QaCheckEntry { poseId: string; region: DetailRegionId; pass: boolean; issues: string[]; audit: RgbaImageAudit; coverage: number; motionDiffPixelRatio: number | null; baselineHash: string; expectedHash?: string; baselineMatch?: boolean; artMeshDistortion?: ArtMeshDistortionAudit; }
export interface QaFailureRegion { poseId: string; region: DetailRegionId; issues: string[]; imageRequest: { poseId: string; region: DetailRegionId; beforePoseId?: string; width: number; height: number; physics: boolean; }; }
export interface QaCheckResult { ok: boolean; entries: QaCheckEntry[]; failed: QaCheckEntry[]; failureRegions: QaFailureRegion[]; renderedCount: number; imagePolicy: "numeric-only"; cache: "hit" | "miss"; motionSweep?: MotionSweepAudit; issues?: string[]; }
const QA_CACHE = new Map<string, QaCheckResult>();

export async function runQaCheck(rig: RigDocument, publicDir: string, request: QaCheckRequest = {}): Promise<QaCheckResult> {
  const cacheKey = cacheHash(JSON.stringify({ rig, request }));
  const cached = QA_CACHE.get(cacheKey);
  if (cached) return { ...cached, cache: "hit" };
  const poses = unique(request.poses?.length ? request.poses : ["neutral"]);
  const poseSamples = Array.isArray(request.poseSamples) && request.poseSamples.length
    ? request.poseSamples.filter((sample): sample is QaCheckPoseSample => Boolean(sample) && typeof sample.poseId === "string" && sample.poseId.trim().length > 0 && Boolean(sample.values) && typeof sample.values === "object" && !Array.isArray(sample.values)).map((sample) => ({ poseId: sample.poseId.trim(), values: { ...previewParameterValuesForRig(rig), ...sample.values } }))
    : poses.map((poseId) => ({ poseId, values: modelingPoseValuesForRig(rig, poseId, previewParameterValuesForRig(rig)) })).filter((sample): sample is { poseId: string; values: ParameterValues } => Boolean(sample.values));
  if (!poseSamples.length) throw new Error("at least one valid QA pose or poseSamples entry is required");
  const regions = unique(request.regions?.length ? request.regions : ["full"]).filter(isDetailRegionId) as DetailRegionId[];
  const width = clamp(request.width ?? 240, 64, 480); const height = clamp(request.height ?? 240, 64, 480);
  const physics = request.physics === true; const physicsTime = finite(request.physicsTime, 0); const physicsSteps = clamp(request.physicsSteps ?? 18, 0, 240);
  const minCoverage = Math.max(0, Math.min(1, finite(request.minCoverage, 0.001))); const failOnEdgeContact = request.failOnEdgeContact === true;
  const motionSweep = request.motionSweep ? auditMotionSweep(rig, typeof request.motionSweep === "object" ? request.motionSweep : {}) : undefined;
  const entries: QaCheckEntry[] = [];
  const artMeshDistortionByPose = new Map<string, ArtMeshDistortionAudit>();
  for (const region of regions.length ? regions : ["full" as DetailRegionId]) {
    const neutralSample = poseSamples.find((sample) => sample.poseId === "neutral") ?? { poseId: "neutral", values: previewParameterValuesForRig(rig) };
    const neutral = await renderImage(rig, publicDir, neutralSample.poseId, region, width, height, physics, physicsTime, physicsSteps, clamp(request.supersample ?? 1, 1, 2), neutralSample.values);
    for (const sample of poseSamples) {
      const poseId = sample.poseId;
      const image = poseId === neutralSample.poseId ? neutral : await renderImage(rig, publicDir, poseId, region, width, height, physics, physicsTime, physicsSteps, clamp(request.supersample ?? 1, 1, 2), sample.values);
      const poseValues = sample.values;
      let artMeshDistortion = artMeshDistortionByPose.get(poseId);
      if (request.checkTriangleDistortion !== false && !artMeshDistortion) {
        artMeshDistortion = auditRigArtMeshDistortion(rig, poseValues, {
          maxStretchRatio: request.maxTriangleStretchRatio,
          maxCompressionRatio: request.maxTriangleCompressionRatio,
          maxAnisotropy: request.maxTriangleAnisotropy
        });
        artMeshDistortionByPose.set(poseId, artMeshDistortion);
      }
      const audit = auditRgbaImage(image);
      const issues: string[] = [];
      const coverage = audit.totalPixelCount ? audit.nonTransparentPixelCount / audit.totalPixelCount : 0;
      const baselineHash = hashImage(image); const expectedHash = request.expectedHashes?.[`${poseId}:${region}`]; const baselineMatch = expectedHash ? expectedHash === baselineHash : undefined;
      if (!audit.nonTransparentPixelCount) issues.push("empty-image");
      if (coverage < minCoverage) issues.push("low-coverage");
      if (failOnEdgeContact && audit.edgeContact.any) issues.push("edge-contact");
      if (baselineMatch === false) issues.push("baseline-mismatch");
      if (artMeshDistortion?.invertedTriangleCount) issues.push("triangle-inverted");
      if (artMeshDistortion?.degenerateTriangleCount) issues.push("triangle-degenerate");
      if (artMeshDistortion && artMeshDistortion.maxStretchRatio > artMeshDistortion.thresholds.maxStretchRatio) issues.push("triangle-stretch");
      if (artMeshDistortion && artMeshDistortion.maxCompressionRatio > artMeshDistortion.thresholds.maxCompressionRatio) issues.push("triangle-compression");
      if (artMeshDistortion && artMeshDistortion.maxAnisotropy > artMeshDistortion.thresholds.maxAnisotropy) issues.push("triangle-anisotropy");
      const motion = poseId === neutralSample.poseId ? null : diffRgbaImages(neutral, image).diffPixelRatio;
      entries.push({ poseId, region, pass: issues.length === 0, issues, audit, coverage, motionDiffPixelRatio: motion, baselineHash, expectedHash, baselineMatch, artMeshDistortion });
    }
  }
  const failed = entries.filter((entry) => !entry.pass);
  const issues = motionSweep && !motionSweep.pass ? ["motion-sweep"] : undefined;
  const failureRegions: QaFailureRegion[] = failed.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues, imageRequest: { poseId: entry.poseId, region: entry.region, ...(entry.poseId === "neutral" ? {} : { beforePoseId: "neutral" }), width, height, physics } }));
  const result: QaCheckResult = { ok: failed.length === 0 && !issues?.length, entries, failed, failureRegions, renderedCount: entries.length + regions.filter(() => !poseSamples.some((sample) => sample.poseId === "neutral")).length, imagePolicy: "numeric-only", cache: "miss", motionSweep, issues };
  QA_CACHE.set(cacheKey, result); if (QA_CACHE.size > 24) QA_CACHE.delete(QA_CACHE.keys().next().value!);
  return result;
}

async function renderImage(rig: RigDocument, publicDir: string, poseId: string, detail: DetailRegionId, width: number, height: number, physics: boolean, physicsTime: number, physicsSteps: number, supersample: number, sampleValues?: ParameterValues) {
  const values = sampleValues ?? modelingPoseValuesForRig(rig, poseId, previewParameterValuesForRig(rig));
  if (!values) throw new Error(`Unknown modeling pose: ${poseId}`);
  const options: ScreenshotOptions = { width, height, fitPadding: 12, transparent: true, set: "single", detail, focusParts: detail !== "full", partIds: [], forceParts: false, values, physics, physicsTime, physicsSteps, supersample };
  return decodePng((await renderRigScreenshot(rig, publicDir, options)).png);
}
function unique(values: string[]) { return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))]; }
function clamp(value: number, min: number, max: number) { const numeric = Number(value); return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.round(numeric))) : min; }
function finite(value: unknown, fallback: number) { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : fallback; }
function cacheHash(value: string) { let hash = 0x811c9dc5; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193); } return (hash >>> 0).toString(16); }
function hashImage(image: { data: ArrayLike<number> }) { let hash = 0x811c9dc5; for (let index = 0; index < image.data.length; index += 1) { hash ^= image.data[index] ?? 0; hash = Math.imul(hash, 0x01000193); } return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`; }