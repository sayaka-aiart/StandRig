import { ensureRigDeformers } from "@standrig/core/deformers";
import { detailRegionDefinitionsForRig } from "@standrig/core/detailRegions";
import { exportGeometryPart, GEOMETRY_EXPORT_LIMITS, geometryExportByteLength, GeometryExportError } from "@standrig/core/geometryExport";
import { exportGeometryPartV11 } from "@standrig/core/geometryExportV11";
import { ensureRigGlue, ensureRigGlueCandidates, glueCandidateListItem, glueListItem, patchGlue, patchGlueCandidate, promoteGlueCandidates } from "@standrig/core/glue";
import { buildGlueVertexPairs } from "@standrig/core/glueVertexCandidates";
import { inspectRig, summarizeRig, validateRig } from "@standrig/core/inspect";
import { migrateRigDocument } from "@standrig/core/migration";
import { auditModelingRig } from "@standrig/core/modelingAudit";
import { parameterDefinitionsForRig, previewParameterValuesForRig, writePreviewParameterValues } from "@standrig/core/parameters";
import { referenceSheetDefinitionsForRig } from "@standrig/core/reference";
import { renderRigScreenshot, screenshotOptionsFromUrl } from "@standrig/core/serverRenderer";
import { readFile } from "node:fs/promises";
import type { ModelingContext } from '../application/context.js';
import { assignedPartIdsForDeformer, compactContextForRig, deformerListItem, deformerRouteId, fullRigRevision, glueCandidateRouteId, glueRouteId, mouthPhonemeTargetsWithUrls, parameterPatchFromBody, parseJsonObject, partListItem, partRouteId, patchDeformer, patchPart, readBody, readRigFile, readRigFromRequestOrFile, sanitizeRigAssetPayload, sendJson, writeRigFile } from '../application/modelingSupport.js';
import type { ApiHost } from "../host.js";
import { portableBundle } from "../portableBundle.js";
export function rigRoutes(ctx: ModelingContext, server: ApiHost) {
    const { publicDir, rigPath, schemaPath, trackingProfilePath, trackingRecordingsDir, trackingRunsDir, assetManifestPath, assetsDir, goldenRoot, journal: SERVER_TRANSACTION_JOURNAL, readTrackingProfileFile } = ctx;
    const sendModelingAudit = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
        try {
            if (req.method !== "GET" && req.method !== "POST" && req.method !== "PUT") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFromRequestOrFile(req, rigPath);
            sendJson(res, 200, { ok: true, audit: auditModelingRig(rig), summary: summarizeRig(rig) });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    };
    server.middlewares.use("/api/health", (_req, res) => {
        sendJson(res, 200, {
            ok: true,
            app: "standrig-modeling-tools",
            version: "0.2.0",
            capabilities: { modeling: true, playback: true, mcp: "separate-stdio-process", tracker: "external", obs: "external-browser-source", live2dBridge: false },
            endpoints: ["/api/health", "/api/schema", "/api/assets/externalize", "/api/assets/alpha-bleed", "/api/assets/shadow-separation", "/api/qa/exposure", "/api/qa/check", "/api/qa/symmetry-angle-x", "/api/qa/symmetry-artmesh-bindings", "/api/generation/requests/from-exposure", "/api/generation/requests", "/api/generation/accept", "/api/generation/assets", "/api/generation/regenerate", "/api/generation/delete", "/api/qa/joins", "/api/qa/failure-image", "/api/changes", "/api/geometry/export", "/api/context", "/api/readiness/calibration", "/api/readiness/l2-qa", "/api/readiness/promotion", "/api/readiness", "/api/rig/summary", "/api/rig/validate", "/api/rig/inspect", "/api/modeling/audit", "/api/audit/modeling", "/api/modeling/symmetry-artmesh-candidates", "/api/modeling/symmetry-artmesh-transaction-dry-run", "/api/modeling/head-proxy/calibrate", "/api/modeling/correspondence", "/api/modeling/physics-safety", "/api/modeling/skinning-candidates", "/api/modeling/skinning-approval", "/api/modeling/head-proxy", "/api/modeling/symmetry", "/api/qa/golden", "/api/modeling/join-transaction", "/api/qa/art-paths", "/api/modeling/art-path-transaction", "/api/modeling/transaction", "/api/modeling/role-suggestions", "/api/modeling/artmesh-presets", "/api/modeling/part-key", "/api/modeling/warp-pin-mirror", "/api/modeling/techniques", "/api/modeling", "/api/reference/sheet", "/api/reference", "/api/phonemes", "/api/screenshot", "/api/glue/vertex-pairs", "/api/glue-candidates", "/api/glue", "/api/parts", "/api/deformers", "/api/bundle", "/api/params", "/api/rig", "/api/sample", "/api/playback", "/api/playback/events", "/api/playback/parameters", "/api/playback/control", "/api/playback/reload", "/api/checkpoints", "/api/checkpoints/restore", "/api/exports/bundle"],
            rigPath
        });
    });
    server.middlewares.use("/api/schema", async (_req, res) => {
        try {
            res.statusCode = 200;
            res.setHeader("content-type", "application/schema+json; charset=utf-8");
            res.end(await readFile(schemaPath, "utf8"));
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/changes", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const requestUrl = new URL(req.url ?? "/api/changes", "http://localhost");
            const since = requestUrl.searchParams.get("since") ?? "";
            const rig = await readRigFile(rigPath);
            const currentRevision = fullRigRevision(rig);
            if (!since || since === currentRevision) {
                sendJson(res, 200, { ok: true, changed: false, currentRevision, since: since || null, transactions: [] });
                return;
            }
            let startIndex = -1;
            for (let index = SERVER_TRANSACTION_JOURNAL.length - 1; index >= 0; index--) {
                if (SERVER_TRANSACTION_JOURNAL[index].revisionBefore === since) {
                    startIndex = index;
                    break;
                }
            }
            if (startIndex < 0) {
                sendJson(res, 200, { ok: true, changed: true, resyncRequired: true, reason: "revision-not-in-server-journal", currentRevision, since, transactions: [] });
                return;
            }
            const transactions = SERVER_TRANSACTION_JOURNAL.slice(startIndex).map((entry) => ({ id: entry.id, appliedAt: entry.appliedAt, revisionBefore: entry.revisionBefore, revisionAfter: entry.revisionAfter, operationIds: entry.operationIds }));
            let cursor = since;
            const contiguous = transactions.every(entry => {
                if (entry.revisionBefore !== cursor)
                    return false;
                cursor = entry.revisionAfter;
                return true;
            });
            if (!contiguous || cursor !== currentRevision) {
                sendJson(res, 200, { ok: true, changed: true, resyncRequired: true, reason: "journal-gap", currentRevision, since, transactions: [] });
                return;
            }
            sendJson(res, 200, { ok: true, changed: transactions.length > 0, resyncRequired: false, currentRevision, since, transactions });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/geometry/export", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method_not_allowed" });
                return;
            }
            const rawUrl = req.url ?? "";
            if (rawUrl.length > GEOMETRY_EXPORT_LIMITS.maxQueryLength) {
                sendJson(res, 400, { ok: false, error: "query_too_long" });
                return;
            }
            const url = new URL(rawUrl || "/api/geometry/export", "http://localhost");
            const keys = [...url.searchParams.keys()];
            const contractValues = url.searchParams.getAll("contractVersion");
            if (keys.length === 0 || (keys.length === 1 && keys[0] === "partId" && !url.searchParams.get("partId"))) {
                sendJson(res, 400, { ok: false, error: "missing_part_id" });
                return;
            }
            if (keys.some((key) => key !== "partId" && key !== "contractVersion") || url.searchParams.getAll("partId").length !== 1 || contractValues.length > 1) {
                sendJson(res, 400, { ok: false, error: "invalid_query" });
                return;
            }
            const requestedVersion = contractValues[0];
            if (requestedVersion !== undefined && !["1", "1.0", "1.1"].includes(requestedVersion)) {
                sendJson(res, 400, { ok: false, error: "unsupported_geometry_export_version" });
                return;
            }
            const useV11 = requestedVersion === "1.1";
            const partId = url.searchParams.get("partId") ?? "";
            if (!partId) {
                sendJson(res, 400, { ok: false, error: "missing_part_id" });
                return;
            }
            if (partId.length > GEOMETRY_EXPORT_LIMITS.maxPartIdLength) {
                sendJson(res, 400, { ok: false, error: "part_id_too_long" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const revision = fullRigRevision(rig);
            const semanticHash = compactContextForRig(rig, SERVER_TRANSACTION_JOURNAL).semanticHash;
            const exported = useV11
                ? exportGeometryPartV11(rig, partId, { revision, semanticHash, exportedAt: new Date().toISOString() })
                : exportGeometryPart(rig, partId, { revision, semanticHash, exportedAt: new Date().toISOString() });
            const response = { ok: true, export: exported };
            const responseLimit = useV11 ? GEOMETRY_EXPORT_LIMITS.maxV11ResponseBytes : GEOMETRY_EXPORT_LIMITS.maxResponseBytes;
            if (geometryExportByteLength(exported) > responseLimit || Buffer.byteLength(JSON.stringify(response), "utf8") > responseLimit) {
                sendJson(res, 413, { ok: false, error: useV11 ? "geometry_export_response_too_large" : "response_too_large" });
                return;
            }
            sendJson(res, 200, response);
        }
        catch (error) {
            if (error instanceof GeometryExportError) {
                const status = error.code === "part_not_found" ? 404 : ["response_too_large", "geometry_export_response_too_large"].includes(error.code) ? 413 : error.code === "revision_unavailable" ? 503 : error.code === "part_has_no_artmesh" ? 422 : 422;
                sendJson(res, status, { ok: false, error: error.code });
                return;
            }
            const requestVersion = new URL(req.url ?? "/api/geometry/export", "http://localhost").searchParams.get("contractVersion");
            sendJson(res, 500, { ok: false, error: requestVersion === "1.1" ? "geometry_export_internal_error" : "export_internal_error" });
        }
    });
    server.middlewares.use("/api/context", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFile(rigPath);
            sendJson(res, 200, { ok: true, context: compactContextForRig(rig, SERVER_TRANSACTION_JOURNAL) });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/rig/summary", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            sendJson(res, 200, { ok: true, summary: summarizeRig(await readRigFile(rigPath)) });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/rig/validate", async (req, res) => {
        try {
            if (req.method !== "GET" && req.method !== "POST" && req.method !== "PUT") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFromRequestOrFile(req, rigPath);
            sendJson(res, 200, { ok: true, validation: validateRig(rig), summary: summarizeRig(rig) });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/rig/inspect", async (req, res) => {
        try {
            if (req.method !== "GET" && req.method !== "POST" && req.method !== "PUT") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            sendJson(res, 200, { ok: true, ...inspectRig(await readRigFromRequestOrFile(req, rigPath)) });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/audit/modeling", sendModelingAudit);
    server.middlewares.use("/api/reference/sheet", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const requestUrl = new URL(req.url ?? "/", "http://localhost/api/reference/sheet");
            if (!requestUrl.searchParams.has("set")) {
                requestUrl.searchParams.set("set", "reference-all");
            }
            const result = await renderRigScreenshot(rig, publicDir, screenshotOptionsFromUrl(rig, requestUrl));
            if (requestUrl.searchParams.get("format") === "json") {
                sendJson(res, 200, {
                    ok: true,
                    set: result.set,
                    detail: result.detail,
                    focusParts: result.focusParts,
                    partIds: result.partIds,
                    forceParts: result.forceParts,
                    width: result.width,
                    height: result.height,
                    parameters: result.parameters,
                    physics: result.physics,
                    physicsTime: result.physicsTime,
                    physicsSteps: result.physicsSteps,
                    supersample: result.supersample,
                    presets: result.presets,
                    dataUrl: `data:image/png;base64,${Buffer.from(result.png).toString("base64")}`
                });
                return;
            }
            res.statusCode = 200;
            res.setHeader("content-type", "image/png");
            res.setHeader("cache-control", "no-store");
            res.setHeader("x-codex-reference-set", result.set);
            if (result.detail) {
                res.setHeader("x-codex-reference-detail", result.detail);
            }
            res.setHeader("x-codex-focus-parts", result.focusParts ? "1" : "0");
            if (result.partIds.length) {
                res.setHeader("x-codex-part-ids", result.partIds.join(","));
            }
            res.setHeader("x-codex-force-parts", result.forceParts ? "1" : "0");
            res.end(Buffer.from(result.png));
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/reference", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const sheets = referenceSheetDefinitionsForRig(rig).map((sheet) => ({
                ...sheet,
                sheetUrl: `/api/reference/sheet?set=${sheet.id}&width=360&height=500`,
                screenshotUrl: `/api/screenshot?set=${sheet.id}&width=360&height=500`
            }));
            const detailRegions = detailRegionDefinitionsForRig(rig).map((region) => ({
                ...region,
                sheetUrl: `/api/reference/sheet?set=reference-all&detail=${region.id}&width=300&height=300`,
                screenshotUrl: `/api/screenshot?set=modeling&detail=${region.id}&width=300&height=300`
            }));
            const phonemeReferences = mouthPhonemeTargetsWithUrls(rig);
            sendJson(res, 200, { ok: true, sheets, detailRegions, phonemeReferences, summary: summarizeRig(rig) });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/phonemes", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const phonemeReferences = mouthPhonemeTargetsWithUrls(rig);
            sendJson(res, 200, { ok: true, phonemeReferences, count: phonemeReferences.length, summary: summarizeRig(rig) });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/screenshot", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const requestUrl = new URL(req.url ?? "/", "http://localhost/api/screenshot");
            const rig = await readRigFile(rigPath);
            const result = await renderRigScreenshot(rig, publicDir, screenshotOptionsFromUrl(rig, requestUrl));
            if (requestUrl.searchParams.get("format") === "json") {
                sendJson(res, 200, {
                    ok: true,
                    width: result.width,
                    height: result.height,
                    set: result.set,
                    detail: result.detail,
                    focusParts: result.focusParts,
                    partIds: result.partIds,
                    forceParts: result.forceParts,
                    parameters: result.parameters,
                    physics: result.physics,
                    physicsTime: result.physicsTime,
                    physicsSteps: result.physicsSteps,
                    supersample: result.supersample,
                    presets: result.presets,
                    dataUrl: `data:image/png;base64,${Buffer.from(result.png).toString("base64")}`
                });
                return;
            }
            const downloadName = requestUrl.searchParams.get("download");
            res.statusCode = 200;
            res.setHeader("content-type", "image/png");
            res.setHeader("x-codex-screenshot-width", String(result.width));
            res.setHeader("x-codex-screenshot-height", String(result.height));
            res.setHeader("x-codex-screenshot-set", result.set);
            if (result.detail) {
                res.setHeader("x-codex-screenshot-detail", result.detail);
            }
            res.setHeader("x-codex-focus-parts", result.focusParts ? "1" : "0");
            if (result.partIds.length) {
                res.setHeader("x-codex-part-ids", result.partIds.join(","));
            }
            res.setHeader("x-codex-force-parts", result.forceParts ? "1" : "0");
            if (downloadName) {
                res.setHeader("content-disposition", `attachment; filename="${downloadName.replace(/[^a-z0-9_.-]/gi, "_")}"`);
            }
            res.end(Buffer.from(result.png));
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/glue/vertex-pairs", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req));
            const rig = await readRigFile(rigPath);
            const partAId = typeof body.partAId === "string" ? body.partAId : "";
            const partBId = typeof body.partBId === "string" ? body.partBId : "";
            if (!partAId || !partBId) {
                sendJson(res, 400, { ok: false, error: "partAId and partBId are required" });
                return;
            }
            const result = buildGlueVertexPairs(rig, {
                partAId,
                partBId,
                maxDistance: typeof body.maxDistance === "number" ? body.maxDistance : undefined,
                weight: typeof body.weight === "number" ? body.weight : undefined,
                maxPairs: typeof body.maxPairs === "number" ? body.maxPairs : undefined
            });
            // Numeric only by default: the point list is what a caller commits, the coordinates are
            // diagnostic and are large enough to be worth opting into.
            const includePoints = body.includePoints === true;
            sendJson(res, 200, {
                ok: result.ok,
                revision: fullRigRevision(rig),
                partAId: result.partAId,
                partBId: result.partBId,
                maxDistance: result.maxDistance,
                weight: result.weight,
                aBoundaryVertices: result.aBoundaryVertices,
                bBoundaryVertices: result.bBoundaryVertices,
                pairCount: result.pairs.length,
                maxPairDistance: result.pairs.reduce((max, pair) => Math.max(max, pair.distance), 0),
                meanPairDistance: result.pairs.length ? result.pairs.reduce((sum, pair) => sum + pair.distance, 0) / result.pairs.length : 0,
                vertexPairs: result.pairs.map((pair) => (includePoints ? pair : { a: pair.a, b: pair.b, weight: pair.weight, restDx: pair.restDx, restDy: pair.restDy })),
                issues: result.issues
            });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/glue-candidates", async (req, res) => {
        try {
            if (req.method !== "GET" && req.method !== "PATCH") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const candidates = ensureRigGlueCandidates(rig);
            const id = glueCandidateRouteId(req);
            if (!id) {
                if (req.method === "GET") {
                    sendJson(res, 200, {
                        ok: true,
                        glueCandidates: candidates.map((candidate) => glueCandidateListItem(rig, candidate)),
                        counts: summarizeRig(rig).counts
                    });
                    return;
                }
                const body = parseJsonObject(await readBody(req));
                const rawCandidates = Array.isArray(body.glueCandidates) ? body.glueCandidates : Array.isArray(body.candidates) ? body.candidates : undefined;
                if (!rawCandidates) {
                    sendJson(res, 400, { ok: false, error: "PATCH body must include glueCandidates array when no candidate id is provided." });
                    return;
                }
                rig.glueCandidates = structuredClone(rawCandidates as typeof candidates);
                ensureRigGlueCandidates(rig);
                const validation = validateRig(rig);
                if (!validation.ok) {
                    sendJson(res, 400, { ok: false, error: "patched glueCandidates are invalid", validation });
                    return;
                }
                await writeRigFile(rigPath, rig);
                sendJson(res, 200, { ok: true, glueCandidates: ensureRigGlueCandidates(rig).map((candidate) => glueCandidateListItem(rig, candidate)), validation, summary: summarizeRig(rig) });
                server.ws.send({ type: "full-reload" });
                return;
            }
            const candidate = candidates.find((entry) => entry.id === id);
            if (!candidate) {
                sendJson(res, 404, { ok: false, error: `glue candidate not found: ${id}` });
                return;
            }
            if (req.method === "GET") {
                sendJson(res, 200, { ok: true, glueCandidate: glueCandidateListItem(rig, candidate), raw: candidate });
                return;
            }
            patchGlueCandidate(candidate, parseJsonObject(await readBody(req)), rig);
            const validation = validateRig(rig);
            if (!validation.ok) {
                sendJson(res, 400, { ok: false, error: "patched glue candidate is invalid", validation });
                return;
            }
            await writeRigFile(rigPath, rig);
            sendJson(res, 200, { ok: true, glueCandidate: glueCandidateListItem(rig, candidate), raw: candidate, validation, summary: summarizeRig(rig) });
            server.ws.send({ type: "full-reload" });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/glue", async (req, res) => {
        try {
            if (req.method !== "GET" && req.method !== "PATCH" && req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const id = glueRouteId(req);
            if (id === "promote") {
                if (req.method !== "POST") {
                    sendJson(res, 405, { ok: false, error: "method not allowed" });
                    return;
                }
                const body = parseJsonObject(await readBody(req));
                const candidateIds = Array.isArray(body.candidateIds)
                    ? body.candidateIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
                    : typeof body.candidateId === "string"
                        ? [body.candidateId]
                        : undefined;
                const mode = body.mode === "seam-debug" || body.mode === "soft-seam" ? body.mode : undefined;
                const result = promoteGlueCandidates(rig, {
                    candidateIds,
                    acceptedOnly: typeof body.acceptedOnly === "boolean" ? body.acceptedOnly : undefined,
                    activate: typeof body.activate === "boolean" ? body.activate : undefined,
                    markAccepted: typeof body.markAccepted === "boolean" ? body.markAccepted : undefined,
                    mode
                });
                const validation = validateRig(rig);
                if (!validation.ok) {
                    sendJson(res, 400, { ok: false, error: "promoted glue is invalid", result, validation });
                    return;
                }
                await writeRigFile(rigPath, rig);
                sendJson(res, 200, {
                    ok: true,
                    result,
                    glue: ensureRigGlue(rig).map((glue) => glueListItem(rig, glue)),
                    glueCandidates: ensureRigGlueCandidates(rig).map((candidate) => glueCandidateListItem(rig, candidate)),
                    validation,
                    summary: summarizeRig(rig)
                });
                server.ws.send({ type: "full-reload" });
                return;
            }
            const glues = ensureRigGlue(rig);
            if (!id) {
                if (req.method === "GET") {
                    sendJson(res, 200, {
                        ok: true,
                        glue: glues.map((glue) => glueListItem(rig, glue)),
                        counts: summarizeRig(rig).counts
                    });
                    return;
                }
                if (req.method !== "PATCH") {
                    sendJson(res, 405, { ok: false, error: "method not allowed" });
                    return;
                }
                const body = parseJsonObject(await readBody(req));
                const rawGlue = Array.isArray(body.glue) ? body.glue : Array.isArray(body.glues) ? body.glues : undefined;
                if (!rawGlue) {
                    sendJson(res, 400, { ok: false, error: "PATCH body must include glue array when no glue id is provided." });
                    return;
                }
                rig.glue = structuredClone(rawGlue as typeof glues);
                ensureRigGlue(rig);
                const validation = validateRig(rig);
                if (!validation.ok) {
                    sendJson(res, 400, { ok: false, error: "patched glue is invalid", validation });
                    return;
                }
                await writeRigFile(rigPath, rig);
                sendJson(res, 200, { ok: true, glue: ensureRigGlue(rig).map((glue) => glueListItem(rig, glue)), validation, summary: summarizeRig(rig) });
                server.ws.send({ type: "full-reload" });
                return;
            }
            const glue = glues.find((entry) => entry.id === id);
            if (!glue) {
                sendJson(res, 404, { ok: false, error: `glue not found: ${id}` });
                return;
            }
            if (req.method === "GET") {
                sendJson(res, 200, { ok: true, glue: glueListItem(rig, glue), raw: glue });
                return;
            }
            if (req.method !== "PATCH") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            patchGlue(glue, parseJsonObject(await readBody(req)), rig);
            const validation = validateRig(rig);
            if (!validation.ok) {
                sendJson(res, 400, { ok: false, error: "patched glue is invalid", validation });
                return;
            }
            await writeRigFile(rigPath, rig);
            sendJson(res, 200, { ok: true, glue: glueListItem(rig, glue), raw: glue, validation, summary: summarizeRig(rig) });
            server.ws.send({ type: "full-reload" });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/parts", async (req, res) => {
        try {
            if (req.method !== "GET" && req.method !== "PATCH") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const id = partRouteId(req);
            if (!id) {
                sendJson(res, 200, {
                    ok: true,
                    parts: rig.parts.map(partListItem),
                    counts: summarizeRig(rig).counts
                });
                return;
            }
            const part = rig.parts.find((entry) => entry.id === id);
            if (!part) {
                sendJson(res, 404, { ok: false, error: `part not found: ${id}` });
                return;
            }
            if (req.method === "GET") {
                sendJson(res, 200, { ok: true, part });
                return;
            }
            patchPart(part, parseJsonObject(await readBody(req)));
            const validation = validateRig(rig);
            if (!validation.ok) {
                sendJson(res, 400, { ok: false, error: "patched rig is invalid", validation });
                return;
            }
            await writeRigFile(rigPath, rig);
            sendJson(res, 200, { ok: true, part, validation, summary: summarizeRig(rig) });
            server.ws.send({ type: "full-reload" });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/deformers", async (req, res) => {
        try {
            if (req.method !== "GET" && req.method !== "PATCH") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const deformers = ensureRigDeformers(rig);
            const id = deformerRouteId(req);
            if (!id) {
                sendJson(res, 200, {
                    ok: true,
                    deformers: deformers.map((deformer) => deformerListItem(rig, deformer)),
                    counts: summarizeRig(rig).counts
                });
                return;
            }
            const deformer = deformers.find((entry) => entry.id === id);
            if (!deformer) {
                sendJson(res, 404, { ok: false, error: `deformer not found: ${id}` });
                return;
            }
            if (req.method === "GET") {
                sendJson(res, 200, { ok: true, deformer, assignedPartIds: assignedPartIdsForDeformer(rig, deformer) });
                return;
            }
            patchDeformer(deformer, parseJsonObject(await readBody(req)), rig);
            const validation = validateRig(rig);
            if (!validation.ok) {
                sendJson(res, 400, { ok: false, error: "patched rig is invalid", validation });
                return;
            }
            await writeRigFile(rigPath, rig);
            sendJson(res, 200, { ok: true, deformer, assignedPartIds: assignedPartIdsForDeformer(rig, deformer), validation, summary: summarizeRig(rig) });
            server.ws.send({ type: "full-reload" });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/bundle", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFile(rigPath);
            sendJson(res, 200, await portableBundle(rig, publicDir));
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/params", async (req, res) => {
        try {
            if (req.method !== "GET" && req.method !== "PATCH") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFile(rigPath);
            if (req.method === "PATCH") {
                writePreviewParameterValues(rig, parameterPatchFromBody(parseJsonObject(await readBody(req))));
                await writeRigFile(rigPath, rig);
                server.ws.send({ type: "full-reload" });
            }
            sendJson(res, 200, {
                ok: true,
                parameters: parameterDefinitionsForRig(rig),
                values: previewParameterValuesForRig(rig),
                summary: summarizeRig(rig)
            });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/rig", async (req, res) => {
        try {
            if (req.method === "GET") {
                const requestUrl = new URL(req.url ?? "/api/rig", "http://localhost");
                const rig = await readRigFile(rigPath);
                sendJson(res, 200, requestUrl.searchParams.get("includeAssets") === "1" ? rig : sanitizeRigAssetPayload(rig));
                return;
            }
            if (req.method === "PUT" || req.method === "POST") {
                const body = await readBody(req);
                const parsed = migrateRigDocument(JSON.parse(body));
                await writeRigFile(rigPath, parsed);
                sendJson(res, 200, { ok: true, rigPath });
                server.ws.send({ type: "full-reload" });
                return;
            }
            sendJson(res, 405, { ok: false, error: "method not allowed" });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
}
