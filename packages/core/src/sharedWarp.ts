export interface SharedWarpBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SharedWarpControlPoint {
  bindings?: import("./types.js").RigWarpPinBinding[];
  id: string;
  column: number;
  row: number;
  offsetX: number;
  offsetY: number;
  enabled?: boolean;
}

export interface SharedWarpField {
  version: 1;
  enabled: boolean;
  bounds: SharedWarpBounds;
  grid: { columns: number; rows: number };
  controlPoints: SharedWarpControlPoint[];
}

export function normalizeSharedWarpField(value: Partial<SharedWarpField> | undefined): SharedWarpField {
  const columns = integer(value?.grid?.columns, 1, 16, 1);
  const rows = integer(value?.grid?.rows, 1, 16, 1);
  const bounds = {
    left: number(value?.bounds?.left, 0),
    top: number(value?.bounds?.top, 0),
    width: Math.max(1, number(value?.bounds?.width, 1)),
    height: Math.max(1, number(value?.bounds?.height, 1))
  };
  const points = new Map<string, SharedWarpControlPoint>();
  for (const point of value?.controlPoints ?? []) {
    const column = integer(point?.column, 0, columns, 0);
    const row = integer(point?.row, 0, rows, 0);
    points.set(`${column}|${row}`, {
      id: typeof point?.id === "string" && point.id ? point.id : `p-${column}-${row}`,
      bindings: point.bindings ? structuredClone(point.bindings) : undefined,
      column, row, offsetX: number(point?.offsetX, 0), offsetY: number(point?.offsetY, 0), enabled: point?.enabled !== false
    });
  }
  return { version: 1, enabled: value?.enabled !== false, bounds, grid: { columns, rows }, controlPoints: [...points.values()] };
}

export function sampleSharedWarpField(field: SharedWarpField, x: number, y: number) {
  if (!field.enabled) return { x: 0, y: 0 };
  const u = clamp((x - field.bounds.left) / field.bounds.width, 0, 1);
  const v = clamp((y - field.bounds.top) / field.bounds.height, 0, 1);
  const gx = u * field.grid.columns;
  const gy = v * field.grid.rows;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const x1 = Math.min(field.grid.columns, x0 + 1), y1 = Math.min(field.grid.rows, y0 + 1);
  const tx = gx - x0, ty = gy - y0;
  const points = new Map(field.controlPoints.map((point) => [`${point.column}|${point.row}`, point]));
  const point = (column: number, row: number) => points.get(`${column}|${row}`);
  const offset = (column: number, row: number) => {
    const entry = point(column, row);
    return entry && entry.enabled !== false ? entry : { offsetX: 0, offsetY: 0 };
  };
  const q00 = offset(x0, y0), q10 = offset(x1, y0), q01 = offset(x0, y1), q11 = offset(x1, y1);
  return {
    x: bilinear(q00.offsetX, q10.offsetX, q01.offsetX, q11.offsetX, tx, ty),
    y: bilinear(q00.offsetY, q10.offsetY, q01.offsetY, q11.offsetY, tx, ty)
  };
}

export function warpSharedFieldPoint(field: SharedWarpField, x: number, y: number) {
  const offset = sampleSharedWarpField(field, x, y);
  return { x: x + offset.x, y: y + offset.y };
}

/** Resize a field while sampling its current displacement at each new node. */
export function resizeSharedWarpField(field: SharedWarpField, columns: number, rows: number): SharedWarpField {
  const source = normalizeSharedWarpField(field);
  const nextColumns = integer(columns, 1, 16, source.grid.columns);
  const nextRows = integer(rows, 1, 16, source.grid.rows);
  if(source.controlPoints.some(p=>p.bindings?.length)){
    if(nextColumns===source.grid.columns&&nextRows===source.grid.rows)return source;
    throw Error('Cannot resize a keyframed shared Warp grid without remapping its keys');
  }
  const controlPoints: SharedWarpControlPoint[] = [];
  for (let row = 0; row <= nextRows; row += 1) {
    for (let column = 0; column <= nextColumns; column += 1) {
      const x = source.bounds.left + (column / nextColumns) * source.bounds.width;
      const y = source.bounds.top + (row / nextRows) * source.bounds.height;
      const offset = sampleSharedWarpField(source, x, y);
      controlPoints.push({ id: `p-${column}-${row}`, column, row, offsetX: offset.x, offsetY: offset.y, enabled: true });
    }
  }
  return normalizeSharedWarpField({ ...source, grid: { columns: nextColumns, rows: nextRows }, controlPoints });
}
export function hasSharedWarpFieldEffect(field: SharedWarpField | undefined): boolean {
  return Boolean(field?.enabled && field.controlPoints.some((point) => point.enabled !== false && (Math.abs(point.offsetX) > 0.0001 || Math.abs(point.offsetY) > 0.0001)));
}

function bilinear(q00: number, q10: number, q01: number, q11: number, tx: number, ty: number) {
  return q00 * (1 - tx) * (1 - ty) + q10 * tx * (1 - ty) + q01 * (1 - tx) * ty + q11 * tx * ty;
}
function number(value: unknown, fallback: number) { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function integer(value: unknown, min: number, max: number, fallback: number) { return Math.round(clamp(number(value, fallback), min, max)); }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
