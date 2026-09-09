import { normalizeArtPath, validateArtPath } from "./artPath.js";
import type { RigArtPath, RigDocument } from "./types.js";

export type ArtPathTransactionOperation =
  | { id: string; type: "art-path-upsert"; partId: string; path: RigArtPath }
  | { id: string; type: "art-path-remove"; partId: string; pathId: string };

export interface ArtPathTransactionOperationResult {
  operationId: string;
  type: ArtPathTransactionOperation["type"];
  changes: Array<{ target: string; path: string; before: unknown; after: unknown }>;
  skipped: Array<{ target: string; reason: string }>;
}

export interface ArtPathTransactionApplyResult {
  operationResults: ArtPathTransactionOperationResult[];
  issues: string[];
}

export function applyArtPathTransactionOperations(rig: RigDocument, operations: ArtPathTransactionOperation[]): ArtPathTransactionApplyResult {
  const operationResults: ArtPathTransactionOperationResult[] = [];
  const issues: string[] = [];
  for (const operation of operations) {
    if (!operation || typeof operation.id !== "string" || !operation.id.trim()) {
      issues.push("operation id is required");
      continue;
    }
    const part = rig.parts.find((entry) => entry.id === operation.partId);
    if (!part) {
      operationResults.push({ operationId: operation.id, type: operation.type, changes: [], skipped: [{ target: operation.partId ?? "part", reason: "part-not-found" }] });
      continue;
    }
    if (part.kind !== "image") {
      operationResults.push({ operationId: operation.id, type: operation.type, changes: [], skipped: [{ target: part.id, reason: "art-path-requires-image-part" }] });
      continue;
    }
    if (operation.type === "art-path-upsert") {
      const next = structuredClone(operation.path);
      normalizeArtPath(next, `${part.id}-path-${(part.artPaths?.length ?? 0) + 1}`);
      const validationIssues = validateArtPath(next);
      if (validationIssues.length) {
        operationResults.push({ operationId: operation.id, type: operation.type, changes: [], skipped: validationIssues.map((reason) => ({ target: part.id, reason })) });
        continue;
      }
      const paths = Array.isArray(part.artPaths) ? part.artPaths : [];
      const index = paths.findIndex((entry) => entry.id === next.id);
      const before = index >= 0 ? structuredClone(paths[index]) : null;
      const after = structuredClone(next);
      if (index >= 0) paths[index] = after;
      else paths.push(after);
      part.artPaths = paths;
      operationResults.push({ operationId: operation.id, type: operation.type, changes: [{ target: part.id, path: `artPaths.${next.id}`, before, after }], skipped: [] });
      continue;
    }
    if (operation.type === "art-path-remove") {
      const paths = Array.isArray(part.artPaths) ? part.artPaths : [];
      const index = paths.findIndex((entry) => entry.id === operation.pathId);
      if (index < 0) {
        operationResults.push({ operationId: operation.id, type: operation.type, changes: [], skipped: [{ target: part.id, reason: "art-path-not-found" }] });
        continue;
      }
      const [before] = paths.splice(index, 1);
      if (paths.length) part.artPaths = paths;
      else delete part.artPaths;
      operationResults.push({ operationId: operation.id, type: operation.type, changes: [{ target: part.id, path: `artPaths.${operation.pathId}`, before, after: null }], skipped: [] });
      continue;
    }
    issues.push("unsupported operation type");
  }
  return { operationResults, issues };
}

