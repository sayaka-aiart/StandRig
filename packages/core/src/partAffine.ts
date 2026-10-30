import type { ParameterValues, RigAffineMatrix, RigPart, RigPartAffineBinding } from "./types.js";

import { parameterGridIssues, sampleParameterGrid } from "./parameterGrid.js";

const FIELDS = ["a", "b", "c", "d", "e", "f"] as const;
const identity = (): RigAffineMatrix => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export function samplePartAffine(binding: RigPartAffineBinding, values: ParameterValues): RigAffineMatrix {
  const corners = sampleParameterGrid(binding.parameters, binding.keyforms, values);
  if (!corners.length) return identity();
  const result = identity();
  for (const field of FIELDS) result[field] = corners.reduce((value, corner) => value + corner.key.matrix[field] * corner.weight, 0);
  return result;
}

export function resolvePartAffine(part: RigPart, values: ParameterValues): RigAffineMatrix {
  let result = identity();
  for (const binding of part.affineBindings ?? []) {
    const next = samplePartAffine(binding, values), left = result;
    // The first authored stage acts first on the local point.
    result = { a: next.a * left.a + next.c * left.b, b: next.b * left.a + next.d * left.b,
      c: next.a * left.c + next.c * left.d, d: next.b * left.c + next.d * left.d,
      e: next.a * left.e + next.c * left.f + next.e, f: next.b * left.e + next.d * left.f + next.f };
  }
  return result;
}

export function partAffineIssues(part: RigPart, parameters: ReadonlySet<string>): string[] {
  if (part.affineBindings === undefined) return [];
  if (!Array.isArray(part.affineBindings)) return ["affineBindings must be an array"];
  const issues: string[] = [];
  for (const binding of part.affineBindings) {
    issues.push(...parameterGridIssues(binding?.parameters, binding?.keyforms, parameters));
    if (!Array.isArray(binding?.keyforms)) continue;
    for (const key of binding.keyforms) {
      if (!key?.matrix || FIELDS.some(f => !Number.isFinite(key.matrix[f])) || key.matrix.a * key.matrix.d - key.matrix.b * key.matrix.c <= 1e-8)
        issues.push("Affine keyforms must be finite, nonsingular and orientation preserving");
    }
  }
  return issues;
}

