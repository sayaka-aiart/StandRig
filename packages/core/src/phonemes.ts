import { previewParameterValuesForRig } from "./parameters.js";
import type { ParameterValues, RigDocument, RigPart } from "./types.js";

export type MouthPhonemeCategory = "vowel" | "expression" | "reference";

export interface MouthPhonemeTarget {
  id: string;
  label: string;
  kana: string;
  category: MouthPhonemeCategory;
  sourcePartId: string;
  sourcePartName: string;
  sourceAssetId?: string;
  sourcePath: string;
  values: ParameterValues;
  tags: string[];
}

const NAME_TARGETS: Record<string, Omit<MouthPhonemeTarget, "sourcePartId" | "sourcePartName" | "sourceAssetId" | "sourcePath" | "tags">> = {
  "あ": {
    id: "phoneme-a",
    label: "A / あ",
    kana: "あ",
    category: "vowel",
    values: { ParamMouthOpen: 1, ParamMouthForm: 0, ParamMouthSmile: 0 }
  },
  "い": {
    id: "phoneme-i",
    label: "I / い",
    kana: "い",
    category: "vowel",
    values: { ParamMouthOpen: 0.35, ParamMouthForm: -1, ParamMouthSmile: 0 }
  },
  "う": {
    id: "phoneme-u",
    label: "U / う",
    kana: "う",
    category: "vowel",
    values: { ParamMouthOpen: 0.45, ParamMouthForm: 1, ParamMouthSmile: 0 }
  },
  "え": {
    id: "phoneme-e",
    label: "E / え",
    kana: "え",
    category: "vowel",
    values: { ParamMouthOpen: 0.6, ParamMouthForm: -0.55, ParamMouthSmile: 0.1 }
  },
  "お": {
    id: "phoneme-o",
    label: "O / お",
    kana: "お",
    category: "vowel",
    values: { ParamMouthOpen: 0.75, ParamMouthForm: 0.8, ParamMouthSmile: 0 }
  },
  "U": {
    id: "phoneme-u-alt",
    label: "U alt",
    kana: "U",
    category: "reference",
    values: { ParamMouthOpen: 0.45, ParamMouthForm: 1, ParamMouthSmile: 0 }
  },
  "笑顔": {
    id: "expression-smile",
    label: "Smile / 笑顔",
    kana: "笑顔",
    category: "expression",
    values: { ParamMouthOpen: 0.45, ParamMouthForm: -0.25, ParamMouthSmile: 1 }
  },
  "一文字": {
    id: "expression-flat",
    label: "Flat / 一文字",
    kana: "一文字",
    category: "expression",
    values: { ParamMouthOpen: 0, ParamMouthForm: -0.75, ParamMouthSmile: 0 }
  },
  "へ": {
    id: "expression-he",
    label: "Downturn / へ",
    kana: "へ",
    category: "expression",
    values: { ParamMouthOpen: 0.2, ParamMouthForm: -0.2, ParamMouthSmile: -1 }
  }
};

const TARGET_ORDER = ["phoneme-a", "phoneme-i", "phoneme-u", "phoneme-e", "phoneme-o", "phoneme-u-alt", "expression-smile", "expression-flat", "expression-he"];

export function mouthPhonemeTargetsForRig(rig: RigDocument): MouthPhonemeTarget[] {
  const partsById = new Map(rig.parts.map((part) => [part.id, part]));
  const targets = rig.parts
    .filter((part) => part.kind === "image" && part.assetId)
    .filter((part) => isMouthPhonemeSource(part, partsById))
    .map((part) => targetForPart(rig, part, partsById))
    .filter((target): target is MouthPhonemeTarget => Boolean(target));

  return targets.sort((left, right) => TARGET_ORDER.indexOf(left.id) - TARGET_ORDER.indexOf(right.id));
}

function isMouthPhonemeSource(part: RigPart, partsById: Map<string, RigPart>): boolean {
  const tags = new Set(part.tags ?? []);
  if (tags.has("phoneme-source")) {
    return true;
  }
  if (!tags.has("mouth-reference")) {
    return false;
  }
  return partPath(part, partsById).some((entry) => entry.name === "口参考");
}

function targetForPart(rig: RigDocument, part: RigPart, partsById: Map<string, RigPart>): MouthPhonemeTarget | undefined {
  const base = NAME_TARGETS[part.name];
  if (!base) {
    return undefined;
  }
  return {
    ...base,
    sourcePartId: part.id,
    sourcePartName: part.name,
    sourceAssetId: part.assetId,
    sourcePath: partPath(part, partsById).map((entry) => entry.name).join("/"),
    values: previewParameterValuesForRig(rig, base.values),
    tags: part.tags ?? []
  };
}

function partPath(part: RigPart, partsById: Map<string, RigPart>): RigPart[] {
  const result: RigPart[] = [];
  const seen = new Set<string>();
  let current: RigPart | undefined = part;
  while (current && !seen.has(current.id)) {
    result.unshift(current);
    seen.add(current.id);
    current = current.parentId ? partsById.get(current.parentId) : undefined;
  }
  return result;
}