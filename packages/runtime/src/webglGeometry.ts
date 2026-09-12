import { transformMatrixPoint, type Matrix2D } from '@standrig/core/evaluator';
import { hasWarpEffect, warpPoint, type ResolvedWarpDeformer } from '@standrig/core/warp';
import type { ResolvedArtMesh } from '@standrig/core/artMesh';
import type { WebGLMeshVertex } from './webglMesh.js';

/** Uses the same local warp -> shared warp -> stitch -> screen order as Canvas. */
export function buildWebGLPartGeometry(options: {
  left: number; top: number; width: number; height: number;
  matrix: Matrix2D; mesh?: ResolvedArtMesh; warp?: ResolvedWarpDeformer;
  project?: (point: { x: number; y: number }) => { x: number; y: number };
  sharedGrid?: { columns: number; rows: number };
  stitchOffsets?: ReadonlyMap<string, { dx: number; dy: number }>;
}): { vertices: WebGLMeshVertex[]; triangles: number[] } {
  const { left, top, width, height, matrix, mesh, warp, project, sharedGrid, stitchOffsets } = options;
  const bounds = { left, top, width, height };
  const active = hasWarpEffect(warp);
  const vertices: WebGLMeshVertex[] = [];
  const add = (x: number, y: number, u: number, v: number, id?: string) => {
    const warped = active ? warpPoint(x, y, bounds, warp) : { x, y };
    const projected = project ? project(warped) : warped;
    const offset = id === undefined ? undefined : stitchOffsets?.get(id);
    const screen = transformMatrixPoint(matrix, projected.x + (offset?.dx ?? 0), projected.y + (offset?.dy ?? 0));
    vertices.push({ ...screen, u, v });
  };
  if (mesh) {
    for (const vertex of mesh.vertices) add(left + vertex.x, top + vertex.y, vertex.u, vertex.v, vertex.id);
    return { vertices, triangles: mesh.triangles };
  }
  const columns = Math.max(1, Math.round(warp?.grid.columns ?? 1), sharedGrid?.columns ?? 1);
  const rows = Math.max(1, Math.round(warp?.grid.rows ?? 1), sharedGrid?.rows ?? 1);
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      add(left + width * column / columns, top + height * row / rows, column / columns, row / rows);
    }
  }
  const triangles: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const a = row * (columns + 1) + column, b = a + 1, d = a + columns + 1, c = d + 1;
      triangles.push(a, b, c, a, c, d);
    }
  }
  return { vertices, triangles };
}
