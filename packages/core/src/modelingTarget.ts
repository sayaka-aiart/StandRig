import type { RigDocument, RigPartRole } from "./types.js";

export interface ModelingOperationTarget {
  roles?: RigPartRole[];
  partIds?: string[];
  deformerIds?: string[];
}

/** Nonempty selector fields intersect; roles must be confirmed. */
export function matchesPartTarget(part: RigDocument["parts"][number], target: ModelingOperationTarget): { matched: boolean; reason?: string } {
  const hasRoles = Boolean(target.roles?.length); const hasIds = Boolean(target.partIds?.length);
  if (!hasRoles && !hasIds) return { matched: false };
  if (hasIds && !target.partIds!.includes(part.id)) return { matched: false };
  if (hasRoles) {
    if (part.roleStatus !== "confirmed") return { matched: false, reason: part.role ? "role-not-confirmed" : "role-unassigned" };
    if (!part.role || !target.roles!.includes(part.role)) return { matched: false };
  }
  return { matched: true };
}
