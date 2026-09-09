import type { RigDocument } from "./types.js";
import { migrateRigDocument } from "./migration.js";

const RIG_DRAFT_STORAGE_KEY = "codex-standrig:draft-rig";
const RIG_DRAFT_DB_NAME = "codex-standrig";
const RIG_DRAFT_DB_VERSION = 1;
const RIG_DRAFT_STORE = "drafts";
const RIG_DRAFT_ID = "current";
const LOCAL_STORAGE_DRAFT_SOFT_LIMIT = 1_500_000;

export interface RigDraftSaveResult {
  ok: boolean;
  stored: "indexeddb" | "localStorage" | "none";
  bytes: number;
  error?: string;
}

export async function fetchRigDocument(): Promise<RigDocument> {
  const apiResponse = await fetch("/api/rig?includeAssets=1", { cache: "no-store" }).catch(() => null);
  if (apiResponse?.ok) {
    return migrateRigDocument(await apiResponse.json());
  }

  const staticResponse = await fetch("/rig.json", { cache: "no-store" });
  if (!staticResponse.ok) {
    throw new Error(`Unable to load rig.json: ${staticResponse.status}`);
  }
  return migrateRigDocument(await staticResponse.json());
}

export async function saveRigDocument(
  rig: RigDocument,
  options: { downloadFallback?: boolean } = {}
): Promise<"api" | "download" | "failed"> {
  const downloadFallback = options.downloadFallback ?? true;
  const body = JSON.stringify(rig, null, 2);
  const response = await fetch("/api/rig?includeAssets=1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body
  }).catch(() => null);

  if (response?.ok) {
    return "api";
  }

  if (!downloadFallback) {
    return "failed";
  }

  const blob = new Blob([`${body}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "rig.json";
  anchor.click();
  URL.revokeObjectURL(url);
  return "download";
}

export async function saveRigDraft(rig: RigDocument): Promise<RigDraftSaveResult> {
  const json = JSON.stringify(rig);
  const bytes = byteSize(json);
  clearLocalDraft();

  try {
    await saveDraftToIndexedDb(rig);
    saveDraftManifest({
      storage: "indexeddb",
      updatedAt: new Date().toISOString(),
      bytes,
      name: rig.name
    });
    return { ok: true, stored: "indexeddb", bytes };
  } catch (idbError) {
    if (bytes > LOCAL_STORAGE_DRAFT_SOFT_LIMIT) {
      return {
        ok: false,
        stored: "none",
        bytes,
        error: `IndexedDB draft save failed and rig is too large for localStorage (${formatBytes(bytes)}): ${formatError(idbError)}`
      };
    }

    try {
      localStorage.setItem(RIG_DRAFT_STORAGE_KEY, json);
      return { ok: true, stored: "localStorage", bytes };
    } catch (localStorageError) {
      return {
        ok: false,
        stored: "none",
        bytes,
        error: `Draft save failed (${formatBytes(bytes)}): ${formatError(localStorageError)}`
      };
    }
  }
}

export async function loadRigDraft(): Promise<RigDocument | undefined> {
  const idbDraft = await loadDraftFromIndexedDb().catch(() => undefined);
  if (idbDraft !== undefined) {
    try {
      return migrateRigDocument(idbDraft);
    } catch (_error) {
      // Ignore an invalid or unsupported draft and continue to the fallback.
    }
  }

  const raw = getLocalDraft();
  if (!raw) {
    return undefined;
  }

  try {
    return migrateRigDocument(JSON.parse(raw));
  } catch (_error) {
    return undefined;
  }
}

export function downloadRigDocument(rig: RigDocument) {
  downloadJsonDocument(JSON.stringify(rig, null, 2), "rig.json");
}

export async function exportRigDocumentAs(rig: RigDocument): Promise<"saved" | "download" | "cancelled"> {
  const body = `${JSON.stringify(rig, null, 2)}\n`;
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (typeof picker !== "function") {
    downloadJsonDocument(body, "rig.json");
    return "download";
  }

  try {
    const handle = await picker({
      suggestedName: `${safeFileStem(rig.name || "rig")}.json`,
      types: [{ description: "StandRig JSON", accept: { "application/json": [".json"] } }]
    });
    const writable = await handle.createWritable();
    await writable.write(body);
    await writable.close();
    return "saved";
  } catch (error) {
    if (isAbortError(error)) {
      return "cancelled";
    }
    downloadJsonDocument(body, "rig.json");
    return "download";
  }
}

function downloadJsonDocument(body: string, fileName: string) {
  const blob = new Blob([body], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeFileStem(value: string): string {
  const stem = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  return stem || "rig";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}

interface SaveFileHandle {
  createWritable(): Promise<SaveFileWritable>;
}

interface SaveFileWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<SaveFileHandle>;

function openDraftDb(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("IndexedDB is not available"));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RIG_DRAFT_DB_NAME, RIG_DRAFT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RIG_DRAFT_STORE)) {
        db.createObjectStore(RIG_DRAFT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
    request.onblocked = () => reject(new Error("IndexedDB open was blocked"));
  });
}

async function saveDraftToIndexedDb(rig: RigDocument): Promise<void> {
  const db = await openDraftDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(RIG_DRAFT_STORE, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write aborted"));
      transaction.objectStore(RIG_DRAFT_STORE).put({ rig, updatedAt: new Date().toISOString() }, RIG_DRAFT_ID);
    });
  } finally {
    db.close();
  }
}

async function loadDraftFromIndexedDb(): Promise<unknown> {
  const db = await openDraftDb();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      let draft: unknown;
      const transaction = db.transaction(RIG_DRAFT_STORE, "readonly");
      transaction.oncomplete = () => resolve(draft);
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB read failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB read aborted"));
      const request = transaction.objectStore(RIG_DRAFT_STORE).get(RIG_DRAFT_ID);
      request.onsuccess = () => {
        const value = request.result as unknown;
        draft = typeof value === "object" && value !== null && "rig" in value ? (value as { rig?: unknown }).rig : value;
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB get failed"));
    });
  } finally {
    db.close();
  }
}

function saveDraftManifest(manifest: { storage: "indexeddb"; updatedAt: string; bytes: number; name: string }) {
  try {
    localStorage.setItem(RIG_DRAFT_STORAGE_KEY, JSON.stringify(manifest));
  } catch (_error) {
    // The manifest is only a hint; IndexedDB remains the source of truth.
  }
}

function clearLocalDraft() {
  try {
    localStorage.removeItem(RIG_DRAFT_STORAGE_KEY);
  } catch (_error) {
    // Ignore storage access errors and continue with IndexedDB.
  }
}

function getLocalDraft(): string | undefined {
  try {
    return localStorage.getItem(RIG_DRAFT_STORAGE_KEY) ?? undefined;
  } catch (_error) {
    return undefined;
  }
}


function byteSize(value: string): number {
  return new Blob([value]).size;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch (_jsonError) {
    return String(error);
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown size";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}
