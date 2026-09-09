import type { RigReadinessCalibrationReport } from "./readinessCalibration.js";
import type { L2ReadinessQaReport } from "./l2ReadinessQa.js";
import type { RigReadinessReport, RigRecipeRoleSummary } from "./readiness.js";

export type RecipePromotionSourceKind = "production-rig" | "rights-cleared-psd";

export interface RightsClearedSourceEvidence {
  format: "standrig-rights-cleared-source-evidence";
  sourceId: string;
  approved: boolean;
  license: string;
  sha256?: string;
}

export interface RecipePromotionSource {
  kind: RecipePromotionSourceKind;
  id: string;
  fingerprint: string;
  rightsClearedEvidence?: RightsClearedSourceEvidence;
}

export interface PromotedRigRecipe {
  format: "standrig-rig-recipe";
  version: 2;
  status: "promoted";
  source: {
    kind: RecipePromotionSourceKind;
    id: string;
    fingerprint: string;
  };
  coordinateSpace: "stage-ratio";
  landmarks: Array<{ id: string; value: number | { x: number; y: number }; coordinateSpace: "stage-render" }>;
  roles: RigRecipeRoleSummary[];
  notes: string[];
}

export interface RecipePromotionReport {
  format: "standrig-recipe-promotion-report";
  version: 1;
  status: "eligible" | "blocked";
  source: {
    kind: RecipePromotionSourceKind;
    id: string;
    fingerprint: string;
    rightsEvidence: { present: boolean; approved: boolean; license: boolean; hashMatches: boolean };
  };
  gates: {
    l2Ready: boolean;
    l2QaReady: boolean;
    calibrationReady: boolean;
    sourceIdentity: boolean;
    rightsCleared: boolean;
    sourceIdMatch: boolean;
    fingerprintMatch: boolean;
  };
  blockers: string[];
  recipe?: PromotedRigRecipe;
  nextAction: string;
}

export function evaluateRecipePromotion(input: { readiness: RigReadinessReport; calibration: RigReadinessCalibrationReport; l2Qa: L2ReadinessQaReport; source: RecipePromotionSource }): RecipePromotionReport {
  const { readiness, calibration, l2Qa, source } = input;
  const evidence = source.rightsClearedEvidence;
  const sourceIdentity = source.id.trim().length > 0 && source.fingerprint.trim().length > 0;
  const evidencePresent = Boolean(evidence);
  const evidenceApproved = evidence?.approved === true;
  const evidenceLicense = Boolean(evidence?.license?.trim());
  const sourceIdMatch = !evidence || evidence.sourceId === source.id;
  const hashMatches = !evidence?.sha256 || evidence.sha256 === source.fingerprint;
  const rightsCleared = source.kind === "rights-cleared-psd" && evidencePresent && evidenceApproved && evidenceLicense && sourceIdMatch && evidence?.format === "standrig-rights-cleared-source-evidence";
  const l2Ready = readiness.requestedLevel === "L2" && readiness.requestedLevelReady;
  const calibrationReady = calibration.status === "calibrated" && calibration.items.length === 6 && calibration.items.every((item) => item.status === "calibrated");
  const l2QaReady = l2Qa.status === "pass" && l2Qa.qa.ok && l2Qa.exposure.ok && l2Qa.poses.every((pose) => pose.pass);
  const blockers: string[] = [];
  if (!l2Ready) blockers.push("l2-readiness-required");
  if (!l2QaReady) blockers.push("l2-numeric-readiness-qa-required");
  if (!calibrationReady) blockers.push("neutral-render-calibration-incomplete");
  if (!sourceIdentity) blockers.push("source-identity-required");
  if (source.kind !== "rights-cleared-psd") blockers.push("rights-cleared-second-psd-required");
  else if (!evidencePresent || !evidenceApproved || !evidenceLicense || evidence?.format !== "standrig-rights-cleared-source-evidence") blockers.push("rights-cleared-evidence-required");
  if (!sourceIdMatch) blockers.push("rights-cleared-source-id-mismatch");
  if (!hashMatches) blockers.push("rights-cleared-source-sha256-mismatch");
  const status = blockers.length ? "blocked" : "eligible";
  const report: RecipePromotionReport = {
    format: "standrig-recipe-promotion-report",
    version: 1,
    status,
    source: { kind: source.kind, id: source.id, fingerprint: source.fingerprint, rightsEvidence: { present: evidencePresent, approved: evidenceApproved, license: evidenceLicense, hashMatches } },
    gates: { l2Ready, l2QaReady, calibrationReady, sourceIdentity, rightsCleared, sourceIdMatch, fingerprintMatch: hashMatches },
    blockers,
    nextAction: status === "eligible"
      ? "Persist this promoted recipe as a reviewed artifact, then run the L2 transaction QA on the target rig."
      : blockers.includes("rights-cleared-second-psd-required")
        ? "Provide a separate rights-cleared PSD rig and matching source evidence before recipe promotion."
        : "Resolve the listed promotion gates before recipe promotion."
  };
  if (status === "eligible") {
    report.recipe = {
      format: "standrig-rig-recipe",
      version: 2,
      status: "promoted",
      source: { kind: source.kind, id: source.id, fingerprint: source.fingerprint },
      coordinateSpace: "stage-ratio",
      landmarks: calibration.items.map((item) => ({ id: item.id, value: item.value!, coordinateSpace: item.coordinateSpace })),
      roles: readiness.recipe.roles,
      notes: [
        "Promoted from a rights-cleared PSD after L2 role readiness, numeric pose QA, and neutral-render calibration gates.",
        "Stage-render landmarks are retained as provenance; no hard-coded current-model offsets are copied.",
        "Promotion is read-only and does not apply modeling operations to the source rig."
      ]
    };
  }
  return report;
}
