import { auditModelingRig, type ModelingAuditIssue } from "./modelingAudit.js";
import type { RigDocument } from "./types.js";

export interface ModelFreezeReadiness {
  ready: boolean;
  blockers: ModelingAuditIssue[];
  advisories: ModelingAuditIssue[];
  nextSteps: string[];
}

export function evaluateModelFreezeReadiness(rig: RigDocument): ModelFreezeReadiness {
  const audit = auditModelingRig(rig);
  const blockers = audit.issues.filter((issue) => issue.severity === "error" || issue.id.startsWith("physics-root-") || issue.id.startsWith("physics-output-unbound-"));
  const advisories = audit.issues.filter((issue) => !blockers.includes(issue));
  return { ready: blockers.length === 0, blockers, advisories, nextSteps: blockers.length ? blockers.map((issue) => issue.recommendation) : ["Freeze neutral and representative poses, then begin tracking gain calibration."] };
}