import { glueBlendStrength } from './extendedBlendShape.js';
import { readRigGlue } from "./glue.js";
import { projectSharedWarpPoint } from "./sharedWarpProjection.js";
import type { Matrix2D } from "./evaluator.js";
import { hasWarpEffect, warpPoint, type ResolvedWarpDeformer } from "./warp.js";
import type { RigDocument, RigGlue, RigSharedWarpField, Transform2D } from "./types.js";

/**
 * Vertex-level glue ("stitch").
 *
 * `soft-seam` glue generates warp pins that pull a part a fraction of the way toward its neighbour,
 * so a seam driven hard enough always opens again. A stitch instead binds named ArtMesh vertices of
 * two parts: after every deformer, warp, skinning and shared-warp step has run, each bound pair is
 * forced back to the offset it had at neutral, so the two meshes cannot drift apart no matter how
 * far the motion travels. A pair with a zero rest offset collapses onto one point, which is the
 * classic glue behaviour for vertices authored to coincide.
 *
 * The solver is deliberately renderer-agnostic. Canvas, the server renderer and WebGL all hand it
 * the same projected vertex positions and all apply the same returned screen-space corrections, so
 * the three paths cannot drift apart.
 */

const ZERO_OFFSET_EPSILON = 1e-6;
const DEFAULT_ITERATIONS = 16;
const DEFAULT_RELAXATION = 0.7;

export interface GlueVertexPoint {
  x: number;
  y: number;
}

/** Screen-space correction to add to a vertex after projection. */
export interface GlueVertexOffset {
  dx: number;
  dy: number;
}

export type GlueVertexOffsets = Map<string, Map<string, GlueVertexOffset>>;

export interface GlueStitchPair {
  strength: number;
  glueId: string;
  partAId: string;
  partBId: string;
  aVertexId: string;
  bVertexId: string;
  /** Share of the correction applied to the A side; 0 pins A, 1 pins B. */
  weight: number;
  /** Neutral offset from A to B that the stitch holds constant. Zero collapses the pair. */
  restDx: number;
  restDy: number;
}

export interface GlueStitchInput {
  values?: import("./types.js").ParameterValues;
  /** Projected screen position of a vertex, or undefined when the part or vertex is not renderable. */
  projectVertex: (partId: string, vertexId: string) => GlueVertexPoint | undefined;
  /**
   * Uniform scale between the stage units the rest offsets were recorded in and the screen units
   * `projectVertex` returns. Renderers derive it from their base matrix; leaving it out means the
   * caller already projects in stage units.
   */
  restScale?: number;
  /** Relaxation passes. More passes let a vertex shared by two seams satisfy both. */
  iterations?: number;
  /** Share of the remaining error applied per pass. Below 1 so shared vertices average instead of fighting. */
  relaxation?: number;
}

export interface GlueStitchResult {
  offsets: GlueVertexOffsets;
  /** Pairs that could be solved this frame. */
  resolvedPairs: number;
  /** Pairs skipped because a side was missing, hidden or non-finite. */
  skippedPairs: number;
  /** Largest drift away from the rest offset before solving, in screen units. */
  maxClosedDistance: number;
  /** Largest drift still left after the last pass. Non-zero means the seams over-constrain a vertex. */
  maxResidual: number;
  /** Passes actually run. */
  iterations: number;
}

export interface GlueVertexProjectionContext {
  pose: Transform2D;
  matrix: Matrix2D;
  baseMatrix: Matrix2D;
  sharedWarps?: readonly RigSharedWarpField[];
  warp?: ResolvedWarpDeformer;
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Project an ArtMesh vertex to screen space exactly the way the draw paths do: local offset from
 * the pivot, then the part warp, then the shared-warp/matrix projection. Renderers and the solver
 * must agree here or the stitch would be computed against positions nothing actually draws.
 */
export function projectArtMeshVertex(vertex: { x: number; y: number }, context: GlueVertexProjectionContext): GlueVertexPoint {
  const left = -context.pose.pivotX * context.sourceWidth;
  const top = -context.pose.pivotY * context.sourceHeight;
  const local = { x: left + vertex.x, y: top + vertex.y };
  const bounds = { left, top, width: context.sourceWidth, height: context.sourceHeight };
  const warped = context.warp && hasWarpEffect(context.warp) ? warpPoint(local.x, local.y, bounds, context.warp) : local;
  return projectSharedWarpPoint(warped, context.matrix, context.baseMatrix, context.sharedWarps);
}

export function isStitchGlue(glue: RigGlue): boolean {
  return glue.enabled && glue.status === "active" && glue.mode === "stitch" && Boolean(glue.vertexPairs?.length);
}

export function collectGlueStitchPairs(rig: RigDocument, values: import("./types.js").ParameterValues = {}): GlueStitchPair[] {
  const pairs: GlueStitchPair[] = [];
  const glues = readRigGlue(rig)
    .filter(isStitchGlue)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  for (const glue of glues) {
    for (const pair of glue.vertexPairs ?? []) {
      pairs.push({
        glueId: glue.id,
        strength: glueBlendStrength(glue,values),
        partAId: glue.partAId,
        partBId: glue.partBId,
        aVertexId: pair.a,
        bVertexId: pair.b,
        weight: clamp01(pair.weight ?? weightFromGlue(glue)),
        restDx: Number.isFinite(pair.restDx) ? (pair.restDx as number) : 0,
        restDy: Number.isFinite(pair.restDy) ? (pair.restDy as number) : 0
      });
    }
  }
  return pairs;
}

/** True when the document has any stitch work to do, so renderers can skip the solver entirely. */
export function hasGlueStitches(rig: RigDocument): boolean {
  return readRigGlue(rig).some(isStitchGlue);
}

/**
 * Resolve the screen-space correction for every stitched vertex.
 *
 * Gauss-Seidel relaxation. A single pass is enough when every vertex belongs to one seam; extra
 * passes let a vertex shared by two seams settle on a position that satisfies both, instead of
 * whichever seam happened to be solved last silently winning.
 */
export function resolveGlueStitchOffsets(rig: RigDocument, input: GlueStitchInput): GlueStitchResult {
  const pairs = collectGlueStitchPairs(rig,input.values).filter(p=>p.strength>0);
  const offsets: GlueVertexOffsets = new Map();
  let resolvedPairs = 0;
  let skippedPairs = 0;
  let maxClosedDistance = 0;
  if (!pairs.length) {
    return { offsets, resolvedPairs, skippedPairs, maxClosedDistance, maxResidual: 0, iterations: 0 };
  }

  const restScale = Number.isFinite(input.restScale) && (input.restScale as number) > 0 ? (input.restScale as number) : 1;
  const iterations = Math.max(1, Math.min(64, Math.round(Number.isFinite(input.iterations) ? (input.iterations as number) : DEFAULT_ITERATIONS)));
  const relaxation = Math.min(1, Math.max(0.05, Number.isFinite(input.relaxation) ? (input.relaxation as number) : DEFAULT_RELAXATION));

  const corrected = (partId: string, vertexId: string, base: GlueVertexPoint): GlueVertexPoint => {
    const offset = offsets.get(partId)?.get(vertexId);
    return offset ? { x: base.x + offset.dx, y: base.y + offset.dy } : base;
  };
  const setOffset = (partId: string, vertexId: string, target: GlueVertexPoint, base: GlueVertexPoint) => {
    const dx = target.x - base.x;
    const dy = target.y - base.y;
    // A pose that needs no correction must leave no trace. Renderers switch a part onto the mesh
    // draw path when it carries stitch offsets, so recording zeros would change rasterization at
    // neutral for no geometric reason.
    if (Math.abs(dx) < ZERO_OFFSET_EPSILON && Math.abs(dy) < ZERO_OFFSET_EPSILON) {
      offsets.get(partId)?.delete(vertexId);
      return;
    }
    let byVertex = offsets.get(partId);
    if (!byVertex) {
      byVertex = new Map();
      offsets.set(partId, byVertex);
    }
    byVertex.set(vertexId, { dx, dy });
  };

  // Projecting is the expensive step and the uncorrected positions never change between passes.
  const basePoints = new Map<string, GlueVertexPoint | undefined>();
  const baseFor = (partId: string, vertexId: string): GlueVertexPoint | undefined => {
    const key = partId + " " + vertexId;
    if (basePoints.has(key)) {
      return basePoints.get(key);
    }
    const point = input.projectVertex(partId, vertexId);
    const usable = point && isFinitePoint(point) ? point : undefined;
    basePoints.set(key, usable);
    return usable;
  };

  const solvable = [];
  for (const pair of pairs) {
    const baseA = baseFor(pair.partAId, pair.aVertexId);
    const baseB = baseFor(pair.partBId, pair.bVertexId);
    if (!baseA || !baseB) {
      skippedPairs += 1;
      continue;
    }
    solvable.push({ ...pair, baseA, baseB });
    resolvedPairs += 1;
  }

  let maxResidual = 0;
  for (let pass = 0; pass < iterations; pass += 1) {
    maxResidual = 0;
    for (const pair of solvable) {
      const currentA = corrected(pair.partAId, pair.aVertexId, pair.baseA);
      const currentB = corrected(pair.partBId, pair.bVertexId, pair.baseB);
      // Error against the rest offset, not against zero: the seam is held at the shape it had at
      // neutral, so the neutral pose is untouched and only pose-driven drift is corrected.
      const errorX = currentB.x - currentA.x - (pair.restDx * restScale * pair.strength + (pair.baseB.x-pair.baseA.x)*(1-pair.strength));
      const errorY = currentB.y - currentA.y - (pair.restDy * restScale * pair.strength + (pair.baseB.y-pair.baseA.y)*(1-pair.strength));
      const drift = Math.hypot(errorX, errorY);
      if (pass === 0 && drift > maxClosedDistance) {
        maxClosedDistance = drift;
      }
      if (drift > maxResidual) {
        maxResidual = drift;
      }
      // weight is the share of the move taken by A, so weight=0 keeps A fixed and moves B instead.
      const stepX = errorX * relaxation;
      const stepY = errorY * relaxation;
      const targetA = { x: currentA.x + stepX * pair.weight, y: currentA.y + stepY * pair.weight };
      const targetB = { x: currentB.x - stepX * (1 - pair.weight), y: currentB.y - stepY * (1 - pair.weight) };
      if (!isFinitePoint(targetA) || !isFinitePoint(targetB)) {
        continue;
      }
      setOffset(pair.partAId, pair.aVertexId, targetA, pair.baseA);
      setOffset(pair.partBId, pair.bVertexId, targetB, pair.baseB);
    }
    if (maxResidual < ZERO_OFFSET_EPSILON) {
      break;
    }
  }

  return { offsets, resolvedPairs, skippedPairs, maxClosedDistance, maxResidual, iterations };
}

/** Apply a resolved correction to a projected vertex. Renderers call this at their draw site. */
export function applyGlueStitchOffset(offsets: GlueVertexOffsets | undefined, partId: string, vertexId: string, point: GlueVertexPoint): GlueVertexPoint {
  return applyPartGlueStitchOffset(offsets?.get(partId), vertexId, point);
}

/** Same correction when the caller already holds the map for one part, as the draw loops do. */
export function applyPartGlueStitchOffset(offsets: Map<string, GlueVertexOffset> | undefined, vertexId: string, point: GlueVertexPoint): GlueVertexPoint {
  const offset = offsets?.get(vertexId);
  return offset ? { x: point.x + offset.dx, y: point.y + offset.dy } : point;
}

/** Uniform scale carried by a base matrix, used to bring stage-unit rest offsets into screen units. */
export function glueStitchRestScale(matrix: Matrix2D): number {
  const determinant = Math.abs(matrix.a * matrix.d - matrix.b * matrix.c);
  return Number.isFinite(determinant) && determinant > 0 ? Math.sqrt(determinant) : 1;
}

/**
 * Convert a screen-space correction into a part's local frame.
 *
 * The Canvas path draws with the part matrix already installed on the context, so it needs the
 * correction as a local vector. Only the linear part of the matrix applies: an offset is a
 * direction, not a position, so the translation must not be included.
 */
export function glueStitchOffsetToLocal(offset: GlueVertexOffset, matrix: Matrix2D): GlueVertexOffset {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) {
    return { dx: 0, dy: 0 };
  }
  return {
    dx: (offset.dx * matrix.d - offset.dy * matrix.c) / determinant,
    dy: (offset.dy * matrix.a - offset.dx * matrix.b) / determinant
  };
}

function weightFromGlue(glue: RigGlue): number {
  const total = glue.weightA + glue.weightB;
  return total > 0 ? glue.weightB / total : 0.5;
}

function isFinitePoint(point: GlueVertexPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.5));
}
