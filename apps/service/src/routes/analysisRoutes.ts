import { runArtPathQa, type ArtPathQaRequest } from "@standrig/core/artPathQa";
import { runExposureSweep, type ExposureSweepRequest } from "@standrig/core/exposureQa";
import { runJoinQa, type JoinQaRequest } from "@standrig/core/joinQa";
import { runL2ReadinessQa } from "@standrig/core/l2ReadinessQa";
import { runQaCheck, type QaCheckRequest } from "@standrig/core/qaCheck";
import { renderQaFailureComparison, type QaFailureImageRequest } from "@standrig/core/qaFailureImage";
import { evaluateRigReadiness, type ReadinessLevel } from "@standrig/core/readiness";
import { calibrateRigReadiness } from "@standrig/core/readinessCalibration";
import { evaluateRecipePromotion } from "@standrig/core/recipePromotion";
import { auditAngleXSymmetry, auditSymmetryArtMeshBindings } from "@standrig/core/symmetryQa";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelingContext } from '../application/context.js';
import { fullRigRevision, parseJsonObject, readBody, readRigFile, sendJson, writeJsonFile } from '../application/modelingSupport.js';
import type { ApiHost } from "../host.js";
export function analysisRoutes(ctx: ModelingContext, server: ApiHost) {
    const { publicDir, rigPath, schemaPath, trackingProfilePath, trackingRecordingsDir, trackingRunsDir, assetManifestPath, assetsDir, goldenRoot, journal: SERVER_TRANSACTION_JOURNAL, readTrackingProfileFile } = ctx;
    server.middlewares.use("/api/qa/exposure", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req)) as ExposureSweepRequest;
            const rig = await readRigFile(rigPath);
            const result = await runExposureSweep(rig, publicDir, body);
            sendJson(res, 200, { ok: result.ok, revision: fullRigRevision(rig), result });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/qa/check", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req)) as QaCheckRequest;
            const rig = await readRigFile(rigPath);
            const result = await runQaCheck(rig, publicDir, body);
            sendJson(res, 200, { ...result, revision: fullRigRevision(rig) });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/qa/symmetry-angle-x", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
                return;
            }
            const current = await readRigFile(rigPath);
            const url = new URL(req.url ?? "/api/qa/symmetry-angle-x", "http://localhost");
            const sample = Number(url.searchParams.get("sample"));
            const tolerance = Number(url.searchParams.get("tolerance"));
            const includePassing = url.searchParams.get("includePassing") === "1";
            const audit = auditAngleXSymmetry(current, {
                sample: Number.isFinite(sample) && sample > 0 ? sample : undefined,
                tolerance: Number.isFinite(tolerance) && tolerance > 0 ? tolerance : undefined,
                includePassing
            });
            sendJson(res, 200, { ok: audit.pass, revision: fullRigRevision(current), audit });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/qa/symmetry-artmesh-bindings", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
                return;
            }
            const current = await readRigFile(rigPath);
            const audit = auditSymmetryArtMeshBindings(current);
            sendJson(res, 200, { ok: true, revision: fullRigRevision(current), audit });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/qa/joins", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req)) as unknown as JoinQaRequest;
            const rig = await readRigFile(rigPath);
            const result = await runJoinQa(rig, publicDir, body);
            sendJson(res, 200, { ok: result.ok, revision: fullRigRevision(rig), result });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/qa/failure-image", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req)) as unknown as QaFailureImageRequest;
            const png = await renderQaFailureComparison(await readRigFile(rigPath), publicDir, body);
            res.statusCode = 200;
            res.setHeader("content-type", "image/png");
            res.setHeader("cache-control", "no-store");
            res.end(Buffer.from(png));
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/readiness/calibration", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
                return;
            }
            const url = new URL(req.url ?? "/api/readiness/calibration", "http://localhost");
            const width = Number(url.searchParams.get("width") ?? 768);
            const height = Number(url.searchParams.get("height") ?? 0);
            const fitPadding = Number(url.searchParams.get("padding") ?? 16);
            const alphaThreshold = Number(url.searchParams.get("alphaThreshold") ?? 8);
            const rig = await readRigFile(rigPath);
            const report = await calibrateRigReadiness(rig, publicDir, {
                width: Number.isFinite(width) ? width : undefined,
                height: Number.isFinite(height) && height > 0 ? height : undefined,
                fitPadding: Number.isFinite(fitPadding) ? fitPadding : undefined,
                alphaThreshold: Number.isFinite(alphaThreshold) ? alphaThreshold : undefined
            });
            sendJson(res, 200, { ok: report.status !== "missing", ready: report.status === "calibrated", revision: fullRigRevision(rig), report });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/readiness/l2-qa", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const report = await runL2ReadinessQa(rig, publicDir);
            sendJson(res, 200, { ok: report.status === "pass", ready: report.status === "pass", revision: fullRigRevision(rig), report });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/readiness/promotion", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const revision = fullRigRevision(rig);
            const readiness = evaluateRigReadiness(rig, { level: "L2" });
            const calibration = await calibrateRigReadiness(rig, publicDir);
            const l2Qa = await runL2ReadinessQa(rig, publicDir);
            const report = evaluateRecipePromotion({
                readiness,
                calibration,
                l2Qa,
                source: { kind: "production-rig", id: `production-rig:${revision}`, fingerprint: revision }
            });
            sendJson(res, 200, { ok: report.status === "eligible", ready: report.status === "eligible", revision, report });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/readiness", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
                return;
            }
            const url = new URL(req.url ?? "/api/readiness", "http://localhost");
            const requested = String(url.searchParams.get("level") ?? "L2").toUpperCase();
            if (requested !== "L1" && requested !== "L2" && requested !== "L3") {
                sendJson(res, 400, { ok: false, error: "level must be L1, L2, or L3" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const report = evaluateRigReadiness(rig, { level: requested as ReadinessLevel });
            sendJson(res, 200, { ok: true, ready: report.requestedLevelReady, revision: fullRigRevision(rig), report });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/qa/golden", async (req, res) => {
        try {
            if (req.method === "GET") {
                const entries = await readFile(path.join(goldenRoot, "index.json"), "utf8").then((raw) => JSON.parse(raw)).catch(() => ({ entries: [] }));
                sendJson(res, 200, { ok: true, entries: Array.isArray(entries.entries) ? entries.entries : [] });
                return;
            }
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req));
            const name = typeof body.name === "string" ? body.name.trim() : "";
            if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
                sendJson(res, 400, { ok: false, error: "name must be 1-64 safe characters" });
                return;
            }
            const action = body.action === "check" ? "check" : body.action === "register" ? "register" : body.action === "propose" ? "propose" : "check";
            const manifestPath = path.join(goldenRoot, name, "manifest.json");
            const qaRequest = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as QaCheckRequest : {};
            if (action === "propose") {
                const expectedRevision = typeof body.expectedRevision === "string" ? body.expectedRevision : "";
                const rig = await readRigFile(rigPath);
                const revision = fullRigRevision(rig);
                if (!expectedRevision) {
                    sendJson(res, 400, { ok: false, action, error: "expectedRevision is required for golden proposal", revision });
                    return;
                }
                if (expectedRevision !== revision) {
                    sendJson(res, 409, { ok: false, action, error: "revision mismatch", revision, expectedRevision });
                    return;
                }
                const qa = await runQaCheck(rig, publicDir, qaRequest);
                if (!qa.ok) {
                    sendJson(res, 422, { ok: false, action, error: "cannot propose a failed QA result", revision, qa: { ok: qa.ok, failed: qa.failed.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues })) } });
                    return;
                }
                const manifest = { format: "standrig-golden", version: 1, name, createdAt: new Date().toISOString(), revision, render: { width: qaRequest.width ?? 240, height: qaRequest.height ?? 240, physics: qaRequest.physics === true }, checks: qa.entries.map((entry) => ({ poseId: entry.poseId, region: entry.region, baselineHash: entry.baselineHash, coverage: entry.coverage, alphaBBox: entry.audit.alphaBBox })) };
                sendJson(res, 200, { ok: true, action, committed: false, dryRun: true, revision, existingManifest: await readFile(manifestPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => undefined), manifest: { ...manifest, checks: manifest.checks.map((entry) => ({ poseId: entry.poseId, region: entry.region, baselineHash: entry.baselineHash })) }, qa: { ok: qa.ok, entryCount: qa.entries.length } });
                return;
            }
            if (action === "register") {
                const expectedRevision = typeof body.expectedRevision === "string" ? body.expectedRevision : "";
                const rig = await readRigFile(rigPath);
                const revision = fullRigRevision(rig);
                if (!expectedRevision) {
                    sendJson(res, 400, { ok: false, action, committed: false, dryRun: false, error: "expectedRevision is required for golden registration", revision });
                    return;
                }
                if (expectedRevision !== revision) {
                    sendJson(res, 409, { ok: false, action, committed: false, dryRun: false, error: "revision mismatch", expectedRevision, revision });
                    return;
                }
                const qa = await runQaCheck(rig, publicDir, qaRequest);
                if (!qa.ok) {
                    sendJson(res, 422, { ok: false, action, committed: false, dryRun: false, error: "cannot register a failed QA result", revision, qa: { ok: qa.ok, failed: qa.failed } });
                    return;
                }
                const latest = await readRigFile(rigPath);
                const latestRevision = fullRigRevision(latest);
                if (latestRevision !== revision) {
                    sendJson(res, 409, { ok: false, action, committed: false, dryRun: false, error: "revision changed during golden registration", revision, currentRevision: latestRevision });
                    return;
                }
                const manifest = { format: "standrig-golden", version: 1, name, createdAt: new Date().toISOString(), revision, render: { width: qaRequest.width ?? 240, height: qaRequest.height ?? 240, physics: qaRequest.physics === true }, checks: qa.entries.map((entry) => ({ poseId: entry.poseId, region: entry.region, baselineHash: entry.baselineHash, coverage: entry.coverage, alphaBBox: entry.audit.alphaBBox })) };
                await mkdir(path.join(goldenRoot, name), { recursive: true });
                await writeJsonFile(manifestPath, manifest);
                const indexPath = path.join(goldenRoot, "index.json");
                const index = await readFile(indexPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => ({ entries: [] }));
                const entries = Array.isArray(index.entries) ? index.entries.filter((entry: {
                    name?: string;
                }) => entry.name !== name) : [];
                entries.push({ name, createdAt: manifest.createdAt, revision: manifest.revision, checkCount: manifest.checks.length });
                await writeJsonFile(indexPath, { format: "standrig-golden-index", version: 1, entries });
                sendJson(res, 200, { ok: true, action, committed: true, dryRun: false, revision, manifest: { ...manifest, checks: manifest.checks.map((entry) => ({ poseId: entry.poseId, region: entry.region, baselineHash: entry.baselineHash })) } });
                return;
            }
            const manifest = await readFile(manifestPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => undefined);
            if (!manifest || !Array.isArray(manifest.checks)) {
                sendJson(res, 404, { ok: false, error: `golden not found: ${name}` });
                return;
            }
            const goldenChecks = manifest.checks as Array<{
                poseId: string;
                region: string;
                baselineHash: string;
            }>;
            const expectedHashes: Record<string, string> = {};
            for (const entry of goldenChecks)
                expectedHashes[`${entry.poseId}:${entry.region}`] = entry.baselineHash;
            const qa = await runQaCheck(await readRigFile(rigPath), publicDir, { ...qaRequest, poses: qaRequest.poses ?? goldenChecks.map((entry) => entry.poseId), regions: qaRequest.regions ?? goldenChecks.map((entry) => entry.region), expectedHashes });
            sendJson(res, 200, { ok: qa.ok, action, name, goldenRevision: manifest.revision, currentRevision: fullRigRevision(await readRigFile(rigPath)), mismatches: qa.failed.filter((entry) => entry.issues.includes("baseline-mismatch")).map((entry) => ({ poseId: entry.poseId, region: entry.region, expectedHash: entry.expectedHash, actualHash: entry.baselineHash })), qa: { ok: qa.ok, entries: qa.entries.map((entry) => ({ poseId: entry.poseId, region: entry.region, pass: entry.pass, issues: entry.issues, motionDiffPixelRatio: entry.motionDiffPixelRatio })), failureRegions: qa.failureRegions } });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/qa/art-paths", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req)) as unknown as ArtPathQaRequest;
            const rig = await readRigFile(rigPath);
            const result = runArtPathQa(rig, body);
            sendJson(res, 200, { ok: result.ok, revision: fullRigRevision(rig), result });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
}
