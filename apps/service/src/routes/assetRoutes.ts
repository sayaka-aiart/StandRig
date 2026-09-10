import { deriveAlphaBleedAssets, type AlphaBleedAssetRequest } from "@standrig/core/alphaBleed";
import { ASSET_MANIFEST_FORMAT, decodeDataUrl, diagnoseRigAssets, externalizeRigAssets, type RigAssetManifest } from "@standrig/core/assetManifest";
import { runExposureSweep, type ExposureSweepRequest } from "@standrig/core/exposureQa";
import { createGenerationRequest, deletePersistedGeneratedAsset, evaluateGenerationAsset, getGenerationRequest, listGenerationRequests, listPersistedGeneratedAssets, persistAcceptedGeneration, regenerateGenerationRequest, type GenerationAcceptanceInput, type GenerationRequestInput } from "@standrig/core/generationRequests";
import { validateRig } from "@standrig/core/inspect";
import { migrateRigDocument } from "@standrig/core/migration";
import { deriveShadowSeparationAssets, type ShadowSeparationAssetRequest } from "@standrig/core/shadowSeparation";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelingContext } from '../application/context.js';
import { fullRigRevision, parseJsonObject, readBody, readRigFile, sanitizeRigAssetPayload, sendJson, writeJsonFile, writeRigFile } from '../application/modelingSupport.js';
import type { ApiHost } from "../host.js";
export function assetRoutes(ctx: ModelingContext, server: ApiHost) {
    const { publicDir, rigPath, schemaPath, trackingProfilePath, trackingRecordingsDir, trackingRunsDir, assetManifestPath, assetsDir, goldenRoot, journal: SERVER_TRANSACTION_JOURNAL, readTrackingProfileFile } = ctx;
    server.middlewares.use("/api/assets/externalize", async (req, res) => {
        try {
            if (req.method === "GET") {
                const rig = await readRigFile(rigPath);
                const manifestRaw = await readFile(assetManifestPath, "utf8").catch(() => undefined);
                const manifest = manifestRaw ? JSON.parse(manifestRaw) : undefined;
                sendJson(res, 200, { ok: true, diagnostics: diagnoseRigAssets(rig, manifest), manifest });
                return;
            }
            if (req.method !== "POST" && req.method !== "PUT") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const body = parseJsonObject(await readBody(req));
            const sourceRig = migrateRigDocument(body.rig ?? body);
            const dryRun = body.dryRun !== false;
            const externalized = await externalizeRigAssets(sourceRig, "/assets");
            const validation = validateRig(externalized.rig);
            const originalBytes = Buffer.byteLength(JSON.stringify(sourceRig));
            const rigBytes = Buffer.byteLength(JSON.stringify(externalized.rig));
            const summary = { assetEntries: externalized.manifest.entries.length, uniqueFiles: externalized.files.size, originalBytes, rigBytes, savedBytes: Math.max(0, originalBytes - rigBytes) };
            if (!validation.ok) {
                sendJson(res, 400, { ok: false, error: "externalized rig is invalid", validation, summary });
                return;
            }
            if (!dryRun) {
                await mkdir(assetsDir, { recursive: true });
                for (const [assetUrl, bytes] of externalized.files) {
                    const destination = path.resolve(publicDir, assetUrl.replace(/^\/+/, ""));
                    if (destination !== assetsDir && !destination.startsWith(assetsDir + path.sep))
                        throw new Error("Asset path escaped public/assets");
                    await writeFile(destination, bytes);
                }
                await writeJsonFile(assetManifestPath, externalized.manifest);
                await writeRigFile(rigPath, externalized.rig);
            }
            sendJson(res, 200, { ok: true, dryRun, summary, manifest: externalized.manifest, rig: externalized.rig, diagnostics: diagnoseRigAssets(externalized.rig, externalized.manifest) });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/assets/alpha-bleed", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req)) as AlphaBleedAssetRequest & {
                dryRun?: boolean;
            };
            const dryRun = body.dryRun !== false;
            const rig = await readRigFile(rigPath);
            const result = await deriveAlphaBleedAssets(rig, body, async (asset) => {
                const embedded = decodeDataUrl(asset.src);
                if (embedded)
                    return embedded;
                const sourcePath = path.resolve(publicDir, asset.src.replace(/^\/+/, ""));
                if (sourcePath !== publicDir && !sourcePath.startsWith(publicDir + path.sep))
                    throw new Error(`Asset path escaped public directory: ${asset.id}`);
                const mediaType = path.extname(sourcePath).toLowerCase() === ".png" ? "image/png" : "application/octet-stream";
                return { mediaType, bytes: new Uint8Array(await readFile(sourcePath)) };
            });
            const existingManifest = await readFile(assetManifestPath, "utf8")
                .then((raw) => JSON.parse(raw) as RigAssetManifest)
                .catch(() => ({ format: ASSET_MANIFEST_FORMAT, version: 1 as const, entries: [] }));
            const manifestByAsset = new Map(existingManifest.entries.map((entry) => [entry.assetId, entry]));
            for (const entry of result.manifestEntries)
                manifestByAsset.set(entry.assetId, entry);
            const manifest: RigAssetManifest = { format: ASSET_MANIFEST_FORMAT, version: 1, entries: [...manifestByAsset.values()] };
            const validation = validateRig(result.rig);
            if (!validation.ok) {
                sendJson(res, 400, { ok: false, error: "alpha-bleed candidate rig is invalid", validation, assets: result.assets, skipped: result.skipped });
                return;
            }
            if (!dryRun && result.changed) {
                await mkdir(assetsDir, { recursive: true });
                for (const [assetUrl, bytes] of result.files) {
                    const destination = path.resolve(publicDir, assetUrl.replace(/^\/+/, ""));
                    if (destination !== assetsDir && !destination.startsWith(assetsDir + path.sep))
                        throw new Error("Alpha bleed asset path escaped public/assets");
                    await writeFile(destination, bytes);
                }
                await writeJsonFile(assetManifestPath, manifest);
                await writeRigFile(rigPath, result.rig);
                server.ws.send({ type: "full-reload" });
            }
            sendJson(res, 200, {
                ok: true,
                dryRun,
                changed: result.changed,
                scope: body.assetIds?.length ? "assetIds" : body.partIds?.length ? "partIds" : body.scope ?? "artmesh",
                summary: {
                    processedAssets: result.assets.length,
                    skippedAssets: result.skipped.length,
                    rewiredParts: result.assets.reduce((total, entry) => total + entry.rewiredPartIds.length, 0),
                    changedPixels: result.assets.reduce((total, entry) => total + entry.audit.changedPixelCount, 0),
                    outputBytes: [...result.files.values()].reduce((total, bytes) => total + bytes.byteLength, 0)
                },
                assets: result.assets,
                skipped: result.skipped,
                manifestEntries: result.manifestEntries,
                validation,
                rig: sanitizeRigAssetPayload(result.rig)
            });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/assets/shadow-separation", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req)) as ShadowSeparationAssetRequest & {
                dryRun?: boolean;
                expectedRevision?: string;
            };
            const dryRun = body.dryRun !== false;
            const rig = await readRigFile(rigPath);
            const currentRevision = fullRigRevision(rig);
            if (body.expectedRevision && body.expectedRevision !== currentRevision) {
                sendJson(res, 409, { ok: false, error: "revision-mismatch", expectedRevision: body.expectedRevision, currentRevision });
                return;
            }
            if (!dryRun && !body.expectedRevision) {
                sendJson(res, 400, { ok: false, error: "expectedRevision is required for shadow-separation commit" });
                return;
            }
            const result = await deriveShadowSeparationAssets(rig, body, async (asset) => {
                const embedded = decodeDataUrl(asset.src);
                if (embedded)
                    return embedded;
                const sourcePath = path.resolve(publicDir, asset.src.replace(/^\/+/, ""));
                if (sourcePath !== publicDir && !sourcePath.startsWith(publicDir + path.sep))
                    throw new Error(`Asset path escaped public directory: ${asset.id}`);
                const mediaType = path.extname(sourcePath).toLowerCase() === ".png" ? "image/png" : "application/octet-stream";
                return { mediaType, bytes: new Uint8Array(await readFile(sourcePath)) };
            });
            const shadowQa = {
                ok: result.assets.length > 0 && result.assets.every((entry) => entry.audit.reconstructionPass && entry.audit.alphaChangedPixelCount === 0),
                entries: result.assets.map((entry) => ({ sourceAssetId: entry.sourceAssetId, neutralAssetId: entry.neutralAssetId, shadowAssetId: entry.shadowAssetId, audit: entry.audit }))
            };
            const validation = validateRig(result.rig);
            if (!validation.ok || !shadowQa.ok) {
                sendJson(res, 400, { ok: false, error: !validation.ok ? "shadow-separation candidate rig is invalid" : "shadow-separation reconstruction gate failed", validation, shadowQa, assets: result.assets, skipped: result.skipped, rig: sanitizeRigAssetPayload(result.rig) });
                return;
            }
            const existingManifest = await readFile(assetManifestPath, "utf8")
                .then((raw) => JSON.parse(raw) as RigAssetManifest)
                .catch(() => ({ format: ASSET_MANIFEST_FORMAT, version: 1 as const, entries: [] }));
            const manifestByAsset = new Map(existingManifest.entries.map((entry) => [entry.assetId, entry]));
            for (const entry of result.manifestEntries)
                manifestByAsset.set(entry.assetId, entry);
            const manifest: RigAssetManifest = { format: ASSET_MANIFEST_FORMAT, version: 1, entries: [...manifestByAsset.values()] };
            if (!dryRun && result.changed) {
                await mkdir(assetsDir, { recursive: true });
                for (const [assetUrl, bytes] of result.files) {
                    const destination = path.resolve(publicDir, assetUrl.replace(/^\/+/, ""));
                    if (destination !== assetsDir && !destination.startsWith(assetsDir + path.sep))
                        throw new Error("Shadow separation asset path escaped public/assets");
                    await writeFile(destination, bytes);
                }
                await writeJsonFile(assetManifestPath, manifest);
                await writeRigFile(rigPath, result.rig);
                server.ws.send({ type: "full-reload" });
            }
            sendJson(res, 200, {
                ok: true,
                dryRun,
                changed: result.changed,
                expectedRevision: body.expectedRevision ?? currentRevision,
                currentRevision,
                summary: {
                    processedAssets: result.assets.length,
                    skippedAssets: result.skipped.length,
                    rewiredParts: result.assets.reduce((total, entry) => total + entry.rewiredPartIds.length, 0),
                    shadowParts: result.assets.reduce((total, entry) => total + entry.shadowPartIds.length, 0),
                    outputBytes: [...result.files.values()].reduce((total, bytes) => total + bytes.byteLength, 0)
                },
                shadowQa,
                assets: result.assets,
                skipped: result.skipped,
                manifestEntries: result.manifestEntries,
                validation,
                rig: sanitizeRigAssetPayload(result.rig)
            });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/generation/requests/from-exposure", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req)) as ExposureSweepRequest & {
                role?: string;
                prompt?: string;
                targetWidth?: number;
                targetHeight?: number;
                maxRequests?: number;
            };
            const rig = await readRigFile(rigPath);
            const revision = fullRigRevision(rig);
            const exposure = await runExposureSweep(rig, publicDir, body);
            const maxRequests = Math.max(1, Math.min(32, Math.round(Number(body.maxRequests) || 8)));
            const requests = [];
            for (const entry of exposure.suspect.slice(0, maxRequests)) {
                const request = await createGenerationRequest(rig, publicDir, revision, {
                    role: body.role ?? entry.region,
                    region: entry.region,
                    prompt: body.prompt ?? "inpaint exposed " + entry.region + " while preserving the source style",
                    targetWidth: body.targetWidth,
                    targetHeight: body.targetHeight,
                    provenance: {
                        trigger: "exposure-qa",
                        sweepRevision: revision,
                        poseId: entry.poseId,
                        exposedPixels: entry.exposedPixels,
                        exposedRatio: entry.exposedRatio,
                        lostPixels: entry.lostPixels,
                        exposedBBox: entry.exposedBBox ?? null
                    }
                });
                requests.push(request);
            }
            sendJson(res, 201, { ok: true, revision, exposure: { ok: exposure.ok, summary: exposure.summary, suspect: exposure.suspect }, requests, capped: exposure.suspect.length > requests.length });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/generation/requests", async (req, res) => {
        try {
            const requestUrl = new URL(req.url ?? "/", "http://localhost");
            const requestId = decodeURIComponent(requestUrl.pathname.replace(/^\/+/, ""));
            if (req.method === "GET") {
                if (requestId) {
                    const request = getGenerationRequest(requestId);
                    if (!request) {
                        sendJson(res, 404, { ok: false, error: "generation request not found" });
                        return;
                    }
                    sendJson(res, 200, { ok: true, request });
                    return;
                }
                sendJson(res, 200, { ok: true, requests: listGenerationRequests() });
                return;
            }
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use GET or POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req)) as GenerationRequestInput;
            const rig = await readRigFile(rigPath);
            const request = await createGenerationRequest(rig, publicDir, fullRigRevision(rig), body);
            sendJson(res, 201, { ok: true, request });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/generation/accept", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req)) as unknown as GenerationAcceptanceInput;
            const rig = await readRigFile(rigPath);
            const result = await evaluateGenerationAsset(rig, publicDir, fullRigRevision(rig), body);
            let commit: {
                manifestPath: string;
                provenancePath: string;
            } | undefined;
            if (result.accepted && result.requestedCommit)
                commit = await persistAcceptedGeneration(publicDir, result);
            const { bytes, ...safeResult } = result;
            sendJson(res, 200, { ...safeResult, committed: Boolean(commit), commit });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/generation/assets", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
                return;
            }
            const listing = await listPersistedGeneratedAssets(publicDir);
            const active = listing.entries.filter((entry) => entry.status !== "deleted");
            sendJson(res, 200, { ok: true, assets: active, historyCount: listing.entries.length });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/generation/regenerate", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req)) as {
                assetId?: string;
                requestId?: string;
                prompt?: string;
                provenance?: Record<string, unknown>;
                acceptance?: Record<string, unknown>;
                targetWidth?: number;
                targetHeight?: number;
            };
            if (!body.assetId && !body.requestId) {
                sendJson(res, 400, { ok: false, error: "assetId or requestId is required" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const request = await regenerateGenerationRequest(rig, publicDir, fullRigRevision(rig), body);
            sendJson(res, 201, { ok: true, request, lineage: { parentAssetId: body.assetId ?? null, parentRequestId: body.requestId ?? null, generationIndex: request.provenance.generationIndex ?? null } });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/generation/delete", async (req, res) => {
        try {
            if (req.method !== "POST" && req.method !== "DELETE") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST or DELETE" });
                return;
            }
            const requestUrl = new URL(req.url ?? "/", "http://localhost");
            const pathAssetId = decodeURIComponent(requestUrl.pathname.replace(/^\/+/, ""));
            const body = req.method === "POST" ? parseJsonObject(await readBody(req)) as {
                assetId?: string;
                commit?: boolean;
            } : {};
            const assetId = String(body.assetId ?? pathAssetId);
            if (!assetId) {
                sendJson(res, 400, { ok: false, error: "assetId is required" });
                return;
            }
            const result = await deletePersistedGeneratedAsset(publicDir, assetId, body.commit === true);
            sendJson(res, result.ok ? 200 : 404, result);
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
}
