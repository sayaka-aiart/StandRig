import { createArtMeshAlphaSampler, type ArtMeshAlphaSampler } from "@standrig/core/artMeshAsset";
import { decodeDataUrl } from "@standrig/core/assetManifest";
import { normalizeDeformer } from "@standrig/core/deformers";
import { summarizeRig } from "@standrig/core/inspect";
import { migrateRigDocument } from "@standrig/core/migration";
import { evaluateModelFreezeReadiness } from "@standrig/core/modelFreeze";
import { auditModelingRig } from "@standrig/core/modelingAudit";
import { executeModelingOperation, type ModelingOperation } from "@standrig/core/modelingOps";
import { parameterDefinitionsForRig } from "@standrig/core/parameters";
import { mouthPhonemeTargetsForRig } from "@standrig/core/phonemes";
import { runPhysicsTemporalQa } from "@standrig/core/physicsQa";
import { auditPhysicsSafety } from "@standrig/core/physicsSafety";
import { runPhysicsSettlingQa } from "@standrig/core/physicsSettlingQa";
import { decodePng } from "@standrig/core/png";
import { ensureRigTracking, normalizeTracking } from "@standrig/core/tracking";
import type { ParameterBinding, ParameterValues, RigDeformer, RigDocument, RigPart, RigTracking, RigWarpPin, TrackingInputValues, TransformProperty } from "@standrig/core/types";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
export function sanitizeRigAssetPayload(rig: RigDocument): RigDocument {
    const sanitized = structuredClone(rig);
    for (const asset of sanitized.assets)
        if (asset.src.startsWith("data:"))
            asset.src = `asset://${asset.id}`;
    return sanitized;
}
export function fullRigRevision(rig: RigDocument): string { return 'rig-sha256-' + createHash('sha256').update(JSON.stringify(rig)).digest('hex'); }
export interface ServerTransactionJournalEntry {
    id: string;
    appliedAt: string;
    revisionBefore: string;
    revisionAfter: string;
    operationIds: string[];
}
export interface ArtMeshSamplerLoadResult {
    samplers: Map<string, ArtMeshAlphaSampler>;
    requiredAssetIds: string[];
    loadedAssetIds: string[];
    skipped: Array<{
        assetId: string;
        reason: string;
    }>;
}
export function operationTargetsPart(part: RigPart, operation: ModelingOperation): boolean {
    const target = operation.target;
    if (!target.partIds?.length && !target.roles?.length)
        return false;
    if (target.partIds?.length && !target.partIds.includes(part.id))
        return false;
    if (target.roles?.length && (part.roleStatus !== "confirmed" || !part.role || !target.roles.includes(part.role)))
        return false;
    return true;
}
export async function loadArtMeshAlphaSamplers(rig: RigDocument, publicDir: string, operations: ModelingOperation[]): Promise<ArtMeshSamplerLoadResult> {
    const alphaOperations = operations.filter((operation) => (operation.action.type === "artmesh-generate" || operation.action.type === "artmesh-rebuild") && (operation.action.topology ?? "rect-grid") === "alpha-contour");
    const requiredAssetIds = [...new Set(rig.parts
            .filter((part) => part.assetId && alphaOperations.some((operation) => operationTargetsPart(part, operation)))
            .map((part) => part.assetId!))];
    const samplers = new Map<string, ArtMeshAlphaSampler>();
    const loadedAssetIds: string[] = [];
    const skipped: Array<{
        assetId: string;
        reason: string;
    }> = [];
    for (const assetId of requiredAssetIds) {
        const asset = rig.assets.find((entry) => entry.id === assetId);
        if (!asset) {
            skipped.push({ assetId, reason: "missing-asset" });
            continue;
        }
        try {
            const embedded = decodeDataUrl(asset.src);
            let bytes: Uint8Array;
            let mediaType = embedded?.mediaType ?? "";
            if (embedded)
                bytes = embedded.bytes;
            else {
                if (/^https?:\/\//i.test(asset.src))
                    throw new Error("remote-asset-unsupported");
                const assetPath = path.resolve(publicDir, asset.src.replace(/^\/+/, ""));
                if (assetPath !== publicDir && !assetPath.startsWith(publicDir + path.sep))
                    throw new Error("asset-path-escaped-public-directory");
                bytes = new Uint8Array(await readFile(assetPath));
                mediaType = path.extname(assetPath).toLowerCase() === ".png" ? "image/png" : "";
            }
            if (mediaType !== "image/png")
                throw new Error("unsupported-media-type:" + (mediaType || "unknown"));
            const image = decodePng(bytes);
            samplers.set(asset.id, createArtMeshAlphaSampler(asset, image));
            loadedAssetIds.push(asset.id);
        }
        catch (error) {
            skipped.push({ assetId, reason: "load-failed:" + String(error) });
        }
    }
    return { samplers, requiredAssetIds, loadedAssetIds, skipped };
}
export function modelingOperationGateIssues(operations: ModelingOperation[], operationResults: ReturnType<typeof executeModelingOperation>[]) {
    const issues: Array<{
        operationId: string;
        partId: string;
        reason: string;
    }> = [];
    operations.forEach((operation, index) => {
        const result = operationResults[index];
        if (!result)
            return;
        const matched = new Set(result.matchedPartIds);
        if (operation.action.type === "role-confirm" || operation.action.type === "role-reclassify") {
            if (!result.matchedPartIds.length) {
                issues.push({ operationId: operation.id, partId: operation.target.partIds?.[0] ?? "unknown", reason: "no-matching-parts" });
                return;
            }
            for (const skipped of result.skipped) {
                if (matched.has(skipped.partId))
                    issues.push({ operationId: operation.id, partId: skipped.partId, reason: skipped.reason });
            }
            return;
        }
        for (const skipped of result.skipped) {
            if (!matched.has(skipped.partId))
                continue;
            if (skipped.reason === "artmesh-exists")
                continue;
            issues.push({ operationId: operation.id, partId: skipped.partId, reason: skipped.reason });
        }
    });
    return issues;
}
export function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body, null, 2));
}
export function readBody(req: import("node:http").IncomingMessage): Promise<string> {
    return readBodyLimited(req, 64 * 1024 * 1024);
}
export function readBodyLimited(req: import("node:http").IncomingMessage, limit: number): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        let size = 0;
        let settled = false;
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
            if (settled)
                return;
            size += Buffer.byteLength(chunk, "utf8");
            if (size > limit) {
                settled = true;
                reject(new Error(`request_body_too_large:${limit}`));
                req.destroy();
                return;
            }
            body += chunk;
        });
        req.on("end", () => { if (!settled) {
            settled = true;
            resolve(body);
        } });
        req.on("error", (error) => { if (!settled) {
            settled = true;
            reject(error);
        } });
    });
}
export function geometryAssistLocalPolicy(req: import("node:http").IncomingMessage): {
    allowed: boolean;
    reason?: string;
} {
    const origin = req.headers.origin;
    if (origin) {
        try {
            const hostname = new URL(origin).hostname.toLowerCase();
            if (!["localhost", "127.0.0.1", "::1"].includes(hostname))
                return { allowed: false, reason: "origin_not_local" };
        }
        catch {
            return { allowed: false, reason: "origin_invalid" };
        }
    }
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
        const client = String(forwarded).split(",")[0].trim().toLowerCase();
        if (!["127.0.0.1", "::1", "localhost"].includes(client))
            return { allowed: false, reason: "forwarded_client_not_local" };
    }
    return { allowed: true };
}
export async function readRigFile(rigPath: string): Promise<RigDocument> {
    return migrateRigDocument(JSON.parse(await readFile(rigPath, "utf8")));
}
export function compactContextForRig(rig: RigDocument, SERVER_TRANSACTION_JOURNAL: ServerTransactionJournalEntry[] = []) {
    const audit = auditModelingRig(rig);
    const physicsSafety = auditPhysicsSafety(rig);
    const physicsSettling = runPhysicsSettlingQa(rig);
    const roles = rig.parts.filter((part) => part.role && part.role !== "unknown").map((part) => ({ id: part.id, name: part.name, role: part.role, status: part.roleStatus ?? "unassigned" }));
    const semanticSource = JSON.stringify({ schemaVersion: rig.schemaVersion, name: rig.name, parts: rig.parts.map((part) => ({ id: part.id, parentId: part.parentId, role: part.role, bindings: part.bindings?.length ?? 0, blendMode: part.blendMode ?? "normal", tint: part.tint ?? null, artMesh: Boolean(part.artMesh), artPaths: (part.artPaths ?? []).map((path) => ({ id: path.id, points: path.points?.length ?? 0, bindings: path.bindings?.length ?? 0, strokeWidth: path.strokeWidth, opacity: path.opacity, enabled: path.enabled })) })), deformers: rig.deformers?.map((deformer) => ({ id: deformer.id, parentId: deformer.parentId, bindings: deformer.bindings?.length ?? 0 })), physics: rig.physics, symmetry: rig.symmetry });
    return {
        semanticHash: fnv1a(semanticSource),
        revision: fullRigRevision(rig),
        summary: summarizeRig(rig),
        modelFreeze: evaluateModelFreezeReadiness(rig),
        unresolvedIssues: audit.issues.filter((issue) => issue.severity === "error" || issue.severity === "warning").slice(0, 24),
        roles,
        physicsQa: runPhysicsTemporalQa(rig),
        physicsSafety: { pass: physicsSafety.pass, rootLockPass: physicsSafety.rootLock.pass, structuralViolations: physicsSafety.rootLock.violations.length, temporalStructuralMotion: physicsSafety.temporal.structuralMotion, chainCount: physicsSafety.chains.length, issues: physicsSafety.issues.slice(0, 12) },
        physicsSettling: { pass: physicsSettling.pass, finite: physicsSettling.finite, chainCount: physicsSettling.chains.length, issues: physicsSettling.issues.slice(0, 12) },
        operationHistory: { scope: "server-memory", available: true, entries: SERVER_TRANSACTION_JOURNAL.slice(-12) },
        assetPayloadPolicy: "no-data-url",
        symmetry: rig.symmetry ? { version: rig.symmetry.version, axis: rig.symmetry.axis, axisU: rig.symmetry.axisU, tolerance: rig.symmetry.tolerance, confidence: rig.symmetry.confidence, protectedPartCount: rig.symmetry.protectedPartIds.length, protectedDeformerCount: rig.symmetry.protectedDeformerIds.length, linkCount: rig.symmetry.links.length } : undefined
    };
}
export function fnv1a(value: string): string { let hash = 0x811c9dc5; for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
} return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`; }
export async function readRigFromRequestOrFile(req: import("node:http").IncomingMessage, rigPath: string): Promise<RigDocument> {
    if (req.method === "POST" || req.method === "PUT") {
        return migrateRigDocument(JSON.parse(await readBody(req)));
    }
    return readRigFile(rigPath);
}
export function mouthPhonemeTargetsWithUrls(rig: RigDocument) {
    return mouthPhonemeTargetsForRig(rig).map((target) => {
        const params = new URLSearchParams({
            detail: "mouth",
            width: "180",
            height: "180",
            padding: "24",
            transparent: "1",
            forceParts: "1",
            partId: target.sourcePartId
        });
        const previewParams = new URLSearchParams();
        const setNumberParam = (queryKey: string, parameterId: string) => {
            const value = target.values[parameterId];
            if (typeof value === "number" && Number.isFinite(value)) {
                params.set(queryKey, String(value));
                previewParams.set(queryKey, String(value));
            }
        };
        setNumberParam("mouthOpen", "ParamMouthOpen");
        setNumberParam("mouthForm", "ParamMouthForm");
        setNumberParam("mouthSmile", "ParamMouthSmile");
        const screenshotUrl = `/api/screenshot?${params.toString()}`;
        const previewQuery = previewParams.toString();
        return {
            ...target,
            screenshotUrl,
            referenceUrl: screenshotUrl,
            previewUrl: previewQuery ? `/preview?${previewQuery}` : "/preview"
        };
    });
}
export async function writeRigFile(rigPath: string, rig: RigDocument) {
    await writeJsonFile(rigPath, rig);
}
export async function writeJsonFile(filePath: string, value: unknown) {
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}
`, "utf8");
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            await rename(tmpPath, filePath);
            return;
        }
        catch (error) {
            if (attempt === 9 || !isRetryableFileReplaceError(error)) {
                throw error;
            }
            await delay(25 * (attempt + 1));
        }
    }
}
export function isRetryableFileReplaceError(error: unknown): boolean {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as {
        code?: unknown;
    }).code : undefined;
    return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function parseJsonObject(raw: string): Record<string, unknown> {
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Request body must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
}
export function deformerRouteId(req: import("node:http").IncomingMessage): string | undefined {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname).replace(/^\/api\/deformers\/?/, "").replace(/^\//, "");
    return pathname || undefined;
}
export function glueCandidateRouteId(req: import("node:http").IncomingMessage): string | undefined {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname).replace(/^\/api\/glue-candidates\/?/, "").replace(/^\//, "");
    return pathname || undefined;
}
export function glueRouteId(req: import("node:http").IncomingMessage): string | undefined {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname).replace(/^\/api\/glue\/?/, "").replace(/^\//, "");
    return pathname || undefined;
}
export function trackingArtifactId(value: unknown, fallback: string): string {
    const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
    const normalized = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
    return normalized || fallback;
}
export function trackingRouteId(req: import("node:http").IncomingMessage, prefix: string): string | undefined {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    const id = pathname.replace(new RegExp(`^${prefix}/?`), "").replace(/^\//, "");
    return id && /^[a-zA-Z0-9_-]+$/.test(id) ? id : undefined;
}
export function assignedPartIdsForDeformer(rig: RigDocument, deformer: RigDeformer): string[] {
    const targetIds = new Set(deformer.targetPartIds ?? []);
    return rig.parts.filter((part) => part.deformerId === deformer.id || targetIds.has(part.id)).map((part) => part.id);
}
export function deformerListItem(rig: RigDocument, deformer: RigDeformer) {
    const assignedPartIds = assignedPartIdsForDeformer(rig, deformer);
    return {
        id: deformer.id,
        name: deformer.name,
        kind: deformer.kind,
        parentId: deformer.parentId,
        visible: deformer.visible,
        origin: deformer.origin,
        targetPartIds: deformer.targetPartIds ?? [],
        assignedPartIds,
        assignedPartCount: assignedPartIds.length,
        tags: deformer.tags ?? [],
        rotationMetadata: deformer.rotationMetadata
    };
}
export function patchDeformer(deformer: RigDeformer, rawPatch: Record<string, unknown>, rig: RigDocument) {
    const patch = (rawPatch.deformer && typeof rawPatch.deformer === "object" && !Array.isArray(rawPatch.deformer)
        ? rawPatch.deformer
        : rawPatch) as Partial<RigDeformer> & {
        origin?: Partial<RigDeformer["origin"]>;
        transform?: Partial<RigDeformer["transform"]>;
    };
    if (patch.id !== undefined && patch.id !== deformer.id) {
        throw new Error("Changing deformer.id through PATCH is not supported.");
    }
    if (typeof patch.name === "string") {
        deformer.name = patch.name;
    }
    if (patch.kind === "group" || patch.kind === "rotate" || patch.kind === "warp") {
        deformer.kind = patch.kind;
    }
    if (patch.parentId === null || typeof patch.parentId === "string") {
        deformer.parentId = patch.parentId;
    }
    if (typeof patch.visible === "boolean") {
        deformer.visible = patch.visible;
    }
    if (typeof patch.locked === "boolean") {
        deformer.locked = patch.locked;
    }
    if (Array.isArray(patch.tags)) {
        deformer.tags = patch.tags.filter((tag): tag is string => typeof tag === "string");
    }
    if (Array.isArray(patch.bindings)) {
        deformer.bindings = patch.bindings;
    }
    if (Array.isArray(patch.targetPartIds)) {
        deformer.targetPartIds = patch.targetPartIds.filter((id): id is string => typeof id === "string");
    }
    if (patch.origin && typeof patch.origin === "object") {
        for (const [key, value] of Object.entries(patch.origin)) {
            if ((key === "x" || key === "y") && typeof value === "number" && Number.isFinite(value)) {
                deformer.origin[key] = value;
            }
        }
    }
    if (patch.transform && typeof patch.transform === "object") {
        for (const [key, value] of Object.entries(patch.transform)) {
            if (typeof value === "number" && Number.isFinite(value) && key in deformer.transform) {
                deformer.transform[key as keyof RigDeformer["transform"]] = value;
            }
        }
    }
    normalizeDeformer(deformer, rig);
}
export function compactCorrespondenceAction(action: ModelingOperation["action"]) {
    if (action.type === "artmesh-binding-key")
        return { type: action.type, parameter: action.parameter, input: action.input, offsetCount: action.offsets.length, interpolation: action.interpolation };
    if (action.type === "artmesh-multi-key")
        return { type: action.type, parameters: action.parameters, inputs: action.inputs, offsetCount: action.offsets.length, interpolation: action.interpolation };
    return { type: action.type };
}
export function partRouteId(req: import("node:http").IncomingMessage): string | undefined {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname).replace(/^\/api\/parts\/?/, "").replace(/^\//, "");
    return pathname || undefined;
}
export function partListItem(part: RigPart) {
    return {
        id: part.id,
        name: part.name,
        kind: part.kind,
        parentId: part.parentId,
        visible: part.visible,
        drawOrder: part.drawOrder,
        assetId: part.assetId,
        deformerId: part.deformerId ?? null,
        blendMode: part.blendMode ?? "normal",
        tint: part.tint ?? null,
        clip: part.clip ?? null,
        tags: part.tags ?? []
    };
}
export function patchPart(part: RigPart, rawPatch: Record<string, unknown>) {
    const patch = (rawPatch.part && typeof rawPatch.part === "object" && !Array.isArray(rawPatch.part)
        ? rawPatch.part
        : rawPatch) as Partial<RigPart> & {
        transform?: Partial<RigPart["transform"]>;
    };
    if (patch.id !== undefined && patch.id !== part.id) {
        throw new Error("Changing part.id through PATCH is not supported.");
    }
    if (patch.kind !== undefined && patch.kind !== part.kind) {
        throw new Error("Changing part.kind through PATCH is not supported.");
    }
    if (patch.assetId !== undefined && patch.assetId !== part.assetId) {
        throw new Error("Changing part.assetId through PATCH is not supported.");
    }
    if (typeof patch.name === "string") {
        part.name = patch.name;
    }
    if (patch.parentId === null || typeof patch.parentId === "string") {
        part.parentId = patch.parentId;
    }
    if (patch.deformerId === null || typeof patch.deformerId === "string") {
        part.deformerId = patch.deformerId;
    }
    if (patch.blendMode !== undefined) {
        if (patch.blendMode === "multiply" || patch.blendMode === "screen" || patch.blendMode === "additive") {
            part.blendMode = patch.blendMode;
        }
        else if (patch.blendMode === "normal") {
            delete part.blendMode;
        }
        else {
            throw new Error("blendMode must be normal, multiply, screen, or additive.");
        }
    }
    const rawTint = (patch as {
        tint?: unknown;
    }).tint;
    if (rawTint !== undefined) {
        if (rawTint === null)
            delete part.tint;
        else if (typeof rawTint === "object" && !Array.isArray(rawTint)) {
            const tint = rawTint as RigPart["tint"];
            if (!tint || (tint.mode !== "multiply" && tint.mode !== "screen") || typeof tint.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(tint.color) || !Number.isFinite(tint.opacity) || tint.opacity < 0 || tint.opacity > 1)
                throw new Error("tint must contain mode, #RRGGBB color, and opacity 0..1.");
            part.tint = { mode: tint.mode, color: tint.color.toLowerCase(), opacity: tint.opacity };
        }
        else
            throw new Error("tint must be null or an object.");
    }
    const rawClip = (patch as {
        clip?: unknown;
    }).clip;
    if (rawClip !== undefined) {
        if (rawClip === null) {
            delete part.clip;
        }
        else if (typeof rawClip === "object" && !Array.isArray(rawClip)) {
            const clip = rawClip as {
                mode?: unknown;
                maskPartId?: unknown;
                maskPartIds?: unknown;
                maskOpacity?: unknown;
            };
            const hasSingleSource = typeof clip.maskPartId === "string" && clip.maskPartId.trim().length > 0;
            const rawMaskPartIds = Array.isArray(clip.maskPartIds) ? clip.maskPartIds : clip.maskPartIds === undefined ? undefined : null;
            const hasArraySource = rawMaskPartIds !== undefined;
            const validMultipleSources = Array.isArray(rawMaskPartIds) && rawMaskPartIds.length >= 1 && rawMaskPartIds.length <= 8 && rawMaskPartIds.every((id): id is string => typeof id === "string" && id.trim().length > 0 && id === id.trim()) && new Set(rawMaskPartIds).size === rawMaskPartIds.length;
            const maskPartIds = validMultipleSources ? rawMaskPartIds : undefined;
            const validMaskOpacity = clip.maskOpacity === undefined || clip.maskOpacity === "rendered" || clip.maskOpacity === "ignore";
            if (clip.mode !== "alpha" || hasSingleSource === hasArraySource || (hasArraySource && !validMultipleSources) || !validMaskOpacity) {
                throw new Error("clip must use exactly one of maskPartId or 1-8 unique trimmed maskPartIds; maskOpacity is rendered or ignore.");
            }
            if (hasSingleSource) {
                part.clip = { mode: "alpha", maskPartId: clip.maskPartId as string, ...(clip.maskOpacity ? { maskOpacity: clip.maskOpacity as "rendered" | "ignore" } : {}) };
            }
            else {
                part.clip = { mode: "alpha", maskPartIds: maskPartIds!.map((id) => id), ...(clip.maskOpacity ? { maskOpacity: clip.maskOpacity as "rendered" | "ignore" } : {}) };
            }
        }
        else {
            throw new Error("clip must be { mode: 'alpha', maskPartId | maskPartIds } or null.");
        }
    }
    if (typeof patch.visible === "boolean") {
        part.visible = patch.visible;
    }
    if (typeof patch.locked === "boolean") {
        part.locked = patch.locked;
    }
    if (typeof patch.drawOrder === "number" && Number.isFinite(patch.drawOrder)) {
        part.drawOrder = patch.drawOrder;
    }
    if (Array.isArray(patch.tags)) {
        part.tags = patch.tags.filter((tag): tag is string => typeof tag === "string");
    }
    if (Array.isArray(patch.bindings)) {
        part.bindings = patch.bindings;
    }
    if (patch.transform && typeof patch.transform === "object") {
        for (const [key, value] of Object.entries(patch.transform)) {
            if (typeof value === "number" && Number.isFinite(value) && key in part.transform) {
                part.transform[key as keyof RigPart["transform"]] = value;
            }
        }
    }
}
export function trackingPatchFromBody(body: Record<string, unknown>, rig: RigDocument): RigTracking {
    const current = ensureRigTracking(rig);
    const source = body.tracking && typeof body.tracking === "object" && !Array.isArray(body.tracking) ? (body.tracking as Record<string, unknown>) : body;
    return normalizeTracking({
        ...current,
        ...source,
        mappings: Array.isArray(source.mappings) ? (source.mappings as RigTracking["mappings"]) : current.mappings
    } as RigTracking, rig);
}
export function trackingInputFromBody(body: Record<string, unknown>): Partial<TrackingInputValues> {
    const source = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : body;
    const values: Partial<TrackingInputValues> = {};
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value)) {
            values[key] = value;
        }
    }
    return values;
}
export function parameterPatchFromBody(body: Record<string, unknown>): Partial<ParameterValues> {
    const source = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : body;
    const values: Partial<ParameterValues> = {};
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value)) {
            values[key] = value;
        }
    }
    return values;
}
export const PART_KEY_PROPERTIES = new Set<string>(["x", "y", "rotation", "scaleX", "scaleY", "opacity"]);
export function isPartKeyProperty(value: unknown): value is TransformProperty {
    return typeof value === "string" && PART_KEY_PROPERTIES.has(value);
}
export function neutralPartKeyValue(property: TransformProperty): number {
    return property === "scaleX" || property === "scaleY" || property === "opacity" ? 1 : 0;
}
export function ensurePartModelingBinding(part: RigPart, parameter: string, property: TransformProperty, rig: RigDocument, options: {
    additive?: boolean;
    interpolation?: ParameterBinding["interpolation"];
} = {}): ParameterBinding {
    part.bindings ??= [];
    const existing = part.bindings.find((binding) => binding.parameter === parameter && binding.property === property);
    if (existing) {
        existing.keys ??= [];
        if (typeof options.additive === "boolean") {
            existing.additive = options.additive;
        }
        if (options.interpolation) {
            existing.interpolation = options.interpolation;
        }
        return existing;
    }
    const definition = parameterDefinitionsForRig(rig).find((entry) => entry.id === parameter);
    const binding: ParameterBinding = {
        parameter,
        property,
        additive: options.additive ?? true,
        interpolation: options.interpolation ?? "smoothstep",
        keys: [{ input: definition?.default ?? 0, value: 0 }]
    };
    part.bindings.push(binding);
    return binding;
}
export function upsertModelingBindingKey(binding: ParameterBinding, input: number, value: number) {
    binding.keys ??= [];
    const existing = binding.keys.find((key) => Math.abs(key.input - input) < 0.0001);
    if (existing) {
        existing.input = input;
        existing.value = value;
    }
    else {
        binding.keys.push({ input, value });
    }
    binding.keys.sort((left, right) => left.input - right.input);
}
export function modelingPartKeySummary(part: RigPart) {
    return {
        id: part.id,
        name: part.name,
        kind: part.kind,
        bindingCount: part.bindings?.length ?? 0,
        bindings: part.bindings ?? []
    };
}
export function modelingInterpolation(value: unknown): ParameterBinding["interpolation"] | undefined {
    return value === "linear" || value === "smoothstep" || value === "hold" || value === "arc" || value === "curve" ? value : undefined;
}
export function warpPinMirrorAction(value: unknown): "link" | "apply" | "unlink" | undefined {
    return value === "link" || value === "apply" || value === "unlink" ? value : undefined;
}
export function resolveWarpPinIndexForApi(pins: RigWarpPin[], pinIdOrIndex: unknown): number {
    const pinIndex = typeof pinIdOrIndex === "number"
        ? pinIdOrIndex
        : typeof pinIdOrIndex === "string"
            ? pins.findIndex((pin) => pin.id === pinIdOrIndex)
            : -1;
    return Number.isInteger(pinIndex) && pinIndex >= 0 && pinIndex < pins.length ? pinIndex : -1;
}
