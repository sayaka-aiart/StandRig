export interface NormalizedOperationResultInput {
  operationId?: unknown;
  dryRun?: unknown;
  matchedPartIds?: unknown;
  changes?: unknown;
  skipped?: unknown;
}

export interface NormalizedTransactionResultInput {
  committed: boolean;
  dryRun: boolean;
  revisionBefore: string;
  revisionAfter: string;
  operationResults: readonly NormalizedOperationResultInput[];
  operationGateIssues: readonly unknown[];
}

export interface NormalizedTransactionResult {
  format: "standrig-modeling-transaction-result";
  version: 1;
  mode: "dry-run" | "commit";
  committed: boolean;
  dryRun: boolean;
  revisionBefore: string;
  revisionAfter: string;
  operationCount: number;
  operationResults: Array<{
    operationId: string;
    dryRun: boolean;
    matchedPartIds: string[];
    changeCount: number;
    skipped: unknown[];
  }>;
  operationGateIssues: unknown[];
  noWrite: {
    rigWriteCount: 0 | 1;
    transactionCount: 0 | 1;
    commitCount: 0 | 1;
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Normalizes the shared transaction envelope without discarding the legacy
 * endpoint fields. A candidate operation may be executed with dryRun:false on
 * a clone; the envelope reports the endpoint-level mode instead, so callers
 * cannot mistake clone execution for a committed rig write.
 */
export function normalizeModelingTransactionResult(input: NormalizedTransactionResultInput): NormalizedTransactionResult {
  const committed = input.committed === true;
  const dryRun = input.dryRun === true;
  return {
    format: "standrig-modeling-transaction-result",
    version: 1,
    mode: committed ? "commit" : "dry-run",
    committed,
    dryRun,
    revisionBefore: input.revisionBefore,
    revisionAfter: input.revisionAfter,
    operationCount: input.operationResults.length,
    operationResults: input.operationResults.map((result) => ({
      operationId: typeof result.operationId === "string" ? result.operationId : "unknown",
      dryRun,
      matchedPartIds: strings(result.matchedPartIds),
      changeCount: array(result.changes).length,
      skipped: array(result.skipped)
    })),
    operationGateIssues: [...input.operationGateIssues],
    noWrite: committed
      ? { rigWriteCount: 1, transactionCount: 1, commitCount: 1 }
      : { rigWriteCount: 0, transactionCount: 0, commitCount: 0 }
  };
}