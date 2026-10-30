import { sampleParameterGrid } from "./parameterGrid.js";
import type { ParameterValues, RigArtMeshMultiBinding } from "./types.js";

export function sampleMultiArtMeshBinding(binding: RigArtMeshMultiBinding, values: ParameterValues): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  for (const { key, weight } of sampleParameterGrid(binding.parameters, binding.keyforms, values, binding.interpolation, binding.curve)) {
    // Rebuild offsets so in-place editor changes cannot leave stale cache data.
    const offsets = new Map<string, { x: number; y: number }>();
    for (const offset of key.offsets ?? []) if (offset && typeof offset.vertexId === "string" && Number.isFinite(offset.x) && Number.isFinite(offset.y)) offsets.set(offset.vertexId, offset);
    for (const [id, offset] of offsets) {
      const previous = result.get(id) ?? { x: 0, y: 0 };
      previous.x += offset.x * weight; previous.y += offset.y * weight; result.set(id, previous);
    }
  }
  return result;
}
