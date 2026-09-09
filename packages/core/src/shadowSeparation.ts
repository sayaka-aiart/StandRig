import { decodePng, encodePng, type RgbaImage } from "./png.js";
import { cloneRig, type AssetDefinition, type RigDocument, type RigPart } from "./types.js";

export interface ShadowSeparationRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShadowSeparationOptions {
  region?: ShadowSeparationRegion;
  alphaThreshold?: number;
  darknessThreshold?: number;
  lift?: number;
}

export interface ShadowSeparationAssetRequest extends ShadowSeparationOptions {
  assetIds?: string[];
  partIds?: string[];
  scope?: "artmesh" | "all";
  basePath?: string;
}

export interface ShadowSeparationAudit {
  region: { x: number; y: number; width: number; height: number };
  alphaThreshold: number;
  darknessThreshold: number;
  lift: number;
  opaquePixelCount: number;
  neutralChangedPixelCount: number;
  shadowPixelCount: number;
  alphaChangedPixelCount: number;
  reconstructionDiffPixelCount: number;
  reconstructionMaxChannelDelta: number;
  reconstructionMeanChannelDelta: number;
  reconstructionPass: boolean;
}

export interface ShadowSeparationAssetResult {
  rig: RigDocument;
  files: Map<string, Uint8Array>;
  manifestEntries: Array<{ assetId: string; path: string; sha256: string; mediaType: "image/png"; bytes: number }>;
  assets: Array<{
    sourceAssetId: string;
    neutralAssetId: string;
    shadowAssetId: string;
    path: string;
    shadowPath: string;
    sha256: string;
    shadowSha256: string;
    audit: ShadowSeparationAudit;
    rewiredPartIds: string[];
    shadowPartIds: string[];
  }>;
  skipped: Array<{ assetId: string; reason: string }>;
  changed: boolean;
}

export type ShadowSeparationAssetLoader = (asset: AssetDefinition) => Promise<{ mediaType: string; bytes: Uint8Array }>;

export function separateShadow(source: RgbaImage, options: ShadowSeparationOptions = {}): { neutral: RgbaImage; shadow: RgbaImage; audit: ShadowSeparationAudit } {
  const alphaThreshold = clampByte(options.alphaThreshold ?? 250, 1, 255);
  const darknessThreshold = clampUnit(options.darknessThreshold ?? 0.9);
  const lift = clampUnit(options.lift ?? 0.18);
  const region = resolveRegion(source, options.region);
  const neutralData = new Uint8ClampedArray(source.data);
  const shadowData = new Uint8ClampedArray(source.data.length);
  let opaquePixelCount = 0;
  let neutralChangedPixelCount = 0;
  let shadowPixelCount = 0;
  let alphaChangedPixelCount = 0;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 4;
      const sourceAlpha = source.data[offset + 3];
      if (neutralData[offset + 3] !== sourceAlpha) alphaChangedPixelCount += 1;
      if (sourceAlpha < alphaThreshold || x < region.x || y < region.y || x >= region.x + region.width || y >= region.y + region.height) continue;
      opaquePixelCount += 1;
      const red = source.data[offset];
      const green = source.data[offset + 1];
      const blue = source.data[offset + 2];
      const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
      const darkness = clampUnit((darknessThreshold - luminance) / Math.max(0.0001, darknessThreshold));
      const strength = darkness * lift;
      if (strength <= 0) continue;
      const nextRed = Math.min(255, Math.round(red + (255 - red) * strength));
      const nextGreen = Math.min(255, Math.round(green + (255 - green) * strength));
      const nextBlue = Math.min(255, Math.round(blue + (255 - blue) * strength));
      if (nextRed === red && nextGreen === green && nextBlue === blue) continue;
      neutralData[offset] = nextRed;
      neutralData[offset + 1] = nextGreen;
      neutralData[offset + 2] = nextBlue;
      // The shadow image is an exact multiply factor for opaque pixels. This
      // keeps re-composition deterministic instead of baking a second color.
      shadowData[offset] = multiplyFactor(red, nextRed);
      shadowData[offset + 1] = multiplyFactor(green, nextGreen);
      shadowData[offset + 2] = multiplyFactor(blue, nextBlue);
      shadowData[offset + 3] = 255;
      neutralChangedPixelCount += 1;
      shadowPixelCount += 1;
    }
  }

  const reconstruction = reconstructMultiply(neutralData, shadowData);
  let reconstructionDiffPixelCount = 0;
  let reconstructionMaxChannelDelta = 0;
  let reconstructionDeltaTotal = 0;
  for (let index = 0; index < source.data.length; index += 4) {
    const alphaDelta = Math.abs(reconstruction[index + 3] - source.data[index + 3]);
    if (alphaDelta > 0) alphaChangedPixelCount += 1;
    let changed = alphaDelta > 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(reconstruction[index + channel] - source.data[index + channel]);
      reconstructionMaxChannelDelta = Math.max(reconstructionMaxChannelDelta, delta);
      reconstructionDeltaTotal += delta;
      if (delta > 0) changed = true;
    }
    if (changed) reconstructionDiffPixelCount += 1;
  }
  const pixelCount = source.width * source.height;
  const audit: ShadowSeparationAudit = {
    region,
    alphaThreshold,
    darknessThreshold,
    lift,
    opaquePixelCount,
    neutralChangedPixelCount,
    shadowPixelCount,
    alphaChangedPixelCount,
    reconstructionDiffPixelCount,
    reconstructionMaxChannelDelta,
    reconstructionMeanChannelDelta: pixelCount ? reconstructionDeltaTotal / (pixelCount * 3) : 0,
    reconstructionPass: alphaChangedPixelCount === 0 && reconstructionMaxChannelDelta <= 1
  };
  return {
    neutral: { width: source.width, height: source.height, data: neutralData },
    shadow: { width: source.width, height: source.height, data: shadowData },
    audit
  };
}

export async function deriveShadowSeparationAssets(source: RigDocument, request: ShadowSeparationAssetRequest, load: ShadowSeparationAssetLoader): Promise<ShadowSeparationAssetResult> {
  const before = JSON.stringify(source);
  const rig = cloneRig(source);
  const basePath = `/${(request.basePath ?? "/assets").replace(/^\/+|\/+$/g, "")}`;
  const existingEntries = shadowMetadataEntries(rig);
  const canonicalByDerived = new Map<string, string>();
  for (const entry of existingEntries) { canonicalByDerived.set(entry.neutralAssetId, entry.sourceAssetId); canonicalByDerived.set(entry.shadowAssetId, entry.sourceAssetId); }
  const requested = unique(selectedSourceAssetIds(rig, request).map((assetId) => canonicalByDerived.get(assetId) ?? assetId));
  const files = new Map<string, Uint8Array>();
  const manifestEntries: ShadowSeparationAssetResult["manifestEntries"] = [];
  const assets: ShadowSeparationAssetResult["assets"] = [];
  const skipped: ShadowSeparationAssetResult["skipped"] = [];
  for (const sourceAssetId of requested) {
    const sourceAsset = rig.assets.find((entry) => entry.id === sourceAssetId);
    if (!sourceAsset) { skipped.push({ assetId: sourceAssetId, reason: "missing-asset" }); continue; }
    let loaded: { mediaType: string; bytes: Uint8Array };
    try { loaded = await load(sourceAsset); } catch (error) { skipped.push({ assetId: sourceAssetId, reason: `load-failed:${String(error)}` }); continue; }
    if (loaded.mediaType.toLowerCase() !== "image/png") { skipped.push({ assetId: sourceAssetId, reason: `unsupported-media-type:${loaded.mediaType}` }); continue; }
    let decoded: RgbaImage;
    try { decoded = decodePng(loaded.bytes); } catch (error) { skipped.push({ assetId: sourceAssetId, reason: `decode-failed:${String(error)}` }); continue; }
    const separated = separateShadow(decoded, request);
    const neutralBytes = encodePng(separated.neutral);
    const shadowBytes = encodePng(separated.shadow);
    const sha256 = await hashBytes(neutralBytes);
    const shadowSha256 = await hashBytes(shadowBytes);
    const neutralAssetId = shadowNeutralAssetId(sourceAssetId, request);
    const shadowAssetId = shadowLayerAssetId(sourceAssetId, request);
    const priorEntry = existingEntries.find((entry) => entry.sourceAssetId === sourceAssetId);
    const sourceVariants = new Set([sourceAssetId, priorEntry?.neutralAssetId, priorEntry?.shadowAssetId].filter((value): value is string => Boolean(value)));
    const neutralPath = `${basePath}/${sha256}.png`;
    const shadowPath = `${basePath}/${shadowSha256}.png`;
    upsertAsset(rig, { id: neutralAssetId, name: `${sourceAsset.name} [shadow neutral]`, type: "image", src: neutralPath, sha256, width: decoded.width, height: decoded.height });
    upsertAsset(rig, { id: shadowAssetId, name: `${sourceAsset.name} [shadow multiply]`, type: "image", src: shadowPath, sha256: shadowSha256, width: decoded.width, height: decoded.height });
    const rewiredPartIds: string[] = [];
    const shadowPartIds: string[] = [];
    for (const part of rig.parts.filter((entry) => sourceVariants.has(entry.assetId ?? "") && partMatchesSelection(entry, request))) {
      part.assetId = neutralAssetId;
      rewiredPartIds.push(part.id);
      const shadowPartId = `${part.id}--shadow-separated`;
      upsertShadowPart(rig, part, shadowPartId, shadowAssetId);
      shadowPartIds.push(shadowPartId);
    }
    files.set(neutralPath, neutralBytes);
    files.set(shadowPath, shadowBytes);
    manifestEntries.push({ assetId: neutralAssetId, path: neutralPath, sha256, mediaType: "image/png", bytes: neutralBytes.byteLength });
    manifestEntries.push({ assetId: shadowAssetId, path: shadowPath, sha256: shadowSha256, mediaType: "image/png", bytes: shadowBytes.byteLength });
    assets.push({ sourceAssetId, neutralAssetId, shadowAssetId, path: neutralPath, shadowPath, sha256, shadowSha256, audit: separated.audit, rewiredPartIds, shadowPartIds });
    upsertShadowMetadata(rig, { sourceAssetId, neutralAssetId, shadowAssetId, sha256, shadowSha256, region: separated.audit.region, audit: separated.audit });
  }
  return { rig, files, manifestEntries, assets, skipped, changed: JSON.stringify(rig) !== before };
}

export function shadowNeutralAssetId(sourceAssetId: string, options: ShadowSeparationOptions = {}): string {
  return `${sourceAssetId}--shadow-neutral-${shadowOptionsKey(options)}`;
}

export function shadowLayerAssetId(sourceAssetId: string, options: ShadowSeparationOptions = {}): string {
  return `${sourceAssetId}--shadow-layer-${shadowOptionsKey(options)}`;
}

function shadowOptionsKey(options: ShadowSeparationOptions): string {
  const threshold = Math.round(clampUnit(options.darknessThreshold ?? 0.9) * 100);
  const lift = Math.round(clampUnit(options.lift ?? 0.18) * 100);
  const alpha = clampByte(options.alphaThreshold ?? 250, 1, 255);
  return `a${alpha}-t${threshold}-l${lift}`;
}

function resolveRegion(source: RgbaImage, region: ShadowSeparationRegion | undefined) {
  const x = clampInteger((region?.x ?? 0) * source.width, 0, source.width);
  const y = clampInteger((region?.y ?? 0) * source.height, 0, source.height);
  const width = clampInteger((region?.width ?? 1) * source.width, 0, source.width - x);
  const height = clampInteger((region?.height ?? 1) * source.height, 0, source.height - y);
  return { x, y, width, height };
}

function reconstructMultiply(neutral: Uint8ClampedArray, shadow: Uint8ClampedArray): Uint8ClampedArray {
  const output = new Uint8ClampedArray(neutral);
  for (let index = 0; index < output.length; index += 4) {
    if (shadow[index + 3] === 0) continue;
    output[index] = Math.round(neutral[index] * shadow[index] / 255);
    output[index + 1] = Math.round(neutral[index + 1] * shadow[index + 1] / 255);
    output[index + 2] = Math.round(neutral[index + 2] * shadow[index + 2] / 255);
  }
  return output;
}

function multiplyFactor(source: number, neutral: number): number {
  if (neutral <= 0) return 255;
  return clampByte(Math.round(source * 255 / neutral), 0, 255);
}

function upsertAsset(rig: RigDocument, asset: AssetDefinition) {
  const existing = rig.assets.find((entry) => entry.id === asset.id);
  if (existing) Object.assign(existing, asset);
  else rig.assets.push(asset);
}

function upsertShadowPart(rig: RigDocument, source: RigPart, id: string, assetId: string) {
  const existing = rig.parts.find((entry) => entry.id === id);
  const shadow: RigPart = existing ?? { ...structuredClone(source), id, name: `${source.name} [shadow]` };
  shadow.name = `${source.name} [shadow]`;
  shadow.assetId = assetId;
  shadow.drawOrder = source.drawOrder + 0.001;
  shadow.blendMode = "multiply";
  shadow.visible = source.visible;
  shadow.locked = false;
  delete shadow.role;
  delete shadow.roleStatus;
  delete shadow.roleConfidence;
  delete shadow.artPaths;
  shadow.tags = [...new Set([...(source.tags ?? []), "shadow-separated", "generated"])];
  if (!existing) rig.parts.push(shadow);
}

function selectedSourceAssetIds(rig: RigDocument, request: ShadowSeparationAssetRequest): string[] {
  if (request.assetIds?.length) return unique(request.assetIds);
  const partIdSet = request.partIds?.length ? new Set(request.partIds) : undefined;
  const selected = rig.parts.filter((part) => part.assetId && (!partIdSet || partIdSet.has(part.id)) && (partIdSet || request.scope === "all" || Boolean(part.artMesh)));
  return unique(selected.map((part) => part.assetId!));
}

function partMatchesSelection(part: RigPart, request: ShadowSeparationAssetRequest): boolean {
  if (request.partIds?.length) return request.partIds.includes(part.id);
  if (request.assetIds?.length || request.scope === "all") return true;
  return Boolean(part.artMesh);
}

interface ShadowMetadataEntry { sourceAssetId: string; neutralAssetId: string; shadowAssetId: string; sha256?: string; shadowSha256?: string; region?: { x: number; y: number; width: number; height: number }; audit?: ShadowSeparationAudit }
function shadowMetadataEntries(rig: RigDocument): ShadowMetadataEntry[] {
  const raw = rig.metadata?.shadowSeparationDerivations as { entries?: unknown } | undefined;
  return Array.isArray(raw?.entries) ? raw.entries.filter((item): item is ShadowMetadataEntry => Boolean(item && typeof item === "object" && typeof (item as ShadowMetadataEntry).sourceAssetId === "string" && typeof (item as ShadowMetadataEntry).neutralAssetId === "string" && typeof (item as ShadowMetadataEntry).shadowAssetId === "string")) : [];
}

function upsertShadowMetadata(rig: RigDocument, entry: { sourceAssetId: string; neutralAssetId: string; shadowAssetId: string; sha256: string; shadowSha256: string; region: { x: number; y: number; width: number; height: number }; audit: ShadowSeparationAudit }) {
  rig.metadata ??= {};
  const raw = rig.metadata.shadowSeparationDerivations as { entries?: unknown } | undefined;
  const entries = Array.isArray(raw?.entries) ? raw.entries.filter((item) => item && typeof item === "object" && (item as { sourceAssetId?: unknown }).sourceAssetId !== entry.sourceAssetId) : [];
  entries.push(entry);
  rig.metadata.shadowSeparationDerivations = { version: 1, entries };
}

async function hashBytes(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unique(values: string[]) { return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))]; }
function clampUnit(value: number) { return Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 0)); }
function clampByte(value: number, min: number, max: number) { const numeric = Number(value); return Math.max(min, Math.min(max, Number.isFinite(numeric) ? Math.round(numeric) : min)); }
function clampInteger(value: number, min: number, max: number) { return Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Math.round(Number(value)) : min)); }
