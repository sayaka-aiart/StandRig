import type { RigClip, RigDocument, RigPart } from "./types.js";

export interface ResolvedPartClip {
  owner: RigPart;
  clip: RigClip;
  maskPartIds: string[];
  maskParts: RigPart[];
}

/**
 * Resolves the closest clip owner from a renderable part up through its part
 * parents. This lets related interior layers share one alpha-union mask without
 * applying it separately to every overlapping layer.
 */
export function createPartClipResolver(rig: RigDocument): (part: RigPart) => ResolvedPartClip | undefined {
  const partsById = new Map(rig.parts.map((entry) => [entry.id, entry]));
  const cache = new Map<string, ResolvedPartClip | undefined>();
  const resolve = (part: RigPart): ResolvedPartClip | undefined => {
    if (cache.has(part.id)) return cache.get(part.id);
    const visited = new Set<string>();
    let current: RigPart | undefined = part;
    let result: ResolvedPartClip | undefined;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (cache.has(current.id)) { result = cache.get(current.id); break; }
      if (current.clip) {
        const maskPartIds = clipMaskPartIds(current.clip);
        const maskParts = maskPartIds.map((id) => partsById.get(id));
        if (maskPartIds.length && maskParts.every((maskPart) => maskPart?.kind === "image" && maskPart.assetId)) result = { owner: current, clip: current.clip, maskPartIds, maskParts: maskParts as RigPart[] };
        break;
      }
      current = current.parentId ? partsById.get(current.parentId) : undefined;
    }
    for (const id of visited) cache.set(id, result);
    return result;
  };
  return resolve;
}

export function resolvePartClip(rig: RigDocument, part: RigPart): ResolvedPartClip | undefined {
  return createPartClipResolver(rig)(part);
}
export function sameResolvedPartClip(left: ResolvedPartClip | undefined, right: ResolvedPartClip | undefined): boolean {
  return Boolean(
    left && right && left.owner.id === right.owner.id && left.clip.mode === right.clip.mode && left.clip.maskOpacity === right.clip.maskOpacity && left.maskPartIds.length === right.maskPartIds.length && left.maskPartIds.every((id, index) => id === right.maskPartIds[index])
  );
}

export function clipMaskPartIds(clip: RigClip): string[] {
  const ids = Array.isArray(clip.maskPartIds) ? clip.maskPartIds : clip.maskPartId ? [clip.maskPartId] : [];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}