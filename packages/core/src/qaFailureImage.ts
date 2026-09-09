import { decodePng, encodePng, createBlankRgba, type RgbaImage } from "./png.js";
import { modelingPoseValuesForRig } from "./modeling.js";
import { previewParameterValuesForRig } from "./parameters.js";
import { renderRigScreenshot, type ScreenshotOptions } from "./serverRenderer.js";
import type { DetailRegionId } from "./detailRegions.js";
import type { RigDocument } from "./types.js";

export interface QaFailureImageRequest { poseId: string; region: DetailRegionId; beforePoseId?: string; width?: number; height?: number; physics?: boolean; physicsTime?: number; physicsSteps?: number; }

export async function renderQaFailureComparison(rig: RigDocument, publicDir: string, request: QaFailureImageRequest): Promise<Uint8Array> {
  const width = clamp(request.width ?? 240, 64, 480); const height = clamp(request.height ?? 240, 64, 480);
  const before = await renderQaPose(rig, publicDir, request.beforePoseId ?? "neutral", request.region, width, height, request);
  const after = await renderQaPose(rig, publicDir, request.poseId, request.region, width, height, request);
  const diff = createDiffImage(before, after);
  const output = createBlankRgba(width * 3, height);
  paste(output, before, 0); paste(output, after, width); paste(output, diff, width * 2);
  return encodePng(output);
}

async function renderQaPose(rig: RigDocument, publicDir: string, poseId: string, detail: DetailRegionId, width: number, height: number, request: QaFailureImageRequest): Promise<RgbaImage> {
  const values = modelingPoseValuesForRig(rig, poseId, previewParameterValuesForRig(rig));
  if (!values) throw new Error(`Unknown modeling pose: ${poseId}`);
  const options: ScreenshotOptions = { width, height, fitPadding: 12, transparent: true, set: "single", detail, focusParts: detail !== "full", partIds: [], forceParts: false, values, physics: request.physics === true, physicsTime: finite(request.physicsTime, 0), physicsSteps: clamp(request.physicsSteps ?? 18, 0, 240) };
  return decodePng((await renderRigScreenshot(rig, publicDir, options)).png);
}

function createDiffImage(before: RgbaImage, after: RgbaImage): RgbaImage { const image = createBlankRgba(before.width, before.height); for (let index = 0; index < image.data.length; index += 4) { const changed = Math.abs(before.data[index] - after.data[index]) + Math.abs(before.data[index + 1] - after.data[index + 1]) + Math.abs(before.data[index + 2] - after.data[index + 2]) + Math.abs(before.data[index + 3] - after.data[index + 3]); if (changed > 0) { image.data[index] = 255; image.data[index + 1] = changed > 180 ? 40 : 220; image.data[index + 2] = 40; image.data[index + 3] = Math.min(255, Math.max(80, changed)); } } return image; }
function paste(target: RgbaImage, source: RgbaImage, offsetX: number) { for (let y = 0; y < source.height; y += 1) target.data.set(source.data.subarray(y * source.width * 4, (y + 1) * source.width * 4), (y * target.width + offsetX) * 4); }
function clamp(value: number, min: number, max: number) { const numeric = Number(value); return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.round(numeric))) : min; }
function finite(value: unknown, fallback: number) { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : fallback; }