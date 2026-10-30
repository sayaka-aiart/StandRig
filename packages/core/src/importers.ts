import { readPsd } from "ag-psd";
import { DEFAULT_PARAMETERS } from "./parameters.js";
import { expandTransparentRgb } from "./alphaBleed.js";
import { psdBlendMode } from './compositing.js';
import {
  DEFAULT_TRANSFORM,
  RIG_SCHEMA_VERSION,
  type AssetDefinition,
  type ImportLayerBounds,
  type ImportLayerReport,
  type RigDocument,
  type RigImportReport,
  type RigPart
} from "./types.js";

interface PsdLikeLayer {
  name?: string;
  hidden?: boolean;
  opacity?: number;
  blendMode?: string;
  clipping?: boolean;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  canvas?: HTMLCanvasElement;
  children?: PsdLikeLayer[];
  mask?: {canvas?: HTMLCanvasElement; left?: number; top?: number; disabled?: boolean; defaultColor?: number};
}

interface PsdLikeDocument extends PsdLikeLayer {
  width: number;
  height: number;
  children?: PsdLikeLayer[];
}

interface PixelAnalysis {
  sampledPixels: number;
  nonTransparentSamples: number;
  transparentRatio: number;
  warnings: string[];
}

export interface PsdImportOptions {
  /** Opt-in RGB dilation under transparent pixels. Alpha is never changed. */
  alphaBleedRadius?: number;
  alphaBleedThreshold?: number;
}

export async function createRigFromPsdFile(file: File, options: PsdImportOptions = {}): Promise<RigDocument> {
  if (!/\.psd$/i.test(file.name)) throw new Error("素材の読み込みはPSDのみ対応しています。");
  const buffer = await file.arrayBuffer();
  const header = new DataView(buffer);
  if (buffer.byteLength < 26 || header.getUint32(0) !== 0x38425053 || header.getUint16(4) !== 1) throw new Error("有効なPSDファイルを選択してください。PSBは未対応です。");
  let psd: PsdLikeDocument;
  try {
    psd = readPsd(buffer, {
      skipCompositeImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: true,
      logMissingFeatures: true
    }) as PsdLikeDocument;
  } catch (error) {
    throw new Error(`ag-psd failed to read "${file.name}" (${formatBytes(file.size)}): ${formatError(error)}`);
  }
  const importedAt = new Date().toISOString();
  const assets: AssetDefinition[] = [];
  const report: RigImportReport = {
    kind: "psd",
    fileName: file.name,
    importedAt,
    document: {
      width: psd.width,
      height: psd.height
    },
    totals: emptyImportTotals(),
    warnings: [],
    layers: []
  };
  const parts: RigPart[] = [
    {
      id: "root",
      name: "Root",
      kind: "group",
      parentId: null,
      visible: true,
      drawOrder: -10000,
      transform: { ...DEFAULT_TRANSFORM, x: 0, y: 0, pivotX: 0, pivotY: 0 }
    }
  ];
  let order = 0;
  const importedMaskIds=new Set<string>();
  const addRasterMask = (layer:PsdLikeLayer,owner:RigPart,layerPath:string) => {
    const mask=layer.mask;
    if(!mask||mask.disabled)return;
    if(!mask.canvas){report.warnings.push(`${layerPath}: raster-mask-pixels-unavailable`);return;}
    if(mask.defaultColor && mask.defaultColor!==0){report.warnings.push(`${layerPath}: unsupported-white-outside-raster-mask`);return;}
    const canvas=mask.canvas,context=canvas.getContext('2d',{willReadFrequently:true});
    if(!context)return;
    const pixels=context.getImageData(0,0,canvas.width,canvas.height);
    for(let i=0;i<pixels.data.length;i+=4){const alpha=pixels.data[i]*pixels.data[i+3]/255;pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=255;pixels.data[i+3]=alpha;}
    context.putImageData(pixels,0,0);
    const id=uniqueId(`psd-mask-${owner.id}`,parts.map(p=>p.id)),assetId=`${id}-asset`;
    importedMaskIds.add(id);
    assets.push({id:assetId,name:`${layer.name} mask`,type:'image',src:canvas.toDataURL('image/png'),width:canvas.width,height:canvas.height});
    owner.rasterMaskPartId=id;
    parts.push({id,name:`${layer.name} [raster mask]`,kind:'image',assetId,parentId:owner.parentId,visible:false,drawOrder:owner.drawOrder-.01,transform:{...DEFAULT_TRANSFORM,x:mask.left??0,y:mask.top??0,pivotX:0,pivotY:0},tags:['psd-raster-mask']});
    let count=0;for(let i=3;i<pixels.data.length;i+=4)if(pixels.data[i]>0)count++;
    report.layers.push({path:`${layerPath}/[raster mask]`,name:`${layer.name} [raster mask]`,kind:'image',hidden:true,opacity:1,parentId:owner.parentId??'root',partId:id,assetId,hasCanvas:true,hasPixels:count>0,sampledPixels:canvas.width*canvas.height,nonTransparentSamples:count,transparentRatio:1-count/(canvas.width*canvas.height),bounds:{left:mask.left??0,top:mask.top??0,right:(mask.left??0)+canvas.width,bottom:(mask.top??0)+canvas.height,width:canvas.width,height:canvas.height},warnings:[]});
  };

  const visit = (layer: PsdLikeLayer, parentId: string, path: string[]) => {
    const layerName = layer.name || `Layer ${order + 1}`;
    const safePath = [...path, layerName];
    const layerPath = safePath.join("/");
    const idBase = slugify(safePath.join("-"));
    const opacity = normalizeLayerOpacity(layer.opacity);
    const rawBlendMode = String(layer.blendMode ?? "").trim().toLowerCase();
    const blendMode = psdBlendMode(rawBlendMode);
    const bounds = getLayerBounds(layer);

    if (layer.children?.length) {
      const groupId = uniqueId(idBase || "group", parts.map((part) => part.id));
      parts.push({
        id: groupId,
        name: layerName,
        kind: "group",
        parentId,
        visible: !layer.hidden,
        compositing: rawBlendMode === 'pass through' ? 'pass-through' : 'isolate',
        ...(blendMode ? {blendMode} : {}),
        drawOrder: order,
        transform: { ...DEFAULT_TRANSFORM, x: 0, y: 0, pivotX: 0, pivotY: 0, opacity }
      });
      report.layers.push({
        path: layerPath,
        name: layerName,
        kind: "group",
        hidden: !!layer.hidden,
        rawOpacity: layer.opacity,
        opacity,
        blendMode: layer.blendMode,
        parentId,
        partId: groupId,
        hasCanvas: false,
        hasPixels: false,
        sampledPixels: 0,
        nonTransparentSamples: 0,
        transparentRatio: 1,
        bounds,
        warnings: buildLayerWarnings(layer, opacity, bounds, undefined, layer.hidden ? ["hidden-layer"] : [])
      });
      addRasterMask(layer,parts.find(p=>p.id===groupId)!,layerPath);
      let clippingBase: string | undefined;
      for (const child of layer.children) {
        const firstIndex = parts.length;
        visit(child, groupId, safePath);
        const imported = parts[firstIndex];
        if (!imported) continue;
        if (child.clipping && clippingBase) imported.clippingBaseId = clippingBase;
        else if(child.clipping)report.warnings.push(`${[...safePath,child.name].join('/')}: clipping-base-missing`);
        else if (!child.clipping) clippingBase = imported.id;
      }
      return;
    }

    if (!layer.canvas) {
      report.layers.push({
        path: layerPath,
        name: layerName,
        kind: "skipped",
        hidden: !!layer.hidden,
        rawOpacity: layer.opacity,
        opacity,
        blendMode: layer.blendMode,
        parentId,
        hasCanvas: false,
        hasPixels: false,
        sampledPixels: 0,
        nonTransparentSamples: 0,
        transparentRatio: 1,
        bounds,
        warnings: buildLayerWarnings(layer, opacity, bounds, undefined, ["no-bitmap-data"])
      });
      return;
    }

    const analysis = analyzeCanvasPixels(layer.canvas);
    const assetId = uniqueId(`${idBase}-asset`, assets.map((asset) => asset.id));
    const partId = uniqueId(idBase || `part-${order}`, parts.map((part) => part.id));
    const width = layer.canvas.width || Math.max(1, bounds.width);
    const height = layer.canvas.height || Math.max(1, bounds.height);
    assets.push({
      id: assetId,
      name: layerName,
      type: "image",
      src: canvasPngDataUrl(layer.canvas, options),
      width,
      height
    });
    parts.push({
      id: partId,
      name: layerName,
      kind: "image",
      assetId,
      parentId,
      visible: !layer.hidden,
      drawOrder: order,
      ...(blendMode ? { blendMode } : {}),
      transform: {
        ...DEFAULT_TRANSFORM,
        x: layer.left ?? 0,
        y: layer.top ?? 0,
        pivotX: 0,
        pivotY: 0,
        opacity
      }
    });
    report.layers.push({
      path: layerPath,
      name: layerName,
      kind: "image",
      hidden: !!layer.hidden,
      rawOpacity: layer.opacity,
      opacity,
      blendMode: layer.blendMode,
      parentId,
      partId,
      assetId,
      hasCanvas: true,
      hasPixels: analysis.nonTransparentSamples > 0,
      sampledPixels: analysis.sampledPixels,
      nonTransparentSamples: analysis.nonTransparentSamples,
      transparentRatio: analysis.transparentRatio,
      bounds: {
        ...bounds,
        width,
        height,
        right: (layer.left ?? 0) + width,
        bottom: (layer.top ?? 0) + height
      },
      warnings: buildLayerWarnings(layer, opacity, bounds, analysis, analysis.warnings, true)
    });
    addRasterMask(layer,parts.find(p=>p.id===partId)!,layerPath);
    order += 10;
  };

  let clippingBase: string | undefined;
  for (const child of psd.children ?? []) {
    const firstIndex = parts.length;
    visit(child, "root", []);
    const imported = parts[firstIndex];
    if (!imported) continue;
    if (child.clipping && clippingBase) imported.clippingBaseId = clippingBase;
    else if(child.clipping)report.warnings.push(`${child.name}: clipping-base-missing`);
    else if (!child.clipping) clippingBase = imported.id;
  }

  const drawableLayers = report.layers.filter(layer => layer.kind === "image" && layer.hasPixels && !importedMaskIds.has(layer.partId??''));
  if (drawableLayers.length < 2) {
    throw new Error("パーツ分け済みPSDのみ対応しています。描画内容のある独立した画像レイヤーを2つ以上用意してください。統合画像・単一レイヤーPSDは読み込めません。");
  }

  finalizeImportReport(report);

  return {
    schemaVersion: RIG_SCHEMA_VERSION,
    name: file.name.replace(/\.[^.]+$/, ""),
    metadata: {
      source: "psd-import",
      importedAt,
      importReport: report,
      ...(Number(options.alphaBleedRadius) > 0 ? { alphaBleedImport: { radius: Math.round(Number(options.alphaBleedRadius)), alphaThreshold: Math.round(Number(options.alphaBleedThreshold ?? 0)) } } : {})
    },
    stage: {
      width: psd.width,
      height: psd.height,
      background: "transparent"
    },
    assets,
    parameters: structuredClone(DEFAULT_PARAMETERS),
    parts,
    physics: {
      enabled: true,
      chains: []
    }
  };
}

function canvasPngDataUrl(canvas: HTMLCanvasElement, options: PsdImportOptions): string {
  const radius = Number(options.alphaBleedRadius ?? 0);
  if (!Number.isFinite(radius) || radius <= 0) return canvas.toDataURL("image/png");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return canvas.toDataURL("image/png");
  try {
    const source = context.getImageData(0, 0, canvas.width, canvas.height);
    const processed = expandTransparentRgb({ width: source.width, height: source.height, data: source.data }, { radius, alphaThreshold: options.alphaBleedThreshold });
    const output = document.createElement("canvas");
    output.width = canvas.width;
    output.height = canvas.height;
    const outputContext = output.getContext("2d");
    if (!outputContext) return canvas.toDataURL("image/png");
    const imageData = outputContext.createImageData(processed.image.width, processed.image.height);
    imageData.data.set(processed.image.data);
    outputContext.putImageData(imageData, 0, 0);
    return output.toDataURL("image/png");
  } catch (_error) {
    return canvas.toDataURL("image/png");
  }
}
function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch (_jsonError) {
    return String(error);
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown size";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

function emptyImportTotals(): RigImportReport["totals"] {
  return {
    groups: 0,
    imageLayers: 0,
    skippedLayers: 0,
    hiddenLayers: 0,
    transparentLayers: 0,
    lowOpacityLayers: 0,
    warnings: 0
  };
}

function finalizeImportReport(report: RigImportReport) {
  report.totals = {
    groups: report.layers.filter((layer) => layer.kind === "group").length,
    imageLayers: report.layers.filter((layer) => layer.kind === "image").length,
    skippedLayers: report.layers.filter((layer) => layer.kind === "skipped").length,
    hiddenLayers: report.layers.filter((layer) => layer.hidden).length,
    transparentLayers: report.layers.filter((layer) => layer.warnings.includes("fully-transparent-bitmap")).length,
    lowOpacityLayers: report.layers.filter((layer) => layer.warnings.includes("low-opacity")).length,
    warnings: report.layers.reduce((total, layer) => total + layer.warnings.length, 0)
  };
  report.warnings = [...report.warnings,...report.layers.flatMap((layer) => layer.warnings.map((warning) => `${layer.path}: ${warning}`))];
  report.totals.warnings=report.warnings.length;
}

function getLayerBounds(layer: PsdLikeLayer): ImportLayerBounds {
  const left = finiteNumber(layer.left, 0);
  const top = finiteNumber(layer.top, 0);
  const canvasWidth = layer.canvas?.width ?? 0;
  const canvasHeight = layer.canvas?.height ?? 0;
  const right = finiteNumber(layer.right, left + canvasWidth);
  const bottom = finiteNumber(layer.bottom, top + canvasHeight);
  const width = canvasWidth || Math.max(0, right - left);
  const height = canvasHeight || Math.max(0, bottom - top);

  return {
    left,
    top,
    right: right || left + width,
    bottom: bottom || top + height,
    width,
    height
  };
}

function analyzeCanvasPixels(canvas: HTMLCanvasElement): PixelAnalysis {
  const width = canvas.width || 0;
  const height = canvas.height || 0;
  const warnings: string[] = [];

  if (!width || !height) {
    return {
      sampledPixels: 0,
      nonTransparentSamples: 0,
      transparentRatio: 1,
      warnings: ["zero-size-bitmap"]
    };
  }

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return {
      sampledPixels: 0,
      nonTransparentSamples: 0,
      transparentRatio: 1,
      warnings: ["canvas-read-failed"]
    };
  }

  const maxSamplesPerAxis = 72;
  const stepX = Math.max(1, Math.ceil(width / maxSamplesPerAxis));
  const stepY = Math.max(1, Math.ceil(height / maxSamplesPerAxis));
  let sampledPixels = 0;
  let nonTransparentSamples = 0;

  try {
    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        sampledPixels += 1;
        const alpha = context.getImageData(x, y, 1, 1).data[3];
        if (alpha > 0) {
          nonTransparentSamples += 1;
        }
      }
    }
  } catch (_error) {
    warnings.push("canvas-read-failed");
  }

  const transparentRatio = sampledPixels ? 1 - nonTransparentSamples / sampledPixels : 1;
  if (sampledPixels > 0 && nonTransparentSamples === 0) {
    warnings.push("fully-transparent-bitmap");
  }

  return {
    sampledPixels,
    nonTransparentSamples,
    transparentRatio,
    warnings
  };
}

function buildLayerWarnings(
  layer: PsdLikeLayer,
  opacity: number,
  bounds: ImportLayerBounds,
  analysis: PixelAnalysis | undefined,
  baseWarnings: string[],
  allowMultiply = false
): string[] {
  const warnings = [...baseWarnings];
  if (layer.hidden) {
    warnings.push("hidden-layer");
  }
  if (opacity <= 0.01) {
    warnings.push("low-opacity");
  }
  if (!layer.children?.length && (bounds.width <= 0 || bounds.height <= 0)) {
    warnings.push("zero-size-bounds");
  }
  if (layer.blendMode && String(layer.blendMode).trim().toLowerCase() !== 'pass through' && psdBlendMode(layer.blendMode) === undefined) {
    warnings.push("unsupported-blend-mode");
  }
  if (analysis && analysis.sampledPixels > 0 && analysis.nonTransparentSamples === 0 && !warnings.includes("fully-transparent-bitmap")) {
    warnings.push("fully-transparent-bitmap");
  }
  return [...new Set(warnings)];
}

function normalizeLayerOpacity(opacity: number | undefined): number {
  if (typeof opacity !== "number" || !Number.isFinite(opacity)) {
    return 1;
  }
  const normalized = opacity > 1 ? opacity / 255 : opacity;
  return Math.min(1, Math.max(0, normalized));
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueId(base: string, existing: string[]): string {
  const fallback = base || "item";
  let candidate = fallback;
  let suffix = 2;
  const seen = new Set(existing);
  while (seen.has(candidate)) {
    candidate = `${fallback}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}
