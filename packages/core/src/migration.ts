import { RIG_SCHEMA_VERSION, type RigDocument } from "./types.js";

export const CURRENT_RIG_SCHEMA_VERSION = RIG_SCHEMA_VERSION;

export class RigMigrationError extends Error {
  readonly code: "invalid-document" | "unsupported-version";

  constructor(code: RigMigrationError["code"], message: string) {
    super(message);
    this.name = "RigMigrationError";
    this.code = code;
  }
}

/**
 * Validates and migrates a serialized rig at the application boundary.
 * The current schema is deliberately returned by reference: migration must
 * not silently normalize or rewrite a model that is already current.
 */
export function migrateRigDocument(value: unknown): RigDocument {
  if (!isRecord(value)) {
    throw invalid("Rig document must be an object");
  }
  if (typeof value.schemaVersion !== "string" || !value.schemaVersion.trim()) {
    throw invalid("Rig document is missing schemaVersion");
  }
  if (value.schemaVersion !== CURRENT_RIG_SCHEMA_VERSION) {
    throw new RigMigrationError(
      "unsupported-version",
      `Unsupported rig schemaVersion ${value.schemaVersion}; expected ${CURRENT_RIG_SCHEMA_VERSION}`
    );
  }
  assertCurrentShape(value);
  return value as unknown as RigDocument;
}

function assertCurrentShape(value: Record<string, unknown>): void {
  if (typeof value.name !== "string") throw invalid("Rig document is missing name");
  if (!isRecord(value.stage)) throw invalid("Rig document is missing stage");
  for (const field of ["assets", "parameters", "parts"] as const) {
    if (!Array.isArray(value[field])) throw invalid(`Rig document field ${field} must be an array`);
  }
  if (!isRecord(value.physics)) throw invalid("Rig document is missing physics");
  if (value.deformers !== undefined && !Array.isArray(value.deformers)) {
    throw invalid("Rig document field deformers must be an array when present");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): RigMigrationError {
  return new RigMigrationError("invalid-document", message);
}
