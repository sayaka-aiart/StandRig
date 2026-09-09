import { executeModelingOperation, type ModelingOperation, type ModelingOperationResult } from "./modelingOps.js";
import { normalizeGlue, readRigGlue, readRigGlueCandidates } from "./glue.js";
import type { RigClip, RigDocument, RigGlue, RigGlueCandidate, TransformProperty } from "./types.js";

export type JoinTransactionOperation =
  | { id: string; type: "transform"; partId: string; property: TransformProperty; operator: "add" | "set" | "multiply"; value: number }
  | { id: string; type: "draw-order-set"; partId: string; value: number }
  | { id: string; type: "clip-set"; partId: string; clip: RigClip | null }
  | { id: string; type: "glue-upsert"; glueId?: string; candidateId?: string; patch: Partial<RigGlue> };

export interface JoinTransactionOperationResult {
  operationId: string;
  type: JoinTransactionOperation["type"];
  changes: Array<{ target: string; path: string; before: unknown; after: unknown }>;
  skipped: Array<{ target: string; reason: string }>;
}

export interface JoinTransactionApplyResult {
  operationResults: JoinTransactionOperationResult[];
  modelingResults: ModelingOperationResult[];
  issues: string[];
}

export function applyJoinTransactionOperations(rig: RigDocument, operations: JoinTransactionOperation[], dryRun = false): JoinTransactionApplyResult {
  const operationResults: JoinTransactionOperationResult[] = [];
  const modelingResults: ModelingOperationResult[] = [];
  const issues: string[] = [];
  for (const operation of operations) {
    if (!operation || typeof operation.id !== "string" || !operation.id.trim()) {
      issues.push("operation id is required");
      continue;
    }
    if (operation.type === "transform") {
      const modelingOperation: ModelingOperation = {
        id: operation.id,
        name: "join-transform:" + operation.id,
        target: { partIds: [operation.partId] },
        action: { type: "transform", property: operation.property, operator: operation.operator, value: operation.value }
      };
      try {
        const result = executeModelingOperation(rig, modelingOperation, { dryRun });
        modelingResults.push(result);
        operationResults.push({
          operationId: operation.id,
          type: operation.type,
          changes: result.changes.map((change) => ({ target: change.partId, path: change.path, before: change.before, after: change.after })),
          skipped: result.skipped.map((entry) => ({ target: entry.partId, reason: entry.reason }))
        });
      } catch (error) {
        issues.push(operation.id + ": " + String(error));
      }
      continue;
    }
    if (operation.type === "draw-order-set") {
      const part = rig.parts.find((entry) => entry.id === operation.partId);
      if (!part) {
        operationResults.push({ operationId: operation.id, type: operation.type, changes: [], skipped: [{ target: operation.partId, reason: "part-not-found" }] });
        continue;
      }
      const value = Number(operation.value);
      if (!Number.isFinite(value)) {
        operationResults.push({ operationId: operation.id, type: operation.type, changes: [], skipped: [{ target: operation.partId, reason: "draw-order-must-be-finite" }] });
        continue;
      }
      const before = part.drawOrder;
      const after = Math.round(value);
      const changes = before === after ? [] : [{ target: part.id, path: "drawOrder", before, after }];
      if (!dryRun) part.drawOrder = after;
      operationResults.push({ operationId: operation.id, type: operation.type, changes, skipped: [] });
      continue;
    }
    if (operation.type === "clip-set") {
      const part = rig.parts.find((entry) => entry.id === operation.partId);
      if (!part) {
        operationResults.push({ operationId: operation.id, type: operation.type, changes: [], skipped: [{ target: operation.partId, reason: "part-not-found" }] });
        continue;
      }
      if (operation.clip !== null && (!operation.clip || operation.clip.mode !== "alpha")) {
        operationResults.push({ operationId: operation.id, type: operation.type, changes: [], skipped: [{ target: operation.partId, reason: "clip-mode-must-be-alpha" }] });
        continue;
      }
      const before = part.clip ? JSON.stringify(part.clip) : null;
      const after = operation.clip ? structuredClone(operation.clip) : null;
      if (before !== JSON.stringify(after)) {
        operationResults.push({ operationId: operation.id, type: operation.type, changes: [{ target: part.id, path: "clip", before, after: JSON.stringify(after) }], skipped: [] });
      } else {
        operationResults.push({ operationId: operation.id, type: operation.type, changes: [], skipped: [] });
      }
      if (!dryRun) {
        if (after) part.clip = after;
        else delete part.clip;
      }
      continue;
    }
    if (operation.type === "glue-upsert") {
      operationResults.push(applyGlueUpsert(rig, operation, dryRun));
      continue;
    }
    issues.push("unsupported operation type");
  }
  return { operationResults, modelingResults, issues };
}

function applyGlueUpsert(rig: RigDocument, operation: Extract<JoinTransactionOperation, { type: "glue-upsert" }>, dryRun: boolean): JoinTransactionOperationResult {
  const glueList = readRigGlue(rig);
  const candidate = operation.candidateId ? readRigGlueCandidates(rig).find((entry) => entry.id === operation.candidateId) : undefined;
  const patch = operation.patch ?? {};
  const existing = glueList.find((entry) => entry.id === operation.glueId || entry.id === patch.id || (operation.candidateId && entry.sourceCandidateId === operation.candidateId));
  const base = existing ?? defaultGlueFromCandidate(candidate, patch, operation.candidateId);
  if (!base) return { operationId: operation.id, type: operation.type, changes: [], skipped: [{ target: operation.glueId ?? operation.candidateId ?? "glue", reason: "glue-or-candidate-not-found" }] };
  const before = JSON.stringify(base);
  const next = structuredClone(base);
  applyGluePatch(next, patch);
  normalizeGlue(next, rig);
  const after = JSON.stringify(next);
  const target = "__glue__:" + next.id;
  if (!dryRun) {
    if (existing) Object.assign(existing, next);
    else glueList.push(next);
  }
  return {
    operationId: operation.id,
    type: operation.type,
    changes: before === after ? [] : [{ target, path: existing ? "glue.patch" : "glue.create", before, after }],
    skipped: []
  };
}

function defaultGlueFromCandidate(candidate: RigGlueCandidate | undefined, patch: Partial<RigGlue>, candidateId: string | undefined): RigGlue | undefined {
  const partAId = typeof patch.partAId === "string" ? patch.partAId : candidate?.partAId;
  const partBId = typeof patch.partBId === "string" ? patch.partBId : candidate?.partBId;
  if (!partAId || !partBId) return undefined;
  return {
    id: typeof patch.id === "string" ? patch.id : "glue-" + (candidateId ?? partAId + "-" + partBId),
    name: typeof patch.name === "string" ? patch.name : candidate?.name ?? "Join Glue",
    enabled: patch.enabled !== false,
    status: "draft",
    mode: "soft-seam",
    sourceCandidateId: candidateId,
    partAId,
    partBId,
    region: typeof patch.region === "string" ? patch.region : candidate?.region,
    weightA: candidate?.weightA ?? 0.5,
    weightB: candidate?.weightB ?? 0.5,
    strength: 0.35,
    priority: candidate?.priority ?? 50,
    debugVisible: true,
    tags: [...(candidate?.tags ?? [])],
    notes: candidate?.notes
  };
}

function applyGluePatch(glue: RigGlue, patch: Partial<RigGlue>): void {
  const keys: Array<keyof RigGlue> = ["name", "enabled", "status", "mode", "sourceCandidateId", "partAId", "partBId", "region", "weightA", "weightB", "strength", "priority", "debugVisible", "seamPoints", "vertexPairs", "tags", "notes", "evidence"];
  for (const key of keys) {
    if (patch[key] !== undefined) {
      (glue as unknown as Record<string, unknown>)[key] = structuredClone(patch[key]);
    }
  }
}
