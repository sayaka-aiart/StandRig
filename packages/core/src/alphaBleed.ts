import { decodePng, encodePng, type RgbaImage } from "./png.js";
import { cloneRig, type AssetDefinition, type RigDocument } from "./types.js";

export interface AlphaBleedOptions {
  radius?: number;
  alphaThreshold?: number;
}

export interface AlphaBleedAudit {
  radius: number;
  alphaThreshold: number;
  transparentPixelCount: number;
  reachedPixelCount: number;
  changedPixelCount: number;
  unfilledTransparentPixelCount: number;
}

export interface AlphaBleedAssetRequest extends AlphaBleedOptions {
  assetIds?: string[];
  partIds?: string[];
  scope?: "artmesh" | "all";
  basePath?: string;
}

export interface AlphaBleedAssetResult {
  rig: RigDocument;
  files: Map<string, Uint8Array>;
  manifestEntries: Array<{ assetId: string; path: string; sha256: string; mediaType: "image/png"; bytes: number }>;
  assets: Array<{ sourceAssetId: string; derivedAssetId: string; path: string; sha256: string; audit: AlphaBleedAudit; rewiredPartIds: string[] }>;
  skipped: Array<{ assetId: string; reason: string }>;
  changed: boolean;
}

export type AlphaBleedAssetLoader = (asset: AssetDefinition) => Promise<{ mediaType: string; bytes: Uint8Array }>;

export function expandTransparentRgb(source: RgbaImage, options: AlphaBleedOptions = {}): { image: RgbaImage; audit: AlphaBleedAudit } {
  const radius = clampInteger(options.radius ?? 4, 1, 32);
  const alphaThreshold = clampInteger(options.alphaThreshold ?? 0, 0, 254);
  const data = new Uint8ClampedArray(source.data);
  let known = new Uint8Array(source.width * source.height);
  let transparentPixelCount = 0;
  for (let pixel = 0; pixel < known.length; pixel += 1) {
    const alpha = source.data[pixel * 4 + 3];
    if (alpha > alphaThreshold) known[pixel] = 1;
    else transparentPixelCount += 1;
  }

  let reachedPixelCount = 0;
  for (let step = 0; step < radius; step += 1) {
    const next = new Uint8Array(known);
    let reachedThisStep = 0;
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const pixel = y * source.width + x;
        if (known[pixel]) continue;
        let red = 0, green = 0, blue = 0, samples = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= source.width || ny >= source.height) continue;
            const neighbor = ny * source.width + nx;
            if (!known[neighbor]) continue;
            const offset = neighbor * 4;
            red += data[offset]; green += data[offset + 1]; blue += data[offset + 2]; samples += 1;
          }
        }
        if (!samples) continue;
        const offset = pixel * 4;
        data[offset] = Math.round(red / samples);
        data[offset + 1] = Math.round(green / samples);
        data[offset + 2] = Math.round(blue / samples);
        next[pixel] = 1;
        reachedThisStep += 1;
      }
    }
    known = next;
    reachedPixelCount += reachedThisStep;
    if (!reachedThisStep) break;
  }

  let changedPixelCount = 0;
  for (let pixel = 0; pixel < known.length; pixel += 1) {
    const offset = pixel * 4;
    if (data[offset] !== source.data[offset] || data[offset + 1] !== source.data[offset + 1] || data[offset + 2] !== source.data[offset + 2]) changedPixelCount += 1;
  }
  return {
    image: { width: source.width, height: source.height, data },
    audit: { radius, alphaThreshold, transparentPixelCount, reachedPixelCount, changedPixelCount, unfilledTransparentPixelCount: transparentPixelCount - reachedPixelCount }
  };
}

export async function deriveAlphaBleedAssets(source: RigDocument, request: AlphaBleedAssetRequest, load: AlphaBleedAssetLoader): Promise<AlphaBleedAssetResult> {
  const before = JSON.stringify(source);
  const rig = cloneRig(source);
  const radius = clampInteger(request.radius ?? 4, 1, 32);
  const alphaThreshold = clampInteger(request.alphaThreshold ?? 0, 0, 254);
  const basePath = `/${(request.basePath ?? "/assets").replace(/^\/+|\/+$/g, "")}`;
  const existingEntries = alphaBleedMetadataEntries(rig);
  const sourceByDerived = new Map(existingEntries.map((entry) => [entry.derivedAssetId, entry.sourceAssetId]));
  const requested = selectedSourceAssetIds(rig, request, sourceByDerived);
  const files = new Map<string, Uint8Array>();
  const manifestEntries: AlphaBleedAssetResult["manifestEntries"] = [];
  const assets: AlphaBleedAssetResult["assets"] = [];
  const skipped: AlphaBleedAssetResult["skipped"] = [];

  for (const sourceAssetId of requested) {
    const sourceAsset = rig.assets.find((asset) => asset.id === sourceAssetId);
    if (!sourceAsset) { skipped.push({ assetId: sourceAssetId, reason: "missing-asset" }); continue; }
    let loaded: { mediaType: string; bytes: Uint8Array };
    try { loaded = await load(sourceAsset); } catch (error) { skipped.push({ assetId: sourceAssetId, reason: `load-failed:${String(error)}` }); continue; }
    if (loaded.mediaType.toLowerCase() !== "image/png") { skipped.push({ assetId: sourceAssetId, reason: `unsupported-media-type:${loaded.mediaType}` }); continue; }
    let decoded: RgbaImage;
    try { decoded = decodePng(loaded.bytes); } catch (error) { skipped.push({ assetId: sourceAssetId, reason: `decode-failed:${String(error)}` }); continue; }
    const processed = expandTransparentRgb(decoded, { radius, alphaThreshold });
    const bytes = encodePng(processed.image);
    const sha256 = await hashBytes(bytes);
    const path = `${basePath}/${sha256}.png`;
    const derivedAssetId = alphaBleedDerivedAssetId(sourceAssetId, radius, alphaThreshold);
    const existingAsset = rig.assets.find((asset) => asset.id === derivedAssetId);
    const derivedAsset: AssetDefinition = { id: derivedAssetId, name: `${sourceAsset.name} [alpha bleed r${radius}]`, type: "image", src: path, sha256, width: decoded.width, height: decoded.height };
    if (existingAsset) Object.assign(existingAsset, derivedAsset); else rig.assets.push(derivedAsset);
    const priorDerivedIds = new Set(existingEntries.filter((entry) => entry.sourceAssetId === sourceAssetId).map((entry) => entry.derivedAssetId));
    const rewiredPartIds: string[] = [];
    for (const part of rig.parts) {
      if (part.assetId !== sourceAssetId && !priorDerivedIds.has(part.assetId ?? "")) continue;
      if (!partMatchesSelection(part.id, request, rig)) continue;
      if (part.assetId !== derivedAssetId) part.assetId = derivedAssetId;
      rewiredPartIds.push(part.id);
    }
    files.set(path, bytes);
    manifestEntries.push({ assetId: derivedAssetId, path, sha256, mediaType: "image/png", bytes: bytes.byteLength });
    assets.push({ sourceAssetId, derivedAssetId, path, sha256, audit: processed.audit, rewiredPartIds });
    upsertAlphaBleedMetadata(rig, { sourceAssetId, derivedAssetId, radius, alphaThreshold, sha256, path });
  }
  return { rig, files, manifestEntries, assets, skipped, changed: JSON.stringify(rig) !== before };
}

export function alphaBleedDerivedAssetId(sourceAssetId: string, radius: number, alphaThreshold: number): string {
  return `${sourceAssetId}--alpha-bleed-r${clampInteger(radius, 1, 32)}-a${clampInteger(alphaThreshold, 0, 254)}`;
}

function selectedSourceAssetIds(rig: RigDocument, request: AlphaBleedAssetRequest, sourceByDerived: Map<string, string>): string[] {
  if (request.assetIds?.length) return unique(request.assetIds.map((id) => sourceByDerived.get(id) ?? id));
  const partIdSet = request.partIds?.length ? new Set(request.partIds) : undefined;
  const selected = rig.parts.filter((part) => part.assetId && (!partIdSet || partIdSet.has(part.id)) && (partIdSet || request.scope === "all" || Boolean(part.artMesh)));
  return unique(selected.map((part) => sourceByDerived.get(part.assetId!) ?? part.assetId!));
}

function partMatchesSelection(partId: string, request: AlphaBleedAssetRequest, rig: RigDocument): boolean {
  if (request.partIds?.length) return request.partIds.includes(partId);
  if (request.assetIds?.length || request.scope === "all") return true;
  return Boolean(rig.parts.find((part) => part.id === partId)?.artMesh);
}

interface AlphaBleedMetadataEntry { sourceAssetId: string; derivedAssetId: string; radius: number; alphaThreshold: number; sha256: string; path: string }
function alphaBleedMetadataEntries(rig: RigDocument): AlphaBleedMetadataEntry[] {
  const raw = rig.metadata?.alphaBleedDerivations as { entries?: unknown } | undefined;
  return Array.isArray(raw?.entries) ? raw.entries.filter((entry): entry is AlphaBleedMetadataEntry => Boolean(entry && typeof entry === "object" && typeof (entry as AlphaBleedMetadataEntry).sourceAssetId === "string" && typeof (entry as AlphaBleedMetadataEntry).derivedAssetId === "string")) : [];
}
function upsertAlphaBleedMetadata(rig: RigDocument, entry: AlphaBleedMetadataEntry) {
  rig.metadata ??= {};
  const entries = alphaBleedMetadataEntries(rig).filter((item) => item.derivedAssetId !== entry.derivedAssetId);
  entries.push(entry);
  rig.metadata.alphaBleedDerivations = { version: 1, entries };
}
async function hashBytes(bytes: Uint8Array) { const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function unique(values: string[]) { return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))]; }
function clampInteger(value: number, min: number, max: number) { const numeric = Number(value); return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.round(numeric))) : min; }
