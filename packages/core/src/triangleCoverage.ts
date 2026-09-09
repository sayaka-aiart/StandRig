export const TRIANGLE_COVERAGE_OVERLAP_PX = 0.45;
export interface TrianglePoint { x: number; y: number }
export function expandTriangleForCoverage<T extends TrianglePoint>(vertices: readonly [T,T,T], amount=TRIANGLE_COVERAGE_OVERLAP_PX): [TrianglePoint,TrianglePoint,TrianglePoint] {
  if (!Number.isFinite(amount) || amount <= 0) return vertices.map(v=>({x:v.x,y:v.y})) as [TrianglePoint,TrianglePoint,TrianglePoint];
  const center={x:(vertices[0].x+vertices[1].x+vertices[2].x)/3,y:(vertices[0].y+vertices[1].y+vertices[2].y)/3};
  return vertices.map(vertex=>{const dx=vertex.x-center.x,dy=vertex.y-center.y,length=Math.hypot(dx,dy);return length>1e-9?{x:vertex.x+dx/length*amount,y:vertex.y+dy/length*amount}:{x:vertex.x,y:vertex.y};}) as [TrianglePoint,TrianglePoint,TrianglePoint];
}
export function localCoverageOverlap(transform:{a:number;b:number;c:number;d:number}, pixels=TRIANGLE_COVERAGE_OVERLAP_PX){ const scale=Math.sqrt(Math.max(1e-8,Math.abs(transform.a*transform.d-transform.b*transform.c))); return pixels/scale; }
