import { cloneRig, type RigDocument } from "./types.js";
export const ASSET_MANIFEST_FORMAT = "standrig-assets";
export interface RigAssetManifestEntry { assetId: string; path: string; sha256: string; mediaType: string; bytes: number }
export interface RigAssetManifest { format: typeof ASSET_MANIFEST_FORMAT; version: 1; entries: RigAssetManifestEntry[] }
export interface ExternalizedRigAssets { rig: RigDocument; manifest: RigAssetManifest; files: Map<string, Uint8Array> }

export async function externalizeRigAssets(source: RigDocument, basePath = "/assets"): Promise<ExternalizedRigAssets> {
  const rig=cloneRig(source); const entries:RigAssetManifestEntry[]=[]; const files=new Map<string,Uint8Array>();
  for(const asset of rig.assets){ const decoded=decodeDataUrl(asset.src); if(!decoded) continue; const sha256=await hashBytes(decoded.bytes); const ext=extensionForMediaType(decoded.mediaType); const path=`${basePath.replace(/\/$/,"")}/${sha256}.${ext}`; files.set(path,decoded.bytes); asset.src=path; asset.sha256=sha256; entries.push({assetId:asset.id,path,sha256,mediaType:decoded.mediaType,bytes:decoded.bytes.byteLength}); }
  return {rig,manifest:{format:ASSET_MANIFEST_FORMAT,version:1,entries},files};
}
export async function hydrateRigAssets(source:RigDocument,manifest:RigAssetManifest,read:(path:string)=>Promise<Uint8Array>):Promise<RigDocument>{
  const rig=cloneRig(source); const byId=new Map(manifest.entries.map(e=>[e.assetId,e]));
  for(const asset of rig.assets){ if(asset.src.startsWith("data:"))continue; const entry=byId.get(asset.id); if(!entry||entry.path!==asset.src)throw new Error(`Missing manifest entry for asset ${asset.id}`); const bytes=await read(entry.path); const hash=await hashBytes(bytes); if(hash!==entry.sha256)throw new Error(`Asset hash mismatch for ${asset.id}`); asset.src=encodeDataUrl(entry.mediaType,bytes); asset.sha256=entry.sha256; }
  return rig;
}
export function diagnoseRigAssets(rig:RigDocument,manifest?:RigAssetManifest){
  const issues:string[]=[]; const ids=new Set(rig.assets.map(a=>a.id)); const manifestIds=new Set(manifest?.entries.map(e=>e.assetId)??[]);
  for(const part of rig.parts)if(part.assetId&&!ids.has(part.assetId))issues.push(`missing-asset:${part.id}:${part.assetId}`);
  for(const asset of rig.assets){ if(!asset.src?.trim())issues.push(`empty-src:${asset.id}`); else if(!asset.src.startsWith("data:")&&!manifestIds.has(asset.id))issues.push(`missing-manifest:${asset.id}`); }
  return {ok:issues.length===0,issues};
}
export function decodeDataUrl(src:string):{mediaType:string;bytes:Uint8Array}|undefined{ const match=/^data:([^;,]+);base64,(.+)$/i.exec(src); if(!match)return; const binary=atob(match[2]); const bytes=new Uint8Array(binary.length); for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i); return {mediaType:match[1].toLowerCase(),bytes}; }
export function encodeDataUrl(mediaType:string,bytes:Uint8Array){ let binary=""; const chunk=0x8000; for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk)); return `data:${mediaType};base64,${btoa(binary)}`; }
async function hashBytes(bytes:Uint8Array){ const digest=await crypto.subtle.digest("SHA-256",bytes as BufferSource); return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join(""); }
function extensionForMediaType(mediaType:string){ if(mediaType==="image/jpeg")return "jpg"; if(mediaType==="image/webp")return "webp"; if(mediaType==="image/gif")return "gif"; return "png"; }
export interface ExternalizeRigApiResult {
  ok: boolean;
  dryRun: boolean;
  summary: { assetEntries: number; uniqueFiles: number; originalBytes: number; rigBytes: number; savedBytes: number };
  manifest: RigAssetManifest;
  rig: RigDocument;
  diagnostics: { ok: boolean; issues: string[] };
  error?: string;
}
export async function requestRigAssetExternalization(rig: RigDocument, dryRun = true): Promise<ExternalizeRigApiResult> {
  const response = await fetch("/api/assets/externalize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rig, dryRun }) });
  const result = await response.json() as ExternalizeRigApiResult;
  if (!response.ok || !result.ok) throw new Error(result.error ?? `Asset externalization failed: ${response.status}`);
  return result;
}