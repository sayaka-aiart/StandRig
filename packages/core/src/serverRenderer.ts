import { readFile } from "node:fs/promises";
import path from "node:path";
import { detailRegionForRig, isDetailRegionId, type DetailRegionId } from "./detailRegions.js";
import { invertMatrix, multiplyMatrices, resolveRigFrame, scaleMatrix, transformMatrixPoint, translateMatrix, type Matrix2D } from "./evaluator.js";
import { hasWarpEffect, warpPoint, type ResolvedWarpDeformer } from "./warp.js";
import { resolveGlueWarpForPart } from "./glueWarp.js";
import { hasSharedWarpFieldEffect } from "./sharedWarp.js";
import { projectSharedWarpPoint } from "./sharedWarpProjection.js";
import { isCanonicalArtMesh, resolveArtMesh, type ResolvedArtMesh } from "./artMesh.js";
import { readRigArtPaths, resolveArtPath } from "./artPath.js";
import { applySkinningToVertices } from "./skinning.js";
import { applyPartGlueStitchOffset, hasGlueStitches, glueStitchRestScale, projectArtMeshVertex, resolveGlueStitchOffsets, type GlueVertexOffset } from "./glueVertex.js";
import { prepareRigBindingOrder } from "./bindingPreparation.js";
import { expandTriangleForCoverage } from "./triangleCoverage.js";
import { resolvePartClip, sameResolvedPartClip } from "./mask.js";
import { modelingPosePresetsForRig } from "./modeling.js";
import { isReferenceSheetSet, referenceSheetColumns, referenceSheetPresetsForRig, type ReferenceSheetSet } from "./reference.js";
import { clampParameterValue, normalizeParameterKey, parameterDefinitionsForRig, previewParameterValuesForRig } from "./parameters.js";
import { createBlankRgba, decodePng, encodePng, type RgbaImage } from "./png.js";
import { applyTintChannel, parseTintColor } from "./tint.js";
import { applyContourShade } from "./contourShade.js";
import { applyAlphaReveal } from "./alphaReveal.js";
import type { AssetDefinition, ParameterValues, RigDocument, RigPart, RigPartTint, RigSharedWarpField, Transform2D } from "./types.js";

export interface ScreenshotOptions {
  width: number;
  height: number;
  fitPadding: number;
  transparent: boolean;
  set: "single" | "angles" | "expressions" | "modeling" | ReferenceSheetSet;
  detail?: DetailRegionId;
  focusParts: boolean;
  partIds: string[];
  forceParts: boolean;
  values: ParameterValues;
  physics: boolean;
  physicsTime: number;
  physicsSteps: number;
  supersample?: number;
}

export interface ScreenshotResult {
  png: Uint8Array;
  width: number;
  height: number;
  parameters: ParameterValues;
  set: ScreenshotOptions["set"];
  detail?: DetailRegionId;
  focusParts: boolean;
  partIds: string[];
  forceParts: boolean;
  presets: Array<{ id: string; label: string; values: ParameterValues }>;
  physics: boolean;
  physicsTime: number;
  physicsSteps: number;
  supersample: number;
}

interface DecodedAsset {
  image: RgbaImage;
  asset: AssetDefinition;
}

/** Per-part geometry shared between the glue stitch solver and the draw loop. */
interface PartDrawGeometry {
  state: NonNullable<ReturnType<ReturnType<typeof resolveRigFrame>["parts"]["get"]>>;
  sourceImage: RgbaImage;
  warp: ResolvedWarpDeformer | undefined;
  artMesh: ResolvedArtMesh | undefined;
}

// Reusing decoded PNGs keeps repeated numeric QA (part x pose) bounded in memory and time.
const DECODED_ASSET_CACHE = new Map<string, RgbaImage>();
const DECODED_ASSET_CACHE_LIMIT = 256;

const MIN_SCALE = 0.001;
const LABEL_HEIGHT = 28;
type PartBlendMode = "normal" | "multiply" | "screen" | "additive";

export function screenshotOptionsFromUrl(rig: RigDocument, url: URL): ScreenshotOptions {
  const setValue = url.searchParams.get("set") ?? url.searchParams.get("preset") ?? "single";
  const set = setValue === "angles" || setValue === "expressions" || setValue === "modeling"
    ? setValue
    : isReferenceSheetSet(setValue)
      ? setValue
      : "single";
  const detailValue = url.searchParams.get("detail") ?? url.searchParams.get("region");
  const detail = isDetailRegionId(detailValue) ? detailValue : undefined;
  const values = previewParameterValuesForRig(rig);
  const knownParameters = new Set(parameterDefinitionsForRig(rig).map((parameter) => parameter.id));

  for (const [rawKey, rawValue] of url.searchParams) {
    const key = normalizeParameterKey(rawKey);
    const value = Number(rawValue);
    if (knownParameters.has(key) && Number.isFinite(value)) {
      values[key] = clampParameterValue(rig, key, value);
    }
  }

  return {
    width: clampInteger(numberParam(url, "width", 900), 64, 4096),
    height: clampInteger(numberParam(url, "height", 1200), 64, 4096),
    fitPadding: clampInteger(numberParam(url, "padding", 18), 0, 512),
    transparent: url.searchParams.get("transparent") !== "0",
    physics: url.searchParams.get("physics") !== "0",
    physicsTime: numberParam(url, "physicsTime", numberParam(url, "time", 0)),
    // Warm the deterministic physics state enough for hair/chest motion to be
    // visible in screenshot and review captures. Callers can still override
    // this explicitly (including 0 for a static baseline).
    physicsSteps: clampInteger(numberParam(url, "physicsSteps", 60), 0, 240),
    set,
    detail,
    focusParts: parseFocusParts(url),
    partIds: parsePartIds(url),
    forceParts: parseBooleanParam(url, "forceParts") || parseBooleanParam(url, "force"),
    values,
    supersample: clampInteger(numberParam(url, "supersample", numberParam(url, "ss", 1)), 1, 2)
  };
}

export async function renderRigScreenshot(rig: RigDocument, publicDir: string, options: ScreenshotOptions): Promise<ScreenshotResult> {
  const supersample = clampInteger(options.supersample ?? 1, 1, 2);
  if (supersample > 1) {
    const highResolution = await renderRigScreenshotBase(rig, publicDir, { ...options, width: options.width * supersample, height: options.height * supersample, fitPadding: options.fitPadding * supersample, supersample: 1 });
    const downsampled = downsampleRgbaImage(decodePng(highResolution.png), options.width, options.height);
    return { ...highResolution, png: encodePng(downsampled), width: downsampled.width, height: downsampled.height, supersample };
  }
  return renderRigScreenshotBase(rig, publicDir, { ...options, supersample: 1 });
}

async function renderRigScreenshotBase(rig: RigDocument, publicDir: string, options: ScreenshotOptions): Promise<ScreenshotResult> {
  prepareRigBindingOrder(rig);
  const assets = await loadAssets(rig.assets, publicDir);
  const presets = screenshotPresets(rig, options.values, options.set);

  if (options.set === "single") {
    const image = renderRigToImage(rig, assets, options.values, options);
    return {
      png: encodePng(image),
      width: image.width,
      height: image.height,
      parameters: options.values,
      set: options.set,
      detail: options.detail,
      focusParts: options.focusParts,
      partIds: options.partIds,
      forceParts: options.forceParts,
      physics: options.physics,
      physicsTime: options.physicsTime,
      physicsSteps: options.physicsSteps,

      supersample: options.supersample ?? 1,
      presets
    };
  }

  const sheet = renderContactSheet(rig, assets, presets, options);
  return {
    png: encodePng(sheet),
    width: sheet.width,
    height: sheet.height,
    parameters: options.values,
    set: options.set,
    detail: options.detail,
    focusParts: options.focusParts,
    partIds: options.partIds,
    forceParts: options.forceParts,
    physics: options.physics,
    physicsTime: options.physicsTime,
    physicsSteps: options.physicsSteps,

    supersample: options.supersample ?? 1,
    presets
  };
}

function screenshotPresets(
  rig: RigDocument,
  baseValues: ParameterValues,
  set: ScreenshotOptions["set"]
): Array<{ id: string; label: string; values: ParameterValues }> {
  const withValues = (id: string, label: string, values: Partial<ParameterValues>) => ({
    id,
    label,
    values: previewParameterValuesForRig(rig, { ...baseValues, ...values })
  });

  if (set === "angles") {
    return [
      withValues("center", "CENTER", {}),
      withValues("angle-x-left", "X -20", { ParamAngleX: -20, ParamBodyAngleX: -8 }),
      withValues("angle-x-right", "X +20", { ParamAngleX: 20, ParamBodyAngleX: 8 }),
      withValues("angle-y-up", "Y -15", { ParamAngleY: -15, ParamBodyAngleY: -6 }),
      withValues("angle-y-down", "Y +15", { ParamAngleY: 15, ParamBodyAngleY: 6 }),
      withValues("angle-z-left", "Z -15", { ParamAngleZ: -15 }),
      withValues("angle-z-right", "Z +15", { ParamAngleZ: 15 }),
      withValues("mouth-open", "MOUTH 1", { ParamMouthOpen: 1 }),
      withValues("blink", "BLINK", { ParamEyeLOpen: 0, ParamEyeROpen: 0 })
    ];
  }

  if (set === "expressions") {
    return [
      withValues("neutral", "NEUTRAL", { ParamMouthOpen: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1 }),
      withValues("mouth-0", "MOUTH 0", { ParamMouthOpen: 0 }),
      withValues("mouth-50", "MOUTH .5", { ParamMouthOpen: 0.5 }),
      withValues("mouth-100", "MOUTH 1", { ParamMouthOpen: 1 }),
      withValues("eye-l", "EYE L 0", { ParamEyeLOpen: 0, ParamEyeROpen: 1 }),
      withValues("eye-r", "EYE R 0", { ParamEyeLOpen: 1, ParamEyeROpen: 0 }),
      withValues("blink", "BLINK", { ParamEyeLOpen: 0, ParamEyeROpen: 0 })
    ];
  }

  if (set === "modeling") {
    return modelingPosePresetsForRig(rig, baseValues).map((pose) => ({
      id: pose.id,
      label: pose.label.toUpperCase(),
      values: pose.values
    }));
  }

  if (isReferenceSheetSet(set)) {
    return referenceSheetPresetsForRig(rig, baseValues, set);
  }

  return [withValues("single", "SINGLE", {})];
}

function renderContactSheet(
  rig: RigDocument,
  assets: Map<string, DecodedAsset>,
  presets: Array<{ id: string; label: string; values: ParameterValues }>,
  options: ScreenshotOptions
): RgbaImage {
  const columns = isReferenceSheetSet(options.set) ? referenceSheetColumns(options.set) : options.set === "expressions" || options.set === "modeling" ? 4 : 3;
  const rows = Math.ceil(presets.length / columns);
  const cellWidth = options.width;
  const cellHeight = options.height;
  const output = createBlankRgba(cellWidth * columns, (cellHeight + LABEL_HEIGHT) * rows);

  presets.forEach((preset, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = column * cellWidth;
    const y = row * (cellHeight + LABEL_HEIGHT);
    const rendered = renderRigToImage(rig, assets, preset.values, options);
    pasteImage(output, rendered, x, y);
    fillRect(output, x, y + cellHeight, cellWidth, LABEL_HEIGHT, [245, 247, 250, 235]);
    drawText(output, preset.label, x + 10, y + cellHeight + 7, 3, [24, 29, 38, 255]);
  });

  return output;
}

function renderRigToImage(
  rig: RigDocument,
  assets: Map<string, DecodedAsset>,
  values: ParameterValues,
  options: ScreenshotOptions
): RgbaImage {
  const output = createBlankRgba(options.width, options.height, options.transparent ? [0, 0, 0, 0] : [238, 240, 243, 255]);
  const availableWidth = Math.max(1, options.width - options.fitPadding * 2);
  const availableHeight = Math.max(1, options.height - options.fitPadding * 2);
  const detailRegion = detailRegionForRig(rig, options.detail);
  const detailRect = detailRegion.rect;
  const explicitPartIds = options.partIds.length ? new Set(options.partIds) : undefined;
  const focusedPartIds = !explicitPartIds && options.focusParts && detailRegion.partIds.length ? new Set(detailRegion.partIds) : undefined;
  const allowedPartIds = explicitPartIds ?? focusedPartIds;
  const fittedScale = Math.max(MIN_SCALE, Math.min(availableWidth / detailRect.width, availableHeight / detailRect.height));
  const offsetX = (options.width - detailRect.width * fittedScale) / 2 - detailRect.x * fittedScale;
  const offsetY = (options.height - detailRect.height * fittedScale) / 2 - detailRect.y * fittedScale;
  const baseMatrix = multiplyMatrices(translateMatrix(offsetX, offsetY), scaleMatrix(fittedScale, fittedScale));
  const frame = resolveRigFrame(rig, values, baseMatrix, {
    physics: options.physics,
    physicsTime: options.physicsTime,
    physicsSteps: options.physicsSteps
  });
  const effectiveValues = frame.values;
  const computed = frame.parts;
  const tintedAssetCache = new Map<string, RgbaImage>();
  const renderable = [...rig.parts]
    .filter((part) => part.kind === "image" && part.assetId)
    .filter((part) => !allowedPartIds || allowedPartIds.has(part.id))
    .sort((left, right) => left.drawOrder - right.drawOrder);

  // Geometry a part needs both for drawing and for the glue solver. Resolving it once keeps the
  // stitch solved against exactly the vertices that get drawn.
  const partGeometryCache = new Map<string, PartDrawGeometry | undefined>();
  const partGeometry = (part: RigPart): PartDrawGeometry | undefined => {
    const cached = partGeometryCache.get(part.id);
    if (cached !== undefined || partGeometryCache.has(part.id)) {
      return cached;
    }
    const asset = part.assetId ? assets.get(part.assetId) : undefined;
    const state = computed.get(part.id);
    if (!asset || !state) {
      partGeometryCache.set(part.id, undefined);
      return undefined;
    }
    const sourceImage = resolveTintedAsset(asset.image, part.tint, tintedAssetCache, part.id);
    const warp = resolveGlueWarpForPart(rig, part, state, { width: asset.image.width, height: asset.image.height }, computed, (entry) => {
      const entryAsset = entry.assetId ? assets.get(entry.assetId) : undefined;
      return entryAsset ? { width: entryAsset.image.width, height: entryAsset.image.height } : undefined;
    });
    const baseArtMesh = resolveArtMesh(part, sourceImage.width, sourceImage.height, effectiveValues);
    const artMesh = baseArtMesh && part.artMesh?.skinning
      ? { ...baseArtMesh, vertices: applySkinningToVertices(baseArtMesh.vertices, part.artMesh.skinning, frame.skinningTransforms) }
      : baseArtMesh;
    const geometry: PartDrawGeometry = { state, sourceImage, warp, artMesh };
    partGeometryCache.set(part.id, geometry);
    return geometry;
  };

  const glueStitch = hasGlueStitches(rig)
    ? resolveGlueStitchOffsets(rig, {
        restScale: glueStitchRestScale(baseMatrix),
        projectVertex: (partId, vertexId) => {
          const part = rig.parts.find((entry) => entry.id === partId);
          const geometry = part ? partGeometry(part) : undefined;
          if (!geometry?.artMesh || !geometry.state.visible || geometry.state.opacity <= 0) {
            return undefined;
          }
          const vertex = geometry.artMesh.vertices.find((entry) => entry.id === vertexId);
          if (!vertex) {
            return undefined;
          }
          return projectArtMeshVertex(vertex, {
            pose: geometry.state.pose,
            matrix: geometry.state.matrix,
            baseMatrix,
            sharedWarps: geometry.state.sharedWarps,
            warp: geometry.warp,
            sourceWidth: geometry.sourceImage.width,
            sourceHeight: geometry.sourceImage.height
          });
        }
      }).offsets
    : undefined;

  const drawPartTo = (target: RgbaImage, part: RigPart, forceVisible = false, ignoreVisualAlpha = false) => {
    if (!part.assetId) {
      return;
    }
    const geometry = partGeometry(part);
    const state = geometry?.state;
    if (!geometry || !state || (!ignoreVisualAlpha && !forceVisible && !state.visible) || (!ignoreVisualAlpha && state.opacity <= 0)) {
      return;
    }
    const coloredImage = ignoreVisualAlpha ? geometry.sourceImage : applyContourShade(geometry.sourceImage, part.contourShade, effectiveValues);
    const sourceImage = applyAlphaReveal(coloredImage, part.alphaReveal, effectiveValues);
    const warp = geometry.warp;
    const blendMode: PartBlendMode = ignoreVisualAlpha ? "normal" : part.blendMode === "multiply" ? "multiply" : part.blendMode === "screen" ? "screen" : part.blendMode === "additive" ? "additive" : "normal";
    const opacity = ignoreVisualAlpha ? 1 : state.opacity;
    const artMesh = geometry.artMesh;
    const stitchOffsets = glueStitch?.get(part.id);
    // A deformed mesh must go through the mesh path even when the part also carries a warp or a
    // shared warp: drawArtMesh applies both per vertex, while drawWarpedImage ignores the mesh and
    // silently drops the vertex keys. Canvas has always drawn the mesh whenever one exists, so this
    // also keeps the server renderer in parity with what Preview shows.
    if (artMesh && (!isCanonicalArtMesh(artMesh, sourceImage.width, sourceImage.height) || part.artMesh?.skinning || stitchOffsets?.size)) {
      drawArtMesh(target, sourceImage, state.matrix, state.pose, opacity, artMesh, warp, baseMatrix, state.sharedWarps, blendMode, stitchOffsets);
    } else if (hasWarpEffect(warp) || state.sharedWarps?.some(hasSharedWarpFieldEffect)) {
      drawWarpedImage(target, sourceImage, state.matrix, state.pose, opacity, warp, baseMatrix, state.sharedWarps, blendMode);
    } else {
      drawImage(target, sourceImage, state.matrix, state.pose, opacity, blendMode);
    }
    drawArtPaths(target, part, effectiveValues, sourceImage.width, sourceImage.height, state.matrix, state.pose, baseMatrix, state.sharedWarps, warp);
  };

  for (let index = 0; index < renderable.length;) {
    const part = renderable[index];
    const forceVisible = Boolean(explicitPartIds?.has(part.id) && options.forceParts);
    const clip = resolvePartClip(rig, part);
    if (!clip) {
      drawPartTo(output, part, forceVisible);
      index += 1;
      continue;
    }

    const maskedParts: RigPart[] = [];
    while (index < renderable.length && sameResolvedPartClip(clip, resolvePartClip(rig, renderable[index]))) {
      maskedParts.push(renderable[index]);
      index += 1;
    }
    const content = createBlankRgba(options.width, options.height);
    for (const maskedPart of maskedParts) {
      drawPartTo(content, maskedPart, Boolean(explicitPartIds?.has(maskedPart.id) && options.forceParts));
    }
    const mask = createBlankRgba(options.width, options.height);
    for (const maskPart of clip.maskParts) drawPartTo(mask, maskPart, false, clip.clip.maskOpacity === "ignore");
    applyAlphaMask(content, mask);
    pasteImage(output, content, 0, 0);
  }
  return output;
}

async function loadAssets(assets: AssetDefinition[], publicDir: string): Promise<Map<string, DecodedAsset>> {
  const decoded = new Map<string, DecodedAsset>();
  for (const asset of assets) {
    try {
      const cacheKey = asset.id + "|" + asset.src + "|" + asset.width + "|" + asset.height;
      const cachedImage = DECODED_ASSET_CACHE.get(cacheKey);
      if (cachedImage) {
        decoded.set(asset.id, { asset, image: cachedImage });
        continue;
      }
      const bytes = await readAssetBytes(asset, publicDir);
      const image = decodePng(bytes);
      DECODED_ASSET_CACHE.set(cacheKey, image);
      while (DECODED_ASSET_CACHE.size > DECODED_ASSET_CACHE_LIMIT) {
        const oldestKey = DECODED_ASSET_CACHE.keys().next().value;
        if (oldestKey === undefined) break;
        DECODED_ASSET_CACHE.delete(oldestKey);
      }
      decoded.set(asset.id, { asset, image });
    } catch {
      // Unsupported or missing assets are skipped so one bad layer does not block comparison output.
    }
  }
  return decoded;
}

async function readAssetBytes(asset: AssetDefinition, publicDir: string): Promise<Uint8Array> {
  const dataUrlMatch = asset.src.match(/^data:image\/png;base64,(.+)$/);
  if (dataUrlMatch) {
    return new Uint8Array(Buffer.from(dataUrlMatch[1], "base64"));
  }

  if (/^https?:\/\//.test(asset.src)) {
    throw new Error(`Remote image assets are not supported by /api/screenshot yet: ${asset.name}`);
  }

  const assetPath = path.resolve(publicDir, asset.src.replace(/^\/+/, ""));
  return new Uint8Array(await readFile(assetPath));
}

function drawArtMesh(
  target: RgbaImage,
  source: RgbaImage,
  matrix: Matrix2D,
  pose: Transform2D,
  opacity: number,
  mesh: ResolvedArtMesh,
  warp: ResolvedWarpDeformer | undefined,
  baseMatrix: Matrix2D,
  sharedWarps: readonly RigSharedWarpField[] | undefined,
  blendMode: PartBlendMode,
  stitchOffsets?: Map<string, GlueVertexOffset>
) {
  const left = -pose.pivotX * source.width;
  const top = -pose.pivotY * source.height;
  const bounds = { left, top, width: source.width, height: source.height };
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const first = mesh.vertices[mesh.triangles[index]];
    const second = mesh.vertices[mesh.triangles[index + 1]];
    const third = mesh.vertices[mesh.triangles[index + 2]];
    if (!first || !second || !third) continue;
    const vertices = [first, second, third].map((vertex) => {
      const local = { x: left + vertex.x, y: top + vertex.y };
      const warped = hasWarpEffect(warp) ? warpPoint(local.x, local.y, bounds, warp) : local;
      const screen = projectSharedWarpPoint(warped, matrix, baseMatrix, sharedWarps);
      // Glue stitches are the last word: they run after warp, skinning and shared warps so a bound
      // seam vertex lands on its partner no matter how far the pose travelled.
      const stitched = applyPartGlueStitchOffset(stitchOffsets, vertex.id, screen);
      return { x: stitched.x, y: stitched.y, u: vertex.u, v: vertex.v };
    });
    drawArtMeshTriangle(target, source, vertices, opacity, blendMode);
  }
}

function drawArtMeshTriangle(
  target: RgbaImage,
  source: RgbaImage,
  rawVertices: Array<{ x: number; y: number; u: number; v: number }>,
  opacity: number,
  blendMode: PartBlendMode
) {
  let [a, b, c] = rawVertices;
  let area = edge(a, b, c);
  if (Math.abs(area) < 0.00001) return;
  if (area < 0) {
    [b, c] = [c, b];
    area = -area;
  }
  const coverage = expandTriangleForCoverage([a, b, c]);
  const minX = clampInteger(Math.floor(Math.min(...coverage.map((point) => point.x))) - 1, 0, target.width);
  const maxX = clampInteger(Math.ceil(Math.max(...coverage.map((point) => point.x))) + 1, 0, target.width);
  const minY = clampInteger(Math.floor(Math.min(...coverage.map((point) => point.y))) - 1, 0, target.height);
  const maxY = clampInteger(Math.ceil(Math.max(...coverage.map((point) => point.y))) + 1, 0, target.height);
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      const point = { x: x + 0.5, y: y + 0.5 };
      const weightA = edge(b, c, point);
      const weightB = edge(c, a, point);
      const weightC = edge(a, b, point);
      const coverageA = edge(coverage[1], coverage[2], point);
      const coverageB = edge(coverage[2], coverage[0], point);
      const coverageC = edge(coverage[0], coverage[1], point);
      if (!insideTopLeft(coverageA, coverage[1], coverage[2]) || !insideTopLeft(coverageB, coverage[2], coverage[0]) || !insideTopLeft(coverageC, coverage[0], coverage[1])) continue;
      const u = (weightA * a.u + weightB * b.u + weightC * c.u) / area;
      const v = (weightA * a.v + weightB * b.v + weightC * c.v) / area;
      const sourceX = Math.min(source.width - 1, Math.max(0, Math.floor(u * source.width)));
      const sourceY = Math.min(source.height - 1, Math.max(0, Math.floor(v * source.height)));
      const offset = (sourceY * source.width + sourceX) * 4;
      const sourceAlpha = (source.data[offset + 3] / 255) * opacity;
      if (sourceAlpha <= 0) continue;
      blendPixel(target, x, y, source.data[offset], source.data[offset + 1], source.data[offset + 2], sourceAlpha, blendMode);
    }
  }
}

function edge(a: { x: number; y: number }, b: { x: number; y: number }, point: { x: number; y: number }) {
  return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
}

function insideTopLeft(value: number, a: { x: number; y: number }, b: { x: number; y: number }) {
  if (value > 0.00001) return true;
  if (value < -0.00001) return false;
  return a.y < b.y || (a.y === b.y && a.x > b.x);
}
function drawWarpedImage(target: RgbaImage, source: RgbaImage, matrix: Matrix2D, pose: Transform2D, opacity: number, warp: ResolvedWarpDeformer | undefined, baseMatrix: Matrix2D, sharedWarps: readonly RigSharedWarpField[] | undefined, blendMode: PartBlendMode) {
  const left = -pose.pivotX * source.width;
  const top = -pose.pivotY * source.height;
  const bounds = { left, top, width: source.width, height: source.height };
  const columns = Math.max(1, Math.round(warp?.grid.columns ?? 1), ...(sharedWarps?.filter(hasSharedWarpFieldEffect).map((field) => field.grid.columns) ?? []));
  const rows = Math.max(1, Math.round(warp?.grid.rows ?? 1), ...(sharedWarps?.filter(hasSharedWarpFieldEffect).map((field) => field.grid.rows) ?? []));

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x0 = left + (source.width * column) / columns;
      const x1 = left + (source.width * (column + 1)) / columns;
      const y0 = top + (source.height * row) / rows;
      const y1 = top + (source.height * (row + 1)) / rows;
      const p00 = projectSharedWarpPoint(hasWarpEffect(warp) ? warpPoint(x0, y0, bounds, warp) : { x: x0, y: y0 }, matrix, baseMatrix, sharedWarps);
      const p10 = projectSharedWarpPoint(hasWarpEffect(warp) ? warpPoint(x1, y0, bounds, warp) : { x: x1, y: y0 }, matrix, baseMatrix, sharedWarps);
      const p11 = projectSharedWarpPoint(hasWarpEffect(warp) ? warpPoint(x1, y1, bounds, warp) : { x: x1, y: y1 }, matrix, baseMatrix, sharedWarps);
      const p01 = projectSharedWarpPoint(hasWarpEffect(warp) ? warpPoint(x0, y1, bounds, warp) : { x: x0, y: y1 }, matrix, baseMatrix, sharedWarps);
      drawWarpedCell(target, source, { x0, y0, x1, y1, left, top }, p00, p10, p11, p01, opacity, blendMode);
    }
  }
}

function drawWarpedCell(
  target: RgbaImage,
  source: RgbaImage,
  rect: { x0: number; y0: number; x1: number; y1: number; left: number; top: number },
  p00: { x: number; y: number },
  p10: { x: number; y: number },
  p11: { x: number; y: number },
  p01: { x: number; y: number },
  opacity: number,
  blendMode: PartBlendMode
) {
  // A pin warp is not affine across a cell: p11 can diverge from the
  // parallelogram derived from p00/p10/p01. Split each cell into two
  // triangles so every source-to-destination mapping is exact.
  const u0 = (rect.x0 - rect.left) / source.width;
  const v0 = (rect.y0 - rect.top) / source.height;
  const u1 = (rect.x1 - rect.left) / source.width;
  const v1 = (rect.y1 - rect.top) / source.height;
  drawArtMeshTriangle(target, source, [
    { ...p00, u: u0, v: v0 },
    { ...p10, u: u1, v: v0 },
    { ...p11, u: u1, v: v1 }
  ], opacity, blendMode);
  drawArtMeshTriangle(target, source, [
    { ...p00, u: u0, v: v0 },
    { ...p11, u: u1, v: v1 },
    { ...p01, u: u0, v: v1 }
  ], opacity, blendMode);
}
function pointTuple(point: { x: number; y: number }): [number, number] {
  return [point.x, point.y];
}
function drawArtPaths(
  target: RgbaImage,
  part: RigPart,
  values: ParameterValues,
  width: number,
  height: number,
  matrix: Matrix2D,
  pose: Transform2D,
  baseMatrix: Matrix2D,
  sharedWarps: readonly RigSharedWarpField[] | undefined,
  warp: ResolvedWarpDeformer | undefined
) {
  const paths = readRigArtPaths(part);
  if (!paths.length) return;
  const left = -pose.pivotX * width;
  const top = -pose.pivotY * height;
  const bounds = { left, top, width, height };
  const hasSharedWarp = Boolean(sharedWarps?.some(hasSharedWarpFieldEffect));
  const scale = Math.max(0.01, Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)));
  for (const path of paths) {
    const resolved = resolveArtPath(path, values, width, height);
    if (!resolved) continue;
    const points = resolved.points.map((point) => {
      const local = { x: left + point.u * width, y: top + point.v * height };
      const warped = hasWarpEffect(warp) ? warpPoint(local.x, local.y, bounds, warp) : local;
      return hasSharedWarp ? projectSharedWarpPoint(warped, matrix, baseMatrix, sharedWarps) : transformMatrixPoint(matrix, warped.x, warped.y);
    });
    drawArtPathStroke(target, points, resolved.strokeColor, Math.max(0.5, resolved.strokeWidth * scale), resolved.closed, resolved.curve);
  }
}

function drawArtPathStroke(target: RgbaImage, points: Array<{ x: number; y: number }>, color: [number, number, number, number], width: number, closed: boolean, curve: "polyline" | "smooth") {
  if (points.length < 2 || color[3] <= 0) return;
  const strokeSegment = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance * 1.5));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      drawArtPathBrush(target, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, width, color);
    }
  };
  if (curve === "smooth" && points.length > 2) {
    for (let index = 0; index < points.length - 1; index += 1) {
      const previous = points[index];
      const next = points[index + 1];
      const control = index === 0 ? previous : points[index];
      const segments = Math.max(4, Math.ceil(Math.hypot(next.x - previous.x, next.y - previous.y) / 3));
      let last = previous;
      for (let step = 1; step <= segments; step += 1) {
        const t = step / segments;
        const oneMinus = 1 - t;
        const current = { x: oneMinus * oneMinus * previous.x + 2 * oneMinus * t * control.x + t * t * next.x, y: oneMinus * oneMinus * previous.y + 2 * oneMinus * t * control.y + t * t * next.y };
        strokeSegment(last, current);
        last = current;
      }
    }
  } else {
    for (let index = 0; index < points.length - 1; index += 1) strokeSegment(points[index], points[index + 1]);
  }
  if (closed) strokeSegment(points[points.length - 1], points[0]);
}

function drawArtPathBrush(target: RgbaImage, x: number, y: number, width: number, color: [number, number, number, number]) {
  const radius = Math.max(0.5, width / 2);
  const minX = Math.floor(x - radius);
  const maxX = Math.ceil(x + radius);
  const minY = Math.floor(y - radius);
  const maxY = Math.ceil(y + radius);
  for (let yy = minY; yy <= maxY; yy += 1) {
    for (let xx = minX; xx <= maxX; xx += 1) {      if (xx < 0 || xx >= target.width || yy < 0 || yy >= target.height) continue;

      const dx = xx + 0.5 - x;
      const dy = yy + 0.5 - y;
      if (dx * dx + dy * dy <= radius * radius) blendPixel(target, xx, yy, color[0], color[1], color[2], color[3] / 255);
    }
  }
}
function drawImage(target: RgbaImage, source: RgbaImage, matrix: Matrix2D, pose: Transform2D, opacity: number, blendMode: PartBlendMode) {
  const left = -pose.pivotX * source.width;
  const top = -pose.pivotY * source.height;
  const right = left + source.width;
  const bottom = top + source.height;
  const corners = [
    transformMatrixPoint(matrix, left, top),
    transformMatrixPoint(matrix, right, top),
    transformMatrixPoint(matrix, right, bottom),
    transformMatrixPoint(matrix, left, bottom)
  ];
  const minX = clampInteger(Math.floor(Math.min(...corners.map((point) => point.x))) - 1, 0, target.width);
  const maxX = clampInteger(Math.ceil(Math.max(...corners.map((point) => point.x))) + 1, 0, target.width);
  const minY = clampInteger(Math.floor(Math.min(...corners.map((point) => point.y))) - 1, 0, target.height);
  const maxY = clampInteger(Math.ceil(Math.max(...corners.map((point) => point.y))) + 1, 0, target.height);
  const inverse = invertMatrix(matrix);

  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      const local = transformMatrixPoint(inverse, x + 0.5, y + 0.5);
      const sourceX = Math.floor(local.x - left);
      const sourceY = Math.floor(local.y - top);
      if (sourceX < 0 || sourceX >= source.width || sourceY < 0 || sourceY >= source.height) {
        continue;
      }

      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const sourceAlpha = (source.data[sourceOffset + 3] / 255) * opacity;
      if (sourceAlpha <= 0) {
        continue;
      }

      blendPixel(target, x, y, source.data[sourceOffset], source.data[sourceOffset + 1], source.data[sourceOffset + 2], sourceAlpha, blendMode);
    }
  }
}

function applyAlphaMask(target: RgbaImage, mask: RgbaImage) {
  if (target.width !== mask.width || target.height !== mask.height) {
    throw new Error("Alpha-mask image dimensions must match the clipped content.");
  }
  for (let offset = 3; offset < target.data.length; offset += 4) {
    target.data[offset] = Math.round((target.data[offset] * mask.data[offset]) / 255);
  }
}
function pasteImage(target: RgbaImage, source: RgbaImage, x: number, y: number) {
  for (let sourceY = 0; sourceY < source.height; sourceY += 1) {
    const targetY = y + sourceY;
    if (targetY < 0 || targetY >= target.height) {
      continue;
    }
    for (let sourceX = 0; sourceX < source.width; sourceX += 1) {
      const targetX = x + sourceX;
      if (targetX < 0 || targetX >= target.width) {
        continue;
      }
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      blendPixel(
        target,
        targetX,
        targetY,
        source.data[sourceOffset],
        source.data[sourceOffset + 1],
        source.data[sourceOffset + 2],
        source.data[sourceOffset + 3] / 255
      );
    }
  }
}

function resolveTintedAsset(source: RgbaImage, tint: RigPartTint | undefined, cache: Map<string, RgbaImage>, partId: string): RgbaImage {
  if (!tint || !/^#[0-9a-fA-F]{6}$/.test(tint.color) || (tint.mode !== "multiply" && tint.mode !== "screen") || !Number.isFinite(tint.opacity) || tint.opacity <= 0) return source;
  const opacity = Math.min(1, Math.max(0, tint.opacity));
  if (opacity <= 0) return source;
  const key = `${partId}:${tint.mode}:${tint.color.toLowerCase()}:${opacity}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const [red, green, blue] = parseTintColor(tint.color);
  const data = new Uint8ClampedArray(source.data);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = applyTintChannel(data[index], red, opacity, tint.mode);
    data[index + 1] = applyTintChannel(data[index + 1], green, opacity, tint.mode);
    data[index + 2] = applyTintChannel(data[index + 2], blue, opacity, tint.mode);
  }
  const tinted = { width: source.width, height: source.height, data };
  cache.set(key, tinted);
  return tinted;
}
function fillRect(image: RgbaImage, x: number, y: number, width: number, height: number, color: [number, number, number, number]) {
  for (let yy = Math.max(0, y); yy < Math.min(image.height, y + height); yy += 1) {
    for (let xx = Math.max(0, x); xx < Math.min(image.width, x + width); xx += 1) {
      blendPixel(image, xx, yy, color[0], color[1], color[2], color[3] / 255);
    }
  }
}

function blendPixel(image: RgbaImage, x: number, y: number, red: number, green: number, blue: number, alpha: number, blendMode: PartBlendMode = "normal") {
  const offset = (y * image.width + x) * 4;
  const destinationAlpha = image.data[offset + 3] / 255;
  const outputAlpha = alpha + destinationAlpha * (1 - alpha);
  if (outputAlpha <= 0) {
    image.data[offset] = 0;
    image.data[offset + 1] = 0;
    image.data[offset + 2] = 0;
    image.data[offset + 3] = 0;
    return;
  }

if (blendMode === "multiply" || blendMode === "screen" || blendMode === "additive") {
    const source = [red / 255, green / 255, blue / 255];
    const destination = [image.data[offset] / 255, image.data[offset + 1] / 255, image.data[offset + 2] / 255];
    for (let channel = 0; channel < 3; channel += 1) {
      const blended = blendMode === "multiply"
        ? source[channel] * destination[channel]
        : blendMode === "screen"
          ? 1 - (1 - source[channel]) * (1 - destination[channel])
          : Math.min(1, source[channel] + destination[channel]);
      const premultiplied = source[channel] * alpha * (1 - destinationAlpha) + blended * alpha * destinationAlpha + destination[channel] * destinationAlpha * (1 - alpha);
      image.data[offset + channel] = Math.round(255 * premultiplied / outputAlpha);
    }
    image.data[offset + 3] = Math.round(outputAlpha * 255);
    return;
  }
  image.data[offset] = Math.round((red * alpha + image.data[offset] * destinationAlpha * (1 - alpha)) / outputAlpha);
  image.data[offset + 1] = Math.round((green * alpha + image.data[offset + 1] * destinationAlpha * (1 - alpha)) / outputAlpha);
  image.data[offset + 2] = Math.round((blue * alpha + image.data[offset + 2] * destinationAlpha * (1 - alpha)) / outputAlpha);
  image.data[offset + 3] = Math.round(outputAlpha * 255);
}

function drawText(image: RgbaImage, text: string, x: number, y: number, scaleValue: number, color: [number, number, number, number]) {
  let cursor = x;
  for (const rawCharacter of text.toUpperCase()) {
    const rows = FONT[rawCharacter] ?? FONT["?"];
    for (let row = 0; row < rows.length; row += 1) {
      for (let column = 0; column < rows[row].length; column += 1) {
        if (rows[row][column] === "1") {
          fillRect(image, cursor + column * scaleValue, y + row * scaleValue, scaleValue, scaleValue, color);
        }
      }
    }
    cursor += (rows[0].length + 1) * scaleValue;
  }
}


export function downsampleRgbaImage(source: RgbaImage, width: number, height: number): RgbaImage {
  if (source.width === width && source.height === height) return source;
  const output = createBlankRgba(width, height);
  const scaleX = source.width / width;
  const scaleY = source.height / height;
  for (let y = 0; y < height; y += 1) {
    const top = Math.floor(y * scaleY);
    const bottom = Math.min(source.height, Math.max(top + 1, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < width; x += 1) {
      const left = Math.floor(x * scaleX);
      const right = Math.min(source.width, Math.max(left + 1, Math.ceil((x + 1) * scaleX)));
      let alphaSum = 0, redPremultiplied = 0, greenPremultiplied = 0, bluePremultiplied = 0;
      for (let sourceY = top; sourceY < bottom; sourceY += 1) {
        for (let sourceX = left; sourceX < right; sourceX += 1) {
          const sourceOffset = (sourceY * source.width + sourceX) * 4;
          const alpha = source.data[sourceOffset + 3] / 255;
          alphaSum += alpha;
          redPremultiplied += source.data[sourceOffset] * alpha;
          greenPremultiplied += source.data[sourceOffset + 1] * alpha;
          bluePremultiplied += source.data[sourceOffset + 2] * alpha;
        }
      }
      const count = Math.max(1, (right - left) * (bottom - top));
      const alpha = alphaSum / count;
      const outputOffset = (y * width + x) * 4;
      output.data[outputOffset + 3] = Math.round(alpha * 255);
      if (alpha > 0) {
        output.data[outputOffset] = Math.round(redPremultiplied / alphaSum);
        output.data[outputOffset + 1] = Math.round(greenPremultiplied / alphaSum);
        output.data[outputOffset + 2] = Math.round(bluePremultiplied / alphaSum);
      }
    }
  }
  return output;
}
function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function parseFocusParts(url: URL): boolean {
  const value = url.searchParams.get("focusParts") ?? url.searchParams.get("focus");
  return value === "1" || value === "true" || value === "detail";
}

function parsePartIds(url: URL): string[] {
  const values = [...url.searchParams.getAll("partId"), ...url.searchParams.getAll("partIds")];
  const ids = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

function parseBooleanParam(url: URL, key: string): boolean {
  const value = url.searchParams.get(key);
  return value === "1" || value === "true" || value === "yes";
}

function numberParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
const FONT: Record<string, string[]> = {
  " ": ["0", "0", "0", "0", "0"],
  "+": ["000", "010", "111", "010", "000"],
  "-": ["000", "000", "111", "000", "000"],
  ".": ["0", "0", "0", "0", "1"],
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "A": ["010", "101", "111", "101", "101"],
  "B": ["110", "101", "110", "101", "110"],
  "C": ["111", "100", "100", "100", "111"],
  "D": ["110", "101", "101", "101", "110"],
  "E": ["111", "100", "110", "100", "111"],
  "F": ["111", "100", "110", "100", "100"],
  "G": ["111", "100", "101", "101", "111"],
  "H": ["101", "101", "111", "101", "101"],
  "I": ["111", "010", "010", "010", "111"],
  "J": ["001", "001", "001", "101", "111"],
  "K": ["101", "101", "110", "101", "101"],
  "L": ["100", "100", "100", "100", "111"],
  "M": ["101", "111", "111", "101", "101"],
  "N": ["101", "111", "111", "111", "101"],
  "O": ["111", "101", "101", "101", "111"],
  "P": ["111", "101", "111", "100", "100"],
  "Q": ["111", "101", "101", "111", "001"],
  "R": ["111", "101", "111", "110", "101"],
  "S": ["111", "100", "111", "001", "111"],
  "T": ["111", "010", "010", "010", "010"],
  "U": ["101", "101", "101", "101", "111"],
  "V": ["101", "101", "101", "101", "010"],
  "W": ["101", "101", "111", "111", "101"],
  "X": ["101", "101", "010", "101", "101"],
  "Y": ["101", "101", "010", "010", "010"],
  "Z": ["111", "001", "010", "100", "111"],
  "?": ["111", "001", "011", "000", "010"]
};
