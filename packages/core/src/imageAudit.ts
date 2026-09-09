import type { RgbaImage } from "./png.js";

export interface AlphaBoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface EdgeContact {
  left: boolean;
  top: boolean;
  right: boolean;
  bottom: boolean;
  any: boolean;
  contactedEdges: number;
  pixelCount: number;
}

export interface ImageAuditOptions {
  nonTransparentAlphaThreshold?: number;
  opaqueAlphaThreshold?: number;
  diffChannelThreshold?: number;
  alphaChangeThreshold?: number;
}

export interface RgbaImageAudit {
  width: number;
  height: number;
  totalPixelCount: number;
  alphaBBox: AlphaBoundingBox | null;
  nonTransparentPixelCount: number;
  opaquePixelCount: number;
  transparentPixelCount: number;
  edgeContact: EdgeContact;
  simpleScore: number;
}

export interface RgbaImageDiffAudit {
  width: number;
  height: number;
  totalPixelCount: number;
  before: RgbaImageAudit;
  after: RgbaImageAudit;
  diffPixelCount: number;
  diffPixelRatio: number;
  alphaGainPixelCount: number;
  alphaLossPixelCount: number;
  alphaGainTotal: number;
  alphaLossTotal: number;
  simpleScore: number;
}

interface ResolvedImageAuditOptions {
  nonTransparentAlphaThreshold: number;
  opaqueAlphaThreshold: number;
  diffChannelThreshold: number;
  alphaChangeThreshold: number;
}

export function auditRgbaImage(image: RgbaImage, options: ImageAuditOptions = {}): RgbaImageAudit {
  validateImage(image, "image");
  const resolved = resolveOptions(options);
  const totalPixelCount = image.width * image.height;
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  let nonTransparentPixelCount = 0;
  let opaquePixelCount = 0;
  let edgeContactPixelCount = 0;
  let left = false;
  let top = false;
  let right = false;
  let bottom = false;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.data[(y * image.width + x) * 4 + 3];
      if (alpha >= resolved.opaqueAlphaThreshold) {
        opaquePixelCount += 1;
      }
      if (alpha <= resolved.nonTransparentAlphaThreshold) {
        continue;
      }

      nonTransparentPixelCount += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const touchesLeft = x === 0;
      const touchesTop = y === 0;
      const touchesRight = x === image.width - 1;
      const touchesBottom = y === image.height - 1;
      if (touchesLeft || touchesTop || touchesRight || touchesBottom) {
        edgeContactPixelCount += 1;
        left = left || touchesLeft;
        top = top || touchesTop;
        right = right || touchesRight;
        bottom = bottom || touchesBottom;
      }
    }
  }

  const alphaBBox = nonTransparentPixelCount
    ? {
        left: minX,
        top: minY,
        right: maxX + 1,
        bottom: maxY + 1,
        width: maxX - minX + 1,
        height: maxY - minY + 1
      }
    : null;
  const contactedEdges = countTrue(left, top, right, bottom);
  const edgeContact = {
    left,
    top,
    right,
    bottom,
    any: contactedEdges > 0,
    contactedEdges,
    pixelCount: edgeContactPixelCount
  };

  return {
    width: image.width,
    height: image.height,
    totalPixelCount,
    alphaBBox,
    nonTransparentPixelCount,
    opaquePixelCount,
    transparentPixelCount: totalPixelCount - nonTransparentPixelCount,
    edgeContact,
    simpleScore: scoreSingleImage(nonTransparentPixelCount, totalPixelCount, edgeContact)
  };
}

export function diffRgbaImages(before: RgbaImage, after: RgbaImage, options: ImageAuditOptions = {}): RgbaImageDiffAudit {
  validateImage(before, "before");
  validateImage(after, "after");
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(`Cannot diff images with different dimensions: ${before.width}x${before.height} vs ${after.width}x${after.height}.`);
  }

  const resolved = resolveOptions(options);
  const totalPixelCount = before.width * before.height;
  let diffPixelCount = 0;
  let alphaGainPixelCount = 0;
  let alphaLossPixelCount = 0;
  let alphaGainTotal = 0;
  let alphaLossTotal = 0;

  for (let pixel = 0; pixel < totalPixelCount; pixel += 1) {
    const offset = pixel * 4;
    if (
      Math.abs(before.data[offset] - after.data[offset]) > resolved.diffChannelThreshold ||
      Math.abs(before.data[offset + 1] - after.data[offset + 1]) > resolved.diffChannelThreshold ||
      Math.abs(before.data[offset + 2] - after.data[offset + 2]) > resolved.diffChannelThreshold ||
      Math.abs(before.data[offset + 3] - after.data[offset + 3]) > resolved.diffChannelThreshold
    ) {
      diffPixelCount += 1;
    }

    const alphaDelta = after.data[offset + 3] - before.data[offset + 3];
    if (alphaDelta > resolved.alphaChangeThreshold) {
      alphaGainPixelCount += 1;
      alphaGainTotal += alphaDelta;
    } else if (alphaDelta < -resolved.alphaChangeThreshold) {
      alphaLossPixelCount += 1;
      alphaLossTotal += -alphaDelta;
    }
  }

  const beforeAudit = auditRgbaImage(before, resolved);
  const afterAudit = auditRgbaImage(after, resolved);
  const diffPixelRatio = totalPixelCount ? diffPixelCount / totalPixelCount : 0;
  const alphaChangeRatio = totalPixelCount ? (alphaGainPixelCount + alphaLossPixelCount) / totalPixelCount : 0;

  return {
    width: before.width,
    height: before.height,
    totalPixelCount,
    before: beforeAudit,
    after: afterAudit,
    diffPixelCount,
    diffPixelRatio,
    alphaGainPixelCount,
    alphaLossPixelCount,
    alphaGainTotal,
    alphaLossTotal,
    simpleScore: scoreDiffImage(diffPixelRatio, alphaChangeRatio, afterAudit)
  };
}

function validateImage(image: RgbaImage, name: string) {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) {
    throw new Error(`Invalid ${name}: width and height must be positive integers.`);
  }
  const expectedLength = image.width * image.height * 4;
  if (image.data.length !== expectedLength) {
    throw new Error(`Invalid ${name}: expected ${expectedLength} RGBA bytes, received ${image.data.length}.`);
  }
}

function resolveOptions(options: ImageAuditOptions): ResolvedImageAuditOptions {
  return {
    nonTransparentAlphaThreshold: clampByte(options.nonTransparentAlphaThreshold ?? 0),
    opaqueAlphaThreshold: clampByte(options.opaqueAlphaThreshold ?? 255),
    diffChannelThreshold: clampByte(options.diffChannelThreshold ?? 0),
    alphaChangeThreshold: clampByte(options.alphaChangeThreshold ?? 0)
  };
}

function scoreSingleImage(nonTransparentPixelCount: number, totalPixelCount: number, edgeContact: EdgeContact): number {
  if (nonTransparentPixelCount <= 0 || totalPixelCount <= 0) {
    return 0;
  }

  const fillRatio = nonTransparentPixelCount / totalPixelCount;
  const tinyContentPenalty = fillRatio < 0.001 ? 12 : 0;
  const edgePenalty = edgeContact.contactedEdges * 12 + (edgeContact.any ? 8 : 0);
  return clampScore(100 - tinyContentPenalty - edgePenalty);
}

function scoreDiffImage(diffPixelRatio: number, alphaChangeRatio: number, after: RgbaImageAudit): number {
  if (after.nonTransparentPixelCount <= 0) {
    return 0;
  }

  const diffPenalty = diffPixelRatio * 100;
  const alphaPenalty = alphaChangeRatio * 30;
  const edgePenalty = after.edgeContact.contactedEdges * 6;
  return clampScore(100 - diffPenalty - alphaPenalty - edgePenalty);
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function countTrue(...values: boolean[]): number {
  return values.reduce((total, value) => total + (value ? 1 : 0), 0);
}
