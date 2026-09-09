import { runExposureSweep } from "./exposureQa.js";
import { defaultParameterValues } from "./parameters.js";
import { modelingPoseValuesForRig } from "./modeling.js";
import { evaluateRigReadiness } from "./readiness.js";
import { runQaCheck, type QaCheckPoseSample } from "./qaCheck.js";
import type { ParameterValues, RigDocument } from "./types.js";

export const L2_READINESS_POSES = ["neutral", "face-left", "face-right", "face-up", "face-down", "blink", "mouth-flat", "mouth-half", "mouth-open"] as const;
export const L2_READINESS_REGIONS = ["face", "eyes", "mouth"] as const;

export interface L2ReadinessQaOptions {
  width?: number;
  height?: number;
  minCoverage?: number;
  minMotionDiffPixelRatio?: number;
  maxExposedRatio?: number;
}

export interface L2ReadinessQaPoseSummary {
  poseId: string;
  family: "neutral" | "face" | "blink" | "mouth";
  entryCount: number;
  failedCount: number;
  maxMotionDiffPixelRatio: number;
  pass: boolean;
}

export interface L2ReadinessQaReport {
  format: "standrig-l2-readiness-qa";
  version: 1;
  status: "pass" | "blocked";
  requestedLevel: "L2";
  render: {
    width: number;
    height: number;
    regions: string[];
    poses: string[];
    physics: false;
    physicsSteps: 0;
    minCoverage: number;
    mouthMinCoverage: number;
    minMotionDiffPixelRatio: number;
    maxExposedRatio: number;
  };
  roleCoverage: { ready: boolean; coverageRatio: number; missingRoles: string[]; suggestedOnlyRoles: string[] };
  poses: L2ReadinessQaPoseSummary[];
  qa: { ok: boolean; entryCount: number; failedCount: number; failureRegions: number; issues: string[] };
  exposure: { ok: boolean; entryCount: number; suspectCount: number; maxExposedRatio: number; totalExposedPixels: number };
  blockers: string[];
  nextAction: string;
}

const FACE_POSES = new Set(["face-left", "face-right", "face-up", "face-down"]);

export async function runL2ReadinessQa(rig: RigDocument, publicDir: string, options: L2ReadinessQaOptions = {}): Promise<L2ReadinessQaReport> {
  const width = clampInteger(options.width ?? 240, 64, 480);
  const height = clampInteger(options.height ?? 240, 64, 480);
  const minCoverage = clampRatio(options.minCoverage, 0.001);
  // Closed mouth is a single thin stroke; keep the strict threshold for face/eyes.
  const mouthMinCoverage = Math.min(minCoverage, 0.0004);
  const minMotionDiffPixelRatio = clampRatio(options.minMotionDiffPixelRatio, 0.0001);
  const maxExposedRatio = clampRatio(options.maxExposedRatio, 0.08);
  const baseValues = defaultParameterValues(rig);
  const poseSamples: QaCheckPoseSample[] = L2_READINESS_POSES.flatMap((poseId) => {
    const values = modelingPoseValuesForRig(rig, poseId, baseValues);
    return values ? [{ poseId, values }] : [];
  });
  const coreQa = await runQaCheck(rig, publicDir, {
    poses: [...L2_READINESS_POSES],
    poseSamples,
    regions: ["face", "eyes"],
    width,
    height,
    physics: false,
    physicsSteps: 0,
    minCoverage,
    checkTriangleDistortion: true,
    supersample: 1
  });
  const mouthQa = await runQaCheck(rig, publicDir, {
    poses: [...L2_READINESS_POSES],
    poseSamples,
    regions: ["mouth"],
    width,
    height,
    physics: false,
    physicsSteps: 0,
    minCoverage: mouthMinCoverage,
    checkTriangleDistortion: true,
    supersample: 1
  });
  const qa = {
    ok: coreQa.ok && mouthQa.ok,
    entries: [...coreQa.entries, ...mouthQa.entries],
    failed: [...coreQa.failed, ...mouthQa.failed],
    failureRegions: [...coreQa.failureRegions, ...mouthQa.failureRegions],
    renderedCount: coreQa.renderedCount + mouthQa.renderedCount,
    imagePolicy: "numeric-only" as const,
    cache: coreQa.cache === "hit" && mouthQa.cache === "hit" ? "hit" as const : "miss" as const,
    issues: [...(coreQa.issues ?? []), ...(mouthQa.issues ?? [])]
  };
  const exposure = await runExposureSweep(rig, publicDir, {
    poses: L2_READINESS_POSES.filter((poseId) => poseId !== "neutral"),
    regions: [...L2_READINESS_REGIONS],
    width,
    height,
    physics: false,
    physicsSteps: 0,
    alphaThreshold: 8,
    minLostPixels: 4,
    maxLostRatio: maxExposedRatio,
    motionRadius: 4,
    baseValues
  });
  const roleReadiness = evaluateRigReadiness(rig, { level: "L2" });
  const poseSummaries = L2_READINESS_POSES.map((poseId) => {
    const entries = qa.entries.filter((entry) => entry.poseId === poseId);
    const maxMotion = entries.reduce((max, entry) => Math.max(max, entry.motionDiffPixelRatio ?? 0), 0);
    const failedCount = entries.filter((entry) => !entry.pass).length;
    const family: L2ReadinessQaPoseSummary["family"] = poseId === "neutral" ? "neutral" : FACE_POSES.has(poseId) ? "face" : poseId === "blink" ? "blink" : "mouth";
    const motionRequired = family !== "neutral";
    return { poseId, family, entryCount: entries.length, failedCount, maxMotionDiffPixelRatio: round(maxMotion), pass: entries.length === L2_READINESS_REGIONS.length && failedCount === 0 && (!motionRequired || maxMotion >= minMotionDiffPixelRatio) };
  });
  const blockers: string[] = [];
  if (!roleReadiness.requestedLevelReady) blockers.push("l2-role-coverage-required");
  if (!qa.ok) blockers.push("l2-numeric-qa-failed");
  if (!exposure.ok) blockers.push("l2-exposure-qa-failed");
  for (const pose of poseSummaries.filter((entry) => !entry.pass)) blockers.push(`l2-pose-failed:${pose.poseId}`);
  const status = blockers.length ? "blocked" : "pass";
  return {
    format: "standrig-l2-readiness-qa",
    version: 1,
    status,
    requestedLevel: "L2",
    render: { width, height, regions: [...L2_READINESS_REGIONS], poses: [...L2_READINESS_POSES], physics: false, physicsSteps: 0, minCoverage, mouthMinCoverage, minMotionDiffPixelRatio, maxExposedRatio },
    roleCoverage: { ready: roleReadiness.requestedLevelReady, coverageRatio: roleReadiness.levels.L2.coverageRatio, missingRoles: roleReadiness.missingRoles, suggestedOnlyRoles: roleReadiness.suggestedOnlyRoles },
    poses: poseSummaries,
    qa: { ok: qa.ok, entryCount: qa.entries.length, failedCount: qa.failed.length, failureRegions: qa.failureRegions.length, issues: [...(qa.issues ?? []), ...qa.failed.flatMap((entry) => entry.issues)].slice(0, 24) },
    exposure: { ok: exposure.ok, entryCount: exposure.entries.length, suspectCount: exposure.suspect.length, maxExposedRatio: round(exposure.summary.maxExposedRatio), totalExposedPixels: exposure.summary.totalExposedPixels },
    blockers,
    nextAction: status === "pass" ? "Attach this L2 numeric QA to the rights-cleared source evidence before recipe promotion." : "Resolve the L2 role, pose, numeric QA, or exposure blockers before recipe promotion."
  };
}


function clampInteger(value: number, min: number, max: number): number { const numeric = Number(value); return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.round(numeric))) : min; }
function clampRatio(value: unknown, fallback: number): number { const numeric = Number(value); return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback; }
function round(value: number): number { return Math.round(value * 10000) / 10000; }
