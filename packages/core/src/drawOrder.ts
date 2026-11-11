import { keyformGridIssues, sampleKeyformGrid } from "./multiBindings.js";
import type { MultiParameterKeyform, ParameterValues, RigDrawOrderBinding, RigPart } from "./types.js";

function keyformValue(keyform: MultiParameterKeyform): number {
  return keyform.value;
}

/**
 * The draw order a part sorts by at these parameter values: its keyed draw order when it has one
 * (truncated to an integer when asked), otherwise the static `drawOrder`.
 */
export function resolvePartDrawOrder(part: Pick<RigPart, "drawOrder" | "drawOrderBinding">, values: ParameterValues): number {
  const binding = part.drawOrderBinding;
  if (!binding) return part.drawOrder;
  const sampled = sampleKeyformGrid(binding.parameters, binding.keyforms, keyformValue, values);
  if (sampled === undefined) return part.drawOrder;
  return binding.rounding === "truncate" ? Math.trunc(sampled + 0.001) : sampled;
}

/** True when any part's draw order depends on parameters, so a cached sort must be redone per pose. */
export function hasKeyedDrawOrder(parts: readonly RigPart[]): boolean {
  return parts.some((part) => part.drawOrderBinding !== undefined);
}

/**
 * Back-to-front copy of `parts` at these values. The sort is stable, so equal draw orders keep
 * their order in `parts`.
 */
export function sortPartsByDrawOrder<T extends Pick<RigPart, "drawOrder" | "drawOrderBinding">>(parts: readonly T[], values: ParameterValues): T[] {
  if (!parts.some((part) => part.drawOrderBinding !== undefined)) return [...parts].sort((left, right) => left.drawOrder - right.drawOrder);
  const orders = new Map(parts.map((part) => [part, resolvePartDrawOrder(part, values)]));
  return [...parts].sort((left, right) => orders.get(left)! - orders.get(right)!);
}

type PaintPart = Pick<RigPart, "id" | "parentId" | "kind" | "drawOrder" | "drawOrderBinding" | "drawOrderGroup">;

/** True when any group part sorts its image descendants as one unit (a draw order group). */
export function hasDrawOrderGroups(parts: readonly PaintPart[]): boolean {
  return parts.some((part) => part.kind === "group" && part.drawOrderGroup === true);
}

/**
 * Back-to-front paint order of `parts` (image parts of `allParts`) at these values.
 *
 * Without draw order groups this is `sortPartsByDrawOrder`. With them it is a hierarchical
 * sort: an image part sorts only among the members of its nearest `drawOrderGroup` ancestor (or the
 * top level), a group occupies one slot among its own siblings positioned by its own draw order, and
 * equal draw orders keep `allParts` order. Groups without the flag do not affect sorting.
 */
export function sortPartsForPaint<T extends PaintPart>(allParts: readonly PaintPart[], parts: readonly T[], values: ParameterValues): T[] {
  if (!hasDrawOrderGroups(allParts)) return sortPartsByDrawOrder(parts, values);
  const byId = new Map(allParts.map((part) => [part.id, part]));
  const indexOf = new Map(allParts.map((part, index) => [part.id, index]));
  const groupOf = (part: PaintPart): string | null => {
    const seen = new Set<string>([part.id]);
    for (let current = part.parentId ? byId.get(part.parentId) : undefined; current && !seen.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
      seen.add(current.id);
      if (current.kind === "group" && current.drawOrderGroup === true) return current.id;
    }
    return null;
  };
  type Slot = { part: PaintPart; leaf?: T; order: number; index: number };
  const members = new Map<string | null, Slot[]>();
  const add = (key: string | null, slot: Slot) => { const list = members.get(key); if (list) list.push(slot); else members.set(key, [slot]); };
  for (const leaf of parts) add(groupOf(leaf), { part: leaf, leaf, order: resolvePartDrawOrder(leaf, values), index: indexOf.get(leaf.id) ?? Number.MAX_SAFE_INTEGER });
  for (const group of allParts) {
    if (group.kind === "group" && group.drawOrderGroup === true) add(groupOf(group), { part: group, order: resolvePartDrawOrder(group, values), index: indexOf.get(group.id)! });
  }
  const result: T[] = [];
  const emit = (key: string | null, depth: number) => {
    const list = members.get(key);
    if (!list || depth > allParts.length) return;
    list.sort((left, right) => left.order - right.order || left.index - right.index);
    for (const slot of list) {
      if (slot.leaf) result.push(slot.leaf);
      else emit(slot.part.id, depth + 1);
    }
  };
  emit(null, 0);
  return result;
}

export function drawOrderBindingIssues(binding: RigDrawOrderBinding | undefined, knownParameters: ReadonlySet<string>): string[] {
  if (binding === undefined) return [];
  if (!binding || typeof binding !== "object") return ["drawOrderBinding must be an object"];
  const issues = keyformGridIssues(binding.parameters, binding.keyforms, keyformValue, knownParameters);
  if (binding.rounding !== undefined && binding.rounding !== "none" && binding.rounding !== "truncate") issues.push("rounding must be none or truncate");
  return issues;
}

/** True when the part's keyed draw order or blend colors read this parameter. */
export function partParameterTrackUses(part: Pick<RigPart, "drawOrderBinding" | "blendColors">, parameter: string): boolean {
  const tracks: Array<readonly string[] | undefined> = [part.drawOrderBinding?.parameters, part.blendColors?.parameters];
  return tracks.some((parameters) => Array.isArray(parameters) && parameters.includes(parameter));
}
