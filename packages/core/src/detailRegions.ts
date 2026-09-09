import type { RigDocument, RigPart } from "./types.js";

export type DetailRegionId = "full" | "face" | "eyes" | "mouth" | "neck" | "shoulders" | "hair-roots" | "hair-tail-left" | "hair-tail-right" | "hair-accessory" | "hair-fringe-seam" | "feet" | "body-lower" | "upper-torso";

export interface DetailRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetailRegionDefinition {
  id: DetailRegionId;
  label: string;
  description: string;
  rect: DetailRect;
  partIds: string[];
}

interface PartBox {
  part: RigPart;
  rect: DetailRect;
}

interface RegionSpec {
  id: DetailRegionId;
  label: string;
  description: string;
  minWidth: number;
  minHeight: number;
  paddingRatio: number;
  matches: (part: RigPart, context: RegionContext) => boolean;
}

interface RegionContext {
  descendantsByGroupName: Map<string, Set<string>>;
  hiddenReferenceIds: Set<string>;
}

const REGION_SPECS: RegionSpec[] = [
  {
    id: "full",
    label: "Full",
    description: "Whole stage view.",
    minWidth: 1,
    minHeight: 1,
    paddingRatio: 0,
    matches: () => true
  },
  {
    id: "face",
    label: "Face",
    description: "Face, outline, eyes, mouth, cheeks, and hair roots.",
    minWidth: 760,
    minHeight: 850,
    paddingRatio: 0.18,
    matches: (part, context) =>
      inNamedGroup(part, context, "顔") ||
      nameHas(part, ["輪郭", "目", "眉", "頬", "口", "唇", "歯", "舌", "前髪"]) ||
      tagHas(part, ["face", "eye", "mouth", "outline"])
  },
  {
    id: "eyes",
    label: "Eyes",
    description: "Eyes, eyelids, pupils, highlights, and brows.",
    minWidth: 620,
    minHeight: 340,
    paddingRatio: 0.3,
    matches: (part, context) =>
      inNamedGroup(part, context, "左目") ||
      inNamedGroup(part, context, "右目") ||
      nameHas(part, ["左目", "右目", "目", "瞳", "眉", "ハイライト"]) ||
      tagHas(part, ["eye"])
  },
  {
    id: "mouth",
    label: "Mouth",
    description: "Mouth opening, lip corners, teeth, and tongue.",
    minWidth: 360,
    minHeight: 260,
    paddingRatio: 0.65,
    matches: (part, context) =>
      !context.hiddenReferenceIds.has(part.id) &&
      (inNamedGroup(part, context, "口") || nameHas(part, ["口内", "唇", "歯", "舌"]) || tagHas(part, ["mouth"]))
  },
  {
    id: "neck",
    label: "Neck",
    description: "Jaw, neck, collar, and upper torso connection.",
    minWidth: 560,
    minHeight: 560,
    paddingRatio: 0.32,
    matches: (part) =>
      (!nameHas(part, ["手首"]) && nameHas(part, ["首", "首の影", "輪郭", "服首", "首下", "胸元フリル"])) ||
      tagHas(part, ["neck", "outline"])
  },
  {
    id: "shoulders",
    label: "Shoulders",
    description: "Shoulder, collar, sleeves, and chest seam.",
    minWidth: 980,
    minHeight: 720,
    paddingRatio: 0.24,
    matches: (part) =>
      nameHas(part, ["肩", "服首", "首下", "胸元フリル"]) ||
      tagHas(part, ["shoulder"])
  },
  {
    id: "hair-tail-left",
    label: "Left Twin Tail",
    description: "Left twin-tail root, ribbon, drooping strands, and adjacent back hair seam.",
    minWidth: 520,
    minHeight: 520,
    paddingRatio: 0.24,
    matches: (part) =>
      nameHas(part, ["左ツインテ", "左リボン", "左垂れ髪", "後ろ髪"]) ||
      tagHas(part, ["twintail-left", "hair-tail-left"])
  },
  {
    id: "hair-tail-right",
    label: "Right Twin Tail",
    description: "Right twin-tail root, ribbon, drooping strands, and adjacent back hair seam.",
    minWidth: 520,
    minHeight: 520,
    paddingRatio: 0.24,
    matches: (part) =>
      nameHas(part, ["右ツインテ", "右髪リボン", "右垂れ髪", "後ろ髪"]) ||
      tagHas(part, ["twintail-right", "hair-tail-right"])
  },
  {
    id: "feet",
    label: "Feet",
    description: "Lower legs and foot parts used to verify the foot-anchored body pitch.",
    minWidth: 360,
    minHeight: 360,
    paddingRatio: 0.18,
    matches: (part) =>
      nameHas(part, ["右足下", "左足下", "靴", "ブーツ", "足先"]) ||
      tagHas(part, ["foot", "feet", "shoe", "boot"])
  },
  {
    id: "body-lower",
    label: "Lower Body",
    description: "Skirt, thighs, and lower-body clothing used to verify staged compression.",
    minWidth: 760,
    minHeight: 720,
    paddingRatio: 0.2,
    matches: (part, context) =>
      inNamedGroup(part, context, "下半身") ||
      nameHas(part, ["スカート", "太もも", "足下"]) ||
      tagHas(part, ["skirt", "lower-body", "thigh"])
  },
  {
    id: "upper-torso",
    label: "Upper Torso",
    description: "Chest, collar, shoulders, and neck attachment used to verify upper compression.",
    minWidth: 760,
    minHeight: 620,
    paddingRatio: 0.22,
    matches: (part, context) =>
      inNamedGroup(part, context, "上半身") ||
      nameHas(part, ["胸", "服首", "首下", "肩", "胸元フリル"]) ||
      tagHas(part, ["chest", "shoulder", "upper-body"])
  },  {
    id: "hair-accessory",
    label: "Hair Accessory",
    description: "Front-hair accessory group and the fringe area that carries it.",
    minWidth: 360,
    minHeight: 360,
    paddingRatio: 0.28,
    matches: (part, context) =>
      inNamedGroup(part, context, "髪アクセ") ||
      nameHas(part, ["髪アクセ", "髪飾り"]) ||
      tagHas(part, ["front-hair-anchored", "accessory"])
  },
  {
    id: "hair-fringe-seam",
    label: "Front Back Hair Seam",
    description: "Outer fringe, inner back hair, and generated seam-cover parts.",
    minWidth: 680,
    minHeight: 520,
    paddingRatio: 0.22,
    matches: (part) =>
      nameHas(part, ["前髪", "後ろ髪"]) ||
      tagHas(part, ["front-fringe-cover", "outer-fringe-seam", "back-hair-branch"])
  },  {
    id: "hair-roots",
    label: "Hair Roots",
    description: "Bangs, side hair roots, and face overlap.",
    minWidth: 900,
    minHeight: 760,
    paddingRatio: 0.2,
    matches: (part, context) =>
      inNamedGroup(part, context, "前髪") ||
      nameHas(part, ["前髪", "髪", "輪郭", "目"]) ||
      tagHas(part, ["hair", "outline", "eye"])
  }
];

export function isDetailRegionId(value: string | null | undefined): value is DetailRegionId {
  return value === "full" || value === "face" || value === "eyes" || value === "mouth" || value === "neck" || value === "shoulders" || value === "hair-roots" || value === "hair-tail-left" || value === "hair-tail-right" || value === "hair-accessory" || value === "hair-fringe-seam" || value === "feet" || value === "body-lower" || value === "upper-torso";
}

export function detailRegionDefinitionsForRig(rig: RigDocument): DetailRegionDefinition[] {
  const context = buildRegionContext(rig);
  const boxes = buildPartBoxes(rig).filter((entry) => entry.part.visible !== false);
  const stageRect = { x: 0, y: 0, width: rig.stage.width, height: rig.stage.height };

  return REGION_SPECS.map((spec) => {
    if (spec.id === "full") {
      return {
        id: spec.id,
        label: spec.label,
        description: spec.description,
        rect: stageRect,
        partIds: boxes.map((entry) => entry.part.id)
      };
    }

    const selected = boxes.filter((entry) => spec.matches(entry.part, context));
    const rect = selected.length
      ? expandAndClampRect(unionRects(selected.map((entry) => entry.rect)), spec, stageRect)
      : stageRect;

    return {
      id: spec.id,
      label: spec.label,
      description: spec.description,
      rect,
      partIds: selected.map((entry) => entry.part.id)
    };
  });
}

export function detailRegionForRig(rig: RigDocument, id: DetailRegionId | undefined): DetailRegionDefinition {
  const regions = detailRegionDefinitionsForRig(rig);
  return regions.find((region) => region.id === id) ?? regions[0];
}

function buildRegionContext(rig: RigDocument): RegionContext {
  const descendantsByGroupName = new Map<string, Set<string>>();
  for (const part of rig.parts) {
    if (part.kind !== "group") {
      continue;
    }
    descendantsByGroupName.set(part.name, descendantsOf(rig, part.id));
  }

  const hiddenReferenceIds = new Set<string>();
  for (const part of rig.parts) {
    const tags = part.tags ?? [];
    if (tags.includes("hidden-runtime") || tags.includes("reference") || part.name.includes("参考")) {
      hiddenReferenceIds.add(part.id);
      for (const descendantId of descendantsOf(rig, part.id)) {
        hiddenReferenceIds.add(descendantId);
      }
    }
  }

  return { descendantsByGroupName, hiddenReferenceIds };
}

function descendantsOf(rig: RigDocument, parentId: string): Set<string> {
  const childrenByParent = new Map<string, RigPart[]>();
  for (const part of rig.parts) {
    if (!part.parentId) {
      continue;
    }
    const children = childrenByParent.get(part.parentId) ?? [];
    children.push(part);
    childrenByParent.set(part.parentId, children);
  }

  const result = new Set<string>();
  const stack = [...(childrenByParent.get(parentId) ?? [])];
  while (stack.length) {
    const part = stack.pop();
    if (!part || result.has(part.id)) {
      continue;
    }
    result.add(part.id);
    stack.push(...(childrenByParent.get(part.id) ?? []));
  }
  return result;
}

function buildPartBoxes(rig: RigDocument): PartBox[] {
  const assetsById = new Map(rig.assets.map((asset) => [asset.id, asset]));
  return rig.parts.flatMap((part) => {
    if (part.kind !== "image" || !part.assetId) {
      return [];
    }
    const asset = assetsById.get(part.assetId);
    if (!asset || !asset.width || !asset.height) {
      return [];
    }
    const width = Math.max(1, asset.width * Math.abs(part.transform.scaleX || 1));
    const height = Math.max(1, asset.height * Math.abs(part.transform.scaleY || 1));
    const x = part.transform.x - part.transform.pivotX * width;
    const y = part.transform.y - part.transform.pivotY * height;
    return [{ part, rect: { x, y, width, height } }];
  });
}

function inNamedGroup(part: RigPart, context: RegionContext, groupName: string): boolean {
  return context.descendantsByGroupName.get(groupName)?.has(part.id) ?? false;
}

function nameHas(part: RigPart, needles: string[]): boolean {
  return needles.some((needle) => part.name.includes(needle));
}

function tagHas(part: RigPart, needles: string[]): boolean {
  const tags = part.tags ?? [];
  return needles.some((needle) => tags.includes(needle));
}

function unionRects(rects: DetailRect[]): DetailRect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function expandAndClampRect(rect: DetailRect, spec: RegionSpec, stage: DetailRect): DetailRect {
  const paddedWidth = Math.max(spec.minWidth, rect.width * (1 + spec.paddingRatio));
  const paddedHeight = Math.max(spec.minHeight, rect.height * (1 + spec.paddingRatio));
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const width = Math.min(stage.width, paddedWidth);
  const height = Math.min(stage.height, paddedHeight);
  const x = clamp(centerX - width / 2, stage.x, stage.x + stage.width - width);
  const y = clamp(centerY - height / 2, stage.y, stage.y + stage.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

