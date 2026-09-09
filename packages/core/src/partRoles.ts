import type { RigDocument, RigPart, RigPartRole } from "./types.js";

export const PART_ROLE_DEFINITIONS: ReadonlyArray<{ id: RigPartRole; label: string }> = [
  { id: "unknown", label: "Unknown" }, { id: "face", label: "Face" },
  { id: "eye-left", label: "Left eye" }, { id: "eye-right", label: "Right eye" },
  { id: "brow-left", label: "Left brow" }, { id: "brow-right", label: "Right brow" }, { id: "face-feature", label: "Face feature" },
  { id: "mouth", label: "Mouth" }, { id: "hair-front", label: "Front hair" },
  { id: "hair-back", label: "Back hair" }, { id: "hair-side", label: "Side hair" },
  { id: "hair-tail-left", label: "Left hair tail" }, { id: "hair-tail-right", label: "Right hair tail" },
  { id: "neck", label: "Neck" }, { id: "torso", label: "Torso" }, { id: "soft-tissue", label: "Soft tissue" },
  { id: "clothing", label: "Clothing" }, { id: "accessory", label: "Accessory" }
];

export interface PartRoleSuggestion { role: RigPartRole; confidence: number; reason: string }

export function inferPartRole(part: Pick<RigPart, "name" | "tags" | "kind">): PartRoleSuggestion | undefined {
  if (part.kind !== "image") return undefined;
  const nameSource = normalize(part.name);
  const source = normalize([part.name, ...(part.tags ?? [])].join(" "));
  const side = detectSide(nameSource) ?? detectSide(source);
  if (has(nameSource, "ribbon", "bow", "clip", "accessory", "リボン", "飾り", "アクセ")) return result("accessory", 0.96, "explicit accessory name");
  if (has(nameSource, "twin tail", "twintail", "pony tail", "ponytail", "ツインテ", "テール")) return side ? result(side === "right" ? "hair-tail-right" : "hair-tail-left", 0.96, "explicit hair tail name") : undefined;
  if (has(nameSource, "brow", "eyebrow", "眉")) return side ? result(side === "right" ? "brow-right" : "brow-left", 0.98, "explicit brow name") : undefined;
  if (has(nameSource, "cheek", "blush", "頬", "ほほ")) return result("face-feature", 0.98, "explicit cheek name");
  if (has(nameSource, "eye", "eyeball", "iris", "pupil", "eyelid", "lash", "目", "瞳", "眼球", "まぶた", "まつげ", "二重")) return side ? result(side === "right" ? "eye-right" : "eye-left", 0.96, "explicit eye/lash name") : undefined;
  if (has(nameSource, "mouth", "lip", "口", "唇")) return result("mouth", 0.96, "explicit mouth name");
  if (has(nameSource, "front hair", "bang", "fringe", "前髪")) return result("hair-front", 0.96, "explicit front hair name");
  if (has(nameSource, "back hair", "rear hair", "後ろ髪", "後髪")) return result("hair-back", 0.96, "explicit back hair name");
  if (has(nameSource, "side hair", "横髪", "サイド髪")) return result("hair-side", 0.94, "explicit side hair name");
  if (has(nameSource, "wrist", "手首")) return undefined;
  if (has(nameSource, "shoulder", "肩", "服首", "首下", "collar", "襟", "フリル")) return result("clothing", 0.9, "explicit shoulder/clothing name");
  if (has(nameSource, "neck", "首")) return result("neck", 0.96, "explicit neck name");
  if (has(nameSource, "face", "head skin", "顔", "輪郭")) return result("face", 0.96, "explicit face/outline name");
  if (has(source, "twin tail", "twintail", "pony tail", "ponytail", "ツインテ", "テール")) return side ? result(side === "right" ? "hair-tail-right" : "hair-tail-left", 0.94, "hair tail and side keyword") : undefined;
  if (has(source, "brow", "eyebrow", "眉")) return side ? result(side === "right" ? "brow-right" : "brow-left", 0.94, "brow and side keyword") : undefined;
  if (has(source, "cheek", "blush", "頬", "ほほ")) return result("face-feature", 0.94, "cheek keyword");
  if (has(source, "eye", "eyeball", "iris", "pupil", "eyelid", "lash", "目", "瞳", "眼球", "まぶた", "まつげ", "二重")) return side ? result(side === "right" ? "eye-right" : "eye-left", 0.94, "eye/lash and side keyword") : undefined;
  if (has(source, "mouth", "lip", "口", "唇")) return result("mouth", 0.93, "mouth keyword");
  if (has(source, "front hair", "bang", "fringe", "前髪")) return result("hair-front", 0.93, "front hair keyword");
  if (has(source, "back hair", "rear hair", "後ろ髪", "後髪")) return result("hair-back", 0.93, "back hair keyword");
  if (has(source, "side hair", "横髪", "サイド髪")) return result("hair-side", 0.9, "side hair keyword");
  if (has(source, "face", "head skin", "顔", "輪郭", "outline")) return result("face", 0.9, "face/outline keyword");
  if (has(source, "neck", "首")) return result("neck", 0.92, "neck keyword");
  if (has(source, "body", "torso", "chest", "胴", "身体", "体", "胸")) return result("torso", 0.82, "torso keyword");
  if (has(source, "dress", "shirt", "skirt", "sleeve", "collar", "shoulder", "cloth", "服", "スカート", "袖", "襟", "肩", "フリル")) return result("clothing", 0.88, "clothing keyword");
  if (has(source, "ribbon", "bow", "clip", "accessory", "リボン", "飾り", "アクセ")) return result("accessory", 0.86, "accessory keyword");
  if (has(source, "hair", "髪")) return result("hair-side", 0.58, "generic hair keyword");
  return undefined;
}
export function suggestRigPartRoles(rig: RigDocument): number {
  let changed = 0;
  for (const part of rig.parts) {
    if (part.roleStatus === "confirmed") continue;
    const suggestion = inferPartRole(part);
    if (!suggestion) continue;
    if (part.role !== suggestion.role || part.roleStatus !== "suggested" || part.roleConfidence !== suggestion.confidence) changed += 1;
    part.role = suggestion.role; part.roleStatus = "suggested"; part.roleConfidence = suggestion.confidence;
  }
  return changed;
}
function normalize(value: string) { return value.toLowerCase().replace(/[_.\-\\/]+/g, " ").replace(/\s+/g, " ").trim(); }
function has(source: string, ...needles: string[]) { return needles.some((needle) => source.includes(needle)); }
function detectSide(source: string): "left" | "right" | undefined {
  if (/(^|\s)(right|r)(\s|$)|右/.test(source)) return "right";
  if (/(^|\s)(left|l)(\s|$)|左/.test(source)) return "left";
  return undefined;
}
function result(role: RigPartRole, confidence: number, reason: string): PartRoleSuggestion { return { role, confidence, reason }; }
