import { invertMatrix, transformMatrixPoint, type Matrix2D } from "./evaluator.js";
import { hasSharedWarpFieldEffect, warpSharedFieldPoint } from "./sharedWarp.js";
import type { RigSharedWarpField } from "./types.js";

export interface Point2D {
  x: number;
  y: number;
}

/**
 * Converts a part-local point through its evaluated matrix, applies every
 * enabled shared field in stable parent-to-child order in stage coordinates,
 * then returns the renderer/output coordinate.
 */
export function projectSharedWarpPoint(
  point: Point2D,
  partMatrix: Matrix2D,
  baseMatrix: Matrix2D,
  fields: readonly RigSharedWarpField[] | undefined
): Point2D {
  const rendered = transformMatrixPoint(partMatrix, point.x, point.y);
  if (!fields?.some(hasSharedWarpFieldEffect)) {
    return rendered;
  }

  const inverseBase = invertMatrix(baseMatrix);
  let stagePoint = transformMatrixPoint(inverseBase, rendered.x, rendered.y);
  for (const field of fields) {
    if (hasSharedWarpFieldEffect(field)) {
      stagePoint = warpSharedFieldPoint(field, stagePoint.x, stagePoint.y);
    }
  }
  return transformMatrixPoint(baseMatrix, stagePoint.x, stagePoint.y);
}
/**
 * Reverses the shared-warp projection for picking and drag interaction.
 * The field is smooth but not analytically invertible, so use a bounded
 * residual solve in reverse field order.
 */
export function unprojectSharedWarpPoint(
  renderedPoint: Point2D,
  partMatrix: Matrix2D,
  baseMatrix: Matrix2D,
  fields: readonly RigSharedWarpField[] | undefined
): Point2D {
  if (!fields?.some(hasSharedWarpFieldEffect)) {
    return transformMatrixPoint(invertMatrix(partMatrix), renderedPoint.x, renderedPoint.y);
  }

  const targetStage = transformMatrixPoint(invertMatrix(baseMatrix), renderedPoint.x, renderedPoint.y);
  let stagePoint = { ...targetStage };
  for (const field of [...fields].reverse()) {
    if (!hasSharedWarpFieldEffect(field)) continue;
    const targetForField = { ...stagePoint };
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const warped = warpSharedFieldPoint(field, stagePoint.x, stagePoint.y);
      stagePoint = { x: stagePoint.x + targetForField.x - warped.x, y: stagePoint.y + targetForField.y - warped.y };
    }
  }
  const unwarpedRendered = transformMatrixPoint(baseMatrix, stagePoint.x, stagePoint.y);
  return transformMatrixPoint(invertMatrix(partMatrix), unwarpedRendered.x, unwarpedRendered.y);
}

