import { sampleParameterGrid } from "./parameterGrid.js";
import type { ParameterValues, RigArtMeshMultiBinding } from "./types.js";
import { evaluationCache } from "./evaluationCache.js";

type Offset = RigArtMeshMultiBinding["keyforms"][number]["offsets"][number];
function normalizedOffsets(raw: Offset[]): Offset[] {
  const seen = new Set<string>();
  let unique = true;
  for (const offset of raw) {
    if (!offset || typeof offset.vertexId !== "string" || !Number.isFinite(offset.x) || !Number.isFinite(offset.y) || seen.has(offset.vertexId)) { unique = false; break; }
    seen.add(offset.vertexId);
  }
  // Valid unique arrays are reused directly, not copied into a map per corner/frame.
  if (unique) return raw;
  const last = new Map<string, Offset>();
  for (const offset of raw) if (offset && typeof offset.vertexId === "string" && Number.isFinite(offset.x) && Number.isFinite(offset.y)) last.set(offset.vertexId, offset);
  return [...last.values()];
}

export function sampleMultiArtMeshBinding(binding: RigArtMeshMultiBinding, values: ParameterValues): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  for (const { key, weight } of sampleParameterGrid(binding.parameters, binding.keyforms, values, binding.interpolation, binding.curve)) {
    const build = () => normalizedOffsets(key.offsets ?? []);
    const offsets = evaluationCache()?.get("mesh-offsets", key, build) ?? build();
    for (const offset of offsets) {
      const id = offset.vertexId;
      const previous = result.get(id) ?? { x: 0, y: 0 };
      previous.x += offset.x * weight; previous.y += offset.y * weight; result.set(id, previous);
    }
  }
  return result;
}
