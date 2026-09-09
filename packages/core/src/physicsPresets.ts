import type { PhysicsChain, RigDocument, RigPart, RigPartRole } from "./types.js";

export type PhysicsPresetStyle = "gentle" | "standard" | "lively";
export interface PhysicsPresetCandidate { id: string; name: string; role: RigPartRole; partId: string; chain: PhysicsChain; }
export const PHYSICS_PRESET_STYLES: ReadonlyArray<{ id: PhysicsPresetStyle; label: string }> = [{ id: "gentle", label: "Gentle" }, { id: "standard", label: "Standard" }, { id: "lively", label: "Lively" }];
export interface PhysicsRootSafetyIssue { chainId: string; partId: string; message: string; }

const OUTPUTS: Partial<Record<RigPartRole, string>> = {
  "hair-front": "ParamHairFront", "hair-side": "ParamHairSide",
  "hair-back": "ParamHairBack", "hair-tail-left": "ParamHairSide", "hair-tail-right": "ParamHairSide",
  "soft-tissue": "ParamBreath",
  "clothing": "ParamSkirt", "accessory": "ParamRibbon"
};
const ROOT_ROLES = new Set<RigPartRole>(["neck", "face", "torso"]);

export function suggestPhysicsPresets(rig: RigDocument, style: PhysicsPresetStyle = "gentle"): PhysicsPresetCandidate[] {
  const used = new Set(rig.physics?.chains?.map((chain) => chain.id) ?? []);
  const candidates: PhysicsPresetCandidate[] = [];
  for (const part of rig.parts) {
    const output = part.roleStatus === "confirmed" && part.role ? OUTPUTS[part.role] : undefined;
    if (!output) continue;
    const base = `physics-${part.role}-${part.id}`;
    if ([...used].some((id) => id === base || id.startsWith(`${base}-`))) continue;
    const id = uniqueId(used, base);
    candidates.push({ id, name: `${part.name} ${style} sway`, role: part.role!, partId: part.id, chain: createPhysicsPreset(id, `${part.name} ${style} sway`, output, style, part) });
  }
  return candidates;
}

export function auditPhysicsRootSafety(rig: RigDocument): PhysicsRootSafetyIssue[] {
  const parts = new Map(rig.parts.map((part) => [part.id, part]));
  const issues: PhysicsRootSafetyIssue[] = [];
  for (const chain of rig.physics?.chains ?? []) {
    if (chain.parameterOutput) continue;
    for (const partId of chain.targetPartIds) {
      const part = parts.get(partId);
      if (!part) continue;
      if (part.id === "root" || (part.role && ROOT_ROLES.has(part.role))) {
        issues.push({ chainId: chain.id, partId, message: `${part.name} is a structural root; use parameter output for secondary motion.` });
      }
    }
  }
  return issues;
}

function createPhysicsPreset(id: string, name: string, parameter: string, style: PhysicsPresetStyle, part: RigPart): PhysicsChain {
  const settings = style === "lively" ? { stiffness: 15, damping: 6.5, scale: 1.35, limit: 1.35, delay: 0.16 } : style === "standard" ? { stiffness: 17, damping: 7.5, scale: 1, limit: 1, delay: 0.13 } : { stiffness: 20, damping: 9, scale: 0.65, limit: 0.65, delay: 0.1 };
  const cloth = part.role === "clothing" || part.role === "accessory" || part.role === "soft-tissue";
  return { id, name, enabled: true, targetPartIds: [], sourceParameters: cloth ? [{ parameter: "ParamBodyAngleX", scale: 0.05 }, { parameter: "ParamBodyAngleY", scale: 0.02 }] : [{ parameter: "ParamAngleX", scale: 0.05 }, { parameter: "ParamBodyAngleX", scale: 0.02 }], stiffness: settings.stiffness, damping: settings.damping, mass: cloth ? 1.25 : 1, gravity: 0, wind: 0, output: { property: "rotation", scale: 1 }, parameterOutput: { parameter, scale: settings.scale, min: -settings.limit, max: settings.limit }, segments: [{ id: "root", length: 1, delay: 0.025, damping: 1 }, { id: "tip", length: cloth ? 1.55 : 1.35, delay: settings.delay, damping: 0.82 }] };
}function uniqueId(used: Set<string>, base: string): string { let id = base; let index = 2; while (used.has(id)) id = `${base}-${index++}`; used.add(id); return id; }