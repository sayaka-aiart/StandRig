import type { AssetDefinition } from "./types.js";
import type { RgbaImage } from "./png.js";

export interface ArtMeshAlphaSampler {
  assetId: string;
  width: number;
  height: number;
  alphaBounds: { left: number; top: number; width: number; height: number };
  alphaAt: (x: number, y: number) => number;
}

/**
 * Creates a deterministic nearest-pixel alpha sampler for ArtMesh topology
 * generation. It exposes no color data, keeping embedded assets out of API
 * responses and transaction logs.
 */
export function createArtMeshAlphaSampler(asset: AssetDefinition, image: RgbaImage, threshold = 1): ArtMeshAlphaSampler {
  const alphaThreshold = Math.max(1, Math.min(255, Math.round(threshold)));
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] < alphaThreshold) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  const alphaBounds = right < 0
    ? { left: 0, top: 0, width: image.width, height: image.height }
    : { left, top, width: right - left + 1, height: bottom - top + 1 };
  return {
    assetId: asset.id,
    width: image.width,
    height: image.height,
    alphaBounds,
    alphaAt: (x, y) => {
      const px = Math.max(0, Math.min(image.width - 1, Math.round(x)));
      const py = Math.max(0, Math.min(image.height - 1, Math.round(y)));
      return image.data[(py * image.width + px) * 4 + 3] ?? 0;
    }
  };
}