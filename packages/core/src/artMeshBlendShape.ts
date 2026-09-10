import { applyParameterInterpolation, normalizeParameterInterpolation } from "./bindings.js";
import type { ParameterInterpolation, RigArtMeshBlendShape } from "./types.js";

/** Sample a neutral-to-delta ArtMesh shape without changing the neutral mesh. */
export function sampleArtMeshBlendShape(shape: RigArtMeshBlendShape, input: number): Map<string, { x: number; y: number }> {
  if (!Number.isFinite(input) || !Number.isFinite(shape.neutralInput) || !Number.isFinite(shape.targetInput) || shape.neutralInput === shape.targetInput) return new Map();
  const weight = sampleArtMeshBlendShapeWeight(shape, input);
  const offsets = new Map<string, { x: number; y: number }>();
  for (const offset of shape.offsets ?? []) {
    if (offset && typeof offset.vertexId === "string" && Number.isFinite(offset.x) && Number.isFinite(offset.y)) {
      offsets.set(offset.vertexId, { x: offset.x * weight, y: offset.y * weight });
    }
  }
  return offsets;
}

export function sampleArtMeshBlendShapeWeight(shape: Pick<RigArtMeshBlendShape, "neutralInput" | "targetInput" | "interpolation" | "curve">, input: number): number {
  if (!Number.isFinite(input) || !Number.isFinite(shape.neutralInput) || !Number.isFinite(shape.targetInput) || shape.neutralInput === shape.targetInput) return 0;
  const amount = Math.min(1, Math.max(0, (input - shape.neutralInput) / (shape.targetInput - shape.neutralInput)));
  return applyParameterInterpolation(normalizeParameterInterpolation(shape.interpolation), amount, shape.curve);
}
