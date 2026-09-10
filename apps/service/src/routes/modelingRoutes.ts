import { generateArtMeshKeyCandidates, modelingOperationsForArtMeshCandidates } from "@standrig/core/artMeshCandidates";
import { artMeshGenerationProfiles, artMeshProfileCandidates } from "@standrig/core/artMeshPresets";
import { runArtPathQa, type ArtPathQaRequest } from "@standrig/core/artPathQa";
import { applyArtPathTransactionOperations, type ArtPathTransactionOperation } from "@standrig/core/artPathTransaction";
import { correspondenceOperationsForSolution, solveCorrespondence, type CorrespondenceSolveRequest } from "@standrig/core/correspondenceSolver";
import { ensureRigDeformers, normalizeDeformer } from "@standrig/core/deformers";
import { fitHeadProxy, headProxyPoseCandidates } from "@standrig/core/headProxy";
import { calibrateHeadProxy, normalizeHeadProxyCalibrationSamples } from "@standrig/core/headProxyCalibration";
import { summarizeRig, validateRig } from "@standrig/core/inspect";
import { runJoinQa, type JoinQaRequest } from "@standrig/core/joinQa";
import { applyJoinTransactionOperations, type JoinTransactionOperation } from "@standrig/core/joinTransaction";
import { modelingPosePresetsForRig, modelingPoseValuesForRig } from "@standrig/core/modeling";
import { auditModelingRig } from "@standrig/core/modelingAudit";
import { executeModelingOperation } from "@standrig/core/modelingOps";
import { modelingTechniqueGuideForRig } from "@standrig/core/modelingTechniqueGuide";
import { clampParameterValue, parameterDefinitionsForRig, previewParameterValuesForRig, writePreviewParameterValues } from "@standrig/core/parameters";
import { inferPartRole } from "@standrig/core/partRoles";
import { auditPhysicsSafety, type PhysicsSafetyOptions } from "@standrig/core/physicsSafety";
import { runPhysicsSettlingQa } from "@standrig/core/physicsSettlingQa";
import { runQaCheck, type QaCheckRequest } from "@standrig/core/qaCheck";
import { calibrateRigReadiness } from "@standrig/core/readinessCalibration";
import { auditArtMeshSkinning, generateArtMeshSkinning } from "@standrig/core/skinning";
import { runSkinningQa, type SkinningQaOptions } from "@standrig/core/skinningQa";
import { runSkinningRenderQa, type SkinningRenderQaOptions } from "@standrig/core/skinningRenderQa";
import { estimateSymmetryAxis, symmetryContractFromEstimate, symmetryContractWithInferredLinks } from "@standrig/core/symmetry";
import type { ParameterValues, RigDocument } from "@standrig/core/types";
import { normalizeWarpDeformer } from "@standrig/core/warp";
import { applyWarpPinMirrorInDeformer, linkWarpPinMirrorInDeformer, unlinkWarpPinMirrorInDeformer } from "@standrig/core/warpPinLinks";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelingContext } from '../application/context.js';
import { compactCorrespondenceAction, ensurePartModelingBinding, fullRigRevision, isPartKeyProperty, modelingInterpolation, modelingOperationGateIssues, modelingPartKeySummary, neutralPartKeyValue, parameterPatchFromBody, parseJsonObject, readBody, readRigFile, readRigFromRequestOrFile, resolveWarpPinIndexForApi, sendJson, upsertModelingBindingKey, warpPinMirrorAction, writeRigFile } from '../application/modelingSupport.js';
import type { ApiHost } from "../host.js";
export function modelingRoutes(ctx: ModelingContext, server: ApiHost) {
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
    server.middlewares.use("/api/modeling/audit", sendModelingAudit);
    server.middlewares.use("/api/modeling/symmetry-artmesh-candidates", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
                return;
            }
            const current = await readRigFile(rigPath);
            const url = new URL(req.url ?? "/api/modeling/symmetry-artmesh-candidates", "http://localhost");
            const rawPartIds = url.searchParams.get("partIds");
            const rawParameters = url.searchParams.get("parameters");
            const rawSample = Number(url.searchParams.get("sample"));
            const rawMaxPairs = Number(url.searchParams.get("maxPairs"));
            const includeOffsets = url.searchParams.get("includeOffsets") === "1";
            const report = generateArtMeshKeyCandidates(current, {
                partIds: rawPartIds ? rawPartIds.split(",").map((id) => id.trim()).filter(Boolean) : undefined,
                parameters: rawParameters ? rawParameters.split(",").map((id) => id.trim()).filter(Boolean) : undefined,
                sample: Number.isFinite(rawSample) && rawSample > 0 ? rawSample : undefined,
                maxPairs: Number.isFinite(rawMaxPairs) && rawMaxPairs > 0 ? rawMaxPairs : undefined,
                includeOffsets
            });
            sendJson(res, 200, { ok: report.qa.pass, revision: fullRigRevision(current), report });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/symmetry-artmesh-transaction-dry-run", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req));
            if (body.commit === true) {
                sendJson(res, 400, { ok: false, error: "this endpoint is dry-run only; use /api/modeling/transaction after approval" });
                return;
            }
            const current = await readRigFile(rigPath);
            const revisionBefore = fullRigRevision(current);
            const rawPartIds = Array.isArray(body.partIds) ? body.partIds.filter((id): id is string => typeof id === "string" && !!id.trim()) : undefined;
            const rawParameters = Array.isArray(body.parameters) ? body.parameters.filter((id): id is string => typeof id === "string" && !!id.trim()) : undefined;
            const rawSample = Number(body.sample);
            const rawMaxPairs = Number(body.maxPairs);
            const report = generateArtMeshKeyCandidates(current, {
                partIds: rawPartIds,
                parameters: rawParameters,
                sample: Number.isFinite(rawSample) && rawSample > 0 ? rawSample : undefined,
                maxPairs: Number.isFinite(rawMaxPairs) && rawMaxPairs > 0 ? rawMaxPairs : undefined,
                includeOffsets: true
            });
            const returnOffsets = body.returnOffsets === true;
            const responseReport = returnOffsets ? report : { ...report, candidates: report.candidates.map(({ offsets, ...summary }) => summary) };
            if (!report.qa.pass) {
                sendJson(res, 200, { ok: false, committed: false, dryRun: true, revisionBefore, revisionAfter: revisionBefore, gate: "candidate-distortion", report: responseReport, summary: summarizeRig(current) });
                return;
            }
            const operations = modelingOperationsForArtMeshCandidates(report);
            const candidate = structuredClone(current);
            const operationResults = operations.map((operation) => executeModelingOperation(candidate, operation, { dryRun: false }));
            const operationGateIssues = modelingOperationGateIssues(operations, operationResults);
            const validation = validateRig(candidate);
            const poses = ["neutral", "face-left", "face-right", "face-up", "face-down", "tilt-left", "tilt-right", "mouth-flat", "mouth-half", "mouth-open", "blink"];
            const regions = Array.isArray(body.regions) ? body.regions.filter((region): region is string => typeof region === "string" && !!region.trim()) : ["face", "eyes", "hair-roots", "hair-tail-left", "hair-tail-right", "neck", "shoulders"];
            const qaFull = await runQaCheck(candidate, publicDir, { poses, regions, width: 240, height: 240, physics: false, checkTriangleDistortion: true });
            const qa = {
                ok: qaFull.ok,
                poseCount: poses.length,
                regionCount: regions.length,
                renderedCount: qaFull.renderedCount,
                failed: qaFull.failed.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues, coverage: entry.coverage, motionDiffPixelRatio: entry.motionDiffPixelRatio })),
                failureRegions: qaFull.failureRegions.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues }))
            };
            const passed = report.qa.pass && validation.ok && qa.ok && operationGateIssues.length === 0;
            sendJson(res, 200, { ok: passed, committed: false, dryRun: true, revisionBefore, revisionAfter: fullRigRevision(candidate), operationCount: operations.length, operationResults, operationGateIssues, validation, candidateGate: report.qa, qa, report: responseReport, summary: summarizeRig(candidate) });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, committed: false, dryRun: true, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/head-proxy/calibrate", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req));
            const rig = await readRigFile(rigPath);
            const proxy = fitHeadProxy(rig);
            if (!proxy) {
                sendJson(res, 422, { ok: false, error: "unable to fit head proxy: confirmed face part or asset dimensions are missing" });
                return;
            }
            const samples = normalizeHeadProxyCalibrationSamples(body.samples);
            const units = body.units === "normalized" ? "normalized" : "stage";
            const rawThreshold = Number(body.thresholdNorm);
            const report = calibrateHeadProxy(proxy, samples, {
                units,
                thresholdNorm: Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : undefined
            });
            const includeOffsets = body.includeOffsets === true;
            const compactReport = includeOffsets
                ? report
                : { ...report, samples: report.samples.map(({ corrections, ...summary }) => summary) };
            sendJson(res, 200, {
                ok: report.pass,
                revision: fullRigRevision(rig),
                proxy: { fitMethod: proxy.fitMethod, bounds: proxy.bounds, landmarkCount: Object.keys(proxy.landmarks).length },
                report: compactReport
            });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/correspondence", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req));
            const current = await readRigFile(rigPath);
            const revisionBefore = fullRigRevision(current);
            if (typeof body.expectedRevision === "string" && body.expectedRevision !== revisionBefore) {
                sendJson(res, 409, { ok: false, error: "revision mismatch", revisionBefore, summary: summarizeRig(current) });
                return;
            }
            if (!body.landmarks || typeof body.landmarks !== "object" || Array.isArray(body.landmarks)) {
                sendJson(res, 400, { ok: false, error: "landmarks must be an object keyed by head-proxy landmark id" });
                return;
            }
            const proxy = fitHeadProxy(current);
            if (!proxy) {
                sendJson(res, 422, { ok: false, error: "unable to fit head proxy: confirmed face part or asset dimensions are missing" });
                return;
            }
            const request = {
                values: body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : {},
                landmarks: body.landmarks,
                regularization: body.regularization,
                maxResidual: body.maxResidual,
                maxOffset: body.maxOffset,
                partIds: Array.isArray(body.partIds) ? body.partIds : undefined,
                roles: Array.isArray(body.roles) ? body.roles : undefined,
                includeOffsets: body.includeOffsets === true
            } as CorrespondenceSolveRequest;
            const solution = solveCorrespondence(proxy, request);
            const report = correspondenceOperationsForSolution(current, proxy, solution, request);
            const candidate = structuredClone(current);
            const operationResults = report.operations.map((operation) => executeModelingOperation(candidate, operation, { dryRun: false }));
            const operationGateIssues = modelingOperationGateIssues(report.operations, operationResults);
            const validation = validateRig(candidate);
            const physicsSafety = auditPhysicsSafety(candidate);
            const qaRequest = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as QaCheckRequest : undefined;
            const qa = qaRequest ? await runQaCheck(candidate, publicDir, qaRequest) : undefined;
            const candidateGate = solution.pass && report.finite && report.distortionPass && report.issues.length === 0 && report.operations.length > 0;
            const passed = candidateGate && validation.ok && physicsSafety.pass && operationGateIssues.length === 0 && (qa ? qa.ok : true);
            const commit = body.commit === true;
            if (commit && !passed) {
                sendJson(res, 422, { ok: false, committed: false, error: "correspondence transaction gate failed", revisionBefore, solver: solution, candidateGate: { pass: candidateGate, issues: report.issues, maxOffset: report.maxOffset, distortion: report.distortion }, operationResults, operationGateIssues, validation, physicsSafety, qa: qa ? { ok: qa.ok, failed: qa.failed, failureRegions: qa.failureRegions } : undefined, summary: summarizeRig(current) });
                return;
            }
            if (commit) {
                const latest = await readRigFile(rigPath);
                const latestRevision = fullRigRevision(latest);
                if (latestRevision !== revisionBefore) {
                    sendJson(res, 409, { ok: false, committed: false, error: "revision changed during correspondence transaction", revisionBefore, currentRevision: latestRevision });
                    return;
                }
                await writeRigFile(rigPath, candidate);
                server.ws.send({ type: "full-reload" });
            }
            const operationSummaries = report.summaries.map(({ operation, ...summary }) => ({ ...summary, operationId: operation.id, action: request.includeOffsets ? operation.action : compactCorrespondenceAction(operation.action) }));
            const revisionAfter = fullRigRevision(candidate);
            sendJson(res, 200, { ok: passed, committed: commit && passed, dryRun: !commit, revisionBefore, revisionAfter, proxy: { fitMethod: proxy.fitMethod, bounds: proxy.bounds, landmarkCount: Object.keys(proxy.landmarks).length }, solver: solution, candidateGate: { pass: candidateGate, issues: report.issues, maxOffset: report.maxOffset, distortionPass: report.distortionPass, distortion: report.distortion }, operationCount: report.operations.length, operationSummaries, operationResults, operationGateIssues, validation, qa, summary: summarizeRig(candidate) });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, committed: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/physics-safety", async (req, res) => {
        try {
            if (req.method !== "GET" && req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use GET or POST" });
                return;
            }
            const current = await readRigFile(rigPath);
            const revisionBefore = fullRigRevision(current);
            const body = req.method === "POST" ? parseJsonObject(await readBody(req)) : {};
            if (typeof body.expectedRevision === "string" && body.expectedRevision !== revisionBefore) {
                sendJson(res, 409, { ok: false, error: "revision mismatch", revisionBefore, summary: summarizeRig(current) });
                return;
            }
            const candidate = structuredClone(current);
            if (body.physics !== undefined) {
                if (!body.physics || typeof body.physics !== "object" || Array.isArray(body.physics)) {
                    sendJson(res, 400, { ok: false, error: "physics must be an object" });
                    return;
                }
                candidate.physics = structuredClone(body.physics) as RigDocument["physics"];
            }
            const rawFrames = Number(body.frames);
            const rawDt = Number(body.dt);
            const options: PhysicsSafetyOptions = {
                frames: Number.isFinite(rawFrames) ? rawFrames : undefined,
                dt: Number.isFinite(rawDt) ? rawDt : undefined,
                chainIds: Array.isArray(body.chainIds) ? body.chainIds.filter((id): id is string => typeof id === "string") : undefined,
                driveFrames: typeof body.driveFrames === "number" ? body.driveFrames : undefined,
                settleFrames: typeof body.settleFrames === "number" ? body.settleFrames : undefined,
                releaseExternalForces: body.releaseExternalForces === true
            };
            const safety = auditPhysicsSafety(candidate, options);
            const settling = runPhysicsSettlingQa(candidate, options);
            const validation = validateRig(candidate);
            const qaBody = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as Record<string, unknown> : {};
            let renderQa: {
                ok: boolean;
                renderedCount: number;
                failed: Array<{
                    poseId: string;
                    region: string;
                    issues: string[];
                    coverage: number;
                    motionDiffPixelRatio: number | null;
                }>;
                failureRegions: Array<{
                    poseId: string;
                    region: string;
                    issues: string[];
                }>;
            } | undefined;
            if (qaBody.render && typeof qaBody.render === "object" && !Array.isArray(qaBody.render)) {
                const renderRequest = qaBody.render as QaCheckRequest;
                const qaFull = await runQaCheck(candidate, publicDir, { ...renderRequest, physics: renderRequest.physics !== false });
                renderQa = { ok: qaFull.ok, renderedCount: qaFull.renderedCount, failed: qaFull.failed.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues, coverage: entry.coverage, motionDiffPixelRatio: entry.motionDiffPixelRatio })), failureRegions: qaFull.failureRegions.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues })) };
            }
            const passed = safety.pass && settling.pass && validation.ok && (renderQa ? renderQa.ok : true);
            const commit = req.method === "POST" && body.commit === true;
            if (commit && !passed) {
                sendJson(res, 422, { ok: false, committed: false, error: "physics safety gate failed", revisionBefore, safety, settling, validation, ...(renderQa ? { renderQa } : {}), summary: summarizeRig(current) });
                return;
            }
            if (commit) {
                const latest = await readRigFile(rigPath);
                const latestRevision = fullRigRevision(latest);
                if (latestRevision !== revisionBefore) {
                    sendJson(res, 409, { ok: false, committed: false, error: "revision changed during physics safety transaction", revisionBefore, currentRevision: latestRevision });
                    return;
                }
                await writeRigFile(rigPath, candidate);
                server.ws.send({ type: "full-reload" });
            }
            sendJson(res, 200, { ok: passed, committed: commit && passed, dryRun: !commit, revisionBefore, revisionAfter: fullRigRevision(candidate), safety, settling, validation, ...(renderQa ? { renderQa } : {}), summary: summarizeRig(candidate) });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, committed: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/skinning-candidates", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req));
            const current = await readRigFile(rigPath);
            const revisionBefore = fullRigRevision(current);
            if (typeof body.expectedRevision === "string" && body.expectedRevision !== revisionBefore) {
                sendJson(res, 409, { ok: false, error: "revision mismatch", revisionBefore, summary: summarizeRig(current) });
                return;
            }
            const commitRequested = body.commit === true;
            if (commitRequested && typeof body.expectedRevision !== "string") {
                sendJson(res, 400, { ok: false, committed: false, dryRun: false, error: "skinning commit requires expectedRevision, one part, and passing qa.render", revisionBefore, summary: summarizeRig(current) });
                return;
            }
            const partIds = Array.isArray(body.partIds) ? body.partIds.filter((id): id is string => typeof id === "string") : undefined;
            const roles = Array.isArray(body.roles) ? body.roles : undefined;
            const jointIds = Array.isArray(body.deformerIds) ? body.deformerIds.filter((id): id is string => typeof id === "string") : [];
            if (jointIds.length !== 3) {
                sendJson(res, 400, { ok: false, error: "deformerIds must contain exactly three root/middle/tip rotation deformers" });
                return;
            }
            const knownDeformerIds = new Set((current.deformers ?? []).filter((deformer) => deformer.kind === "rotate").map((deformer) => deformer.id));
            const selected = current.parts.filter((part) => (!partIds?.length || partIds.includes(part.id)) && (!roles?.length || (part.roleStatus === "confirmed" && Boolean(part.role && roles.includes(part.role)))));
            if (commitRequested && selected.length !== 1) {
                sendJson(res, 400, { ok: false, committed: false, dryRun: false, error: "skinning commit requires exactly one selected part", revisionBefore, selectedPartIds: selected.map((part) => part.id), summary: summarizeRig(current) });
                return;
            }
            const candidate = structuredClone(current);
            const summaries = [];
            const issues: string[] = [];
            for (const part of selected) {
                if (!part.artMesh?.enabled) {
                    issues.push(`${part.id}: artMesh is missing or disabled`);
                    continue;
                }
                const generated = generateArtMeshSkinning(part.artMesh, jointIds, { rootBand: typeof body.rootBand === "number" ? body.rootBand : undefined, tipBand: typeof body.tipBand === "number" ? body.tipBand : undefined });
                if (!generated.skinning) {
                    issues.push(`${part.id}: ${generated.issues.join(", ")}`);
                    continue;
                }
                const target = candidate.parts.find((entry) => entry.id === part.id);
                if (!target?.artMesh) {
                    issues.push(`${part.id}: candidate artMesh is missing`);
                    continue;
                }
                target.artMesh.skinning = generated.skinning;
                const audit = auditArtMeshSkinning(target.artMesh, target.artMesh.skinning, knownDeformerIds);
                summaries.push({ partId: part.id, name: part.name, role: part.role, vertexCount: target.artMesh.vertices.length, joints: generated.skinning.joints, audit, ...(body.includeWeights === true ? { vertexWeights: generated.skinning.vertexWeights } : {}) });
                if (!audit.pass)
                    issues.push(`${part.id}: ${audit.issues.join(", ")}`);
            }
            if (!selected.length)
                issues.push("no matching ArtMesh parts");
            const validation = validateRig(candidate);
            const qaBody = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as Record<string, unknown> : {};
            const skinningQa = runSkinningQa(candidate, selected.map((part) => part.id), {
                samples: Array.isArray(qaBody.samples) ? qaBody.samples.filter((sample): sample is ParameterValues => Boolean(sample && typeof sample === "object" && !Array.isArray(sample))) : undefined,
                neutralTolerance: typeof qaBody.neutralTolerance === "number" ? qaBody.neutralTolerance : undefined,
                rootBlendTolerance: typeof qaBody.rootBlendTolerance === "number" ? qaBody.rootBlendTolerance : undefined,
                maxDisplacement: typeof qaBody.maxDisplacement === "number" ? qaBody.maxDisplacement : undefined
            } satisfies SkinningQaOptions);
            let joinQa: Awaited<ReturnType<typeof runJoinQa>> | undefined;
            if (qaBody.join && typeof qaBody.join === "object" && !Array.isArray(qaBody.join))
                joinQa = await runJoinQa(candidate, publicDir, qaBody.join as JoinQaRequest);
            if (joinQa && !joinQa.ok)
                issues.push("skinning candidate: join QA failed");
            let renderQa: Awaited<ReturnType<typeof runSkinningRenderQa>> | undefined;
            if (qaBody.render && typeof qaBody.render === "object" && !Array.isArray(qaBody.render) && selected.length > 0) {
                const renderBody = qaBody.render as Record<string, unknown>;
                renderQa = await runSkinningRenderQa(current, candidate, publicDir, selected.map((part) => part.id), {
                    samples: Array.isArray(renderBody.samples) ? renderBody.samples.filter((sample): sample is ParameterValues => Boolean(sample && typeof sample === "object" && !Array.isArray(sample))) : undefined,
                    width: typeof renderBody.width === "number" ? renderBody.width : undefined,
                    height: typeof renderBody.height === "number" ? renderBody.height : undefined,
                    maxAlphaLossRatio: typeof renderBody.maxAlphaLossRatio === "number" ? renderBody.maxAlphaLossRatio : undefined,
                    maxCoverageLossRatio: typeof renderBody.maxCoverageLossRatio === "number" ? renderBody.maxCoverageLossRatio : undefined,
                    maxEdgeContactIncrease: typeof renderBody.maxEdgeContactIncrease === "number" ? renderBody.maxEdgeContactIncrease : undefined,
                    diffChannelThreshold: typeof renderBody.diffChannelThreshold === "number" ? renderBody.diffChannelThreshold : undefined
                } satisfies SkinningRenderQaOptions);
                if (!renderQa.pass)
                    issues.push("skinning candidate: focused render QA failed");
            }
            if (commitRequested && !renderQa)
                issues.push("skinning commit requires qa.render");
            let goldenQa: {
                name: string;
                manifestRevision?: string;
                pass: boolean;
                checkCount: number;
                failed: Array<{
                    poseId: string;
                    region: string;
                    issues: string[];
                }>;
            } | undefined;
            const goldenName = typeof body.goldenName === "string" ? body.goldenName.trim() : "";
            if (commitRequested && !goldenName)
                issues.push("skinning commit requires goldenName");
            if (goldenName) {
                if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(goldenName)) {
                    issues.push(`golden name is invalid: ${goldenName}`);
                }
                else {
                    const goldenManifest = await readFile(path.join(goldenRoot, goldenName, "manifest.json"), "utf8").then((raw) => JSON.parse(raw) as {
                        revision?: unknown;
                        checks?: unknown[];
                        render?: Record<string, unknown>;
                    }).catch(() => undefined);
                    const goldenChecks = Array.isArray(goldenManifest?.checks) ? goldenManifest!.checks.map((entry) => entry && typeof entry === "object" ? entry as Record<string, unknown> : {}).map((entry) => ({ poseId: typeof entry.poseId === "string" ? entry.poseId : "", region: typeof entry.region === "string" ? entry.region : "", baselineHash: typeof entry.baselineHash === "string" ? entry.baselineHash : "" })).filter((entry) => entry.poseId && entry.region && entry.baselineHash) : [];
                    if (!goldenManifest || !goldenChecks.length) {
                        goldenQa = { name: goldenName, pass: false, checkCount: goldenChecks.length, failed: [] };
                        issues.push(`golden not found or empty: ${goldenName}`);
                    }
                    else {
                        const goldenRevision = typeof goldenManifest.revision === "string" ? goldenManifest.revision : undefined;
                        const goldenResult = await runQaCheck(current, publicDir, {
                            poses: goldenChecks.map((entry) => entry.poseId),
                            regions: goldenChecks.map((entry) => entry.region),
                            width: typeof goldenManifest.render?.width === "number" ? goldenManifest.render.width : 240,
                            height: typeof goldenManifest.render?.height === "number" ? goldenManifest.render.height : 240,
                            physics: goldenManifest.render?.physics === true,
                            expectedHashes: Object.fromEntries(goldenChecks.map((entry) => [`${entry.poseId}:${entry.region}`, entry.baselineHash]))
                        });
                        const failed = goldenResult.failed.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues }));
                        const revisionPass = goldenRevision === revisionBefore;
                        goldenQa = { name: goldenName, manifestRevision: goldenRevision, pass: goldenResult.ok && revisionPass, checkCount: goldenChecks.length, failed };
                        if (!revisionPass)
                            issues.push(`golden ${goldenName} revision is stale; register a current-revision Golden before commit`);
                        if (!goldenResult.ok)
                            issues.push(`skinning candidate: Golden QA failed (${goldenName})`);
                    }
                }
            }
            const passed = issues.length === 0 && validation.ok && summaries.length > 0 && skinningQa.pass && (joinQa?.ok ?? true) && (renderQa?.pass ?? true) && (!commitRequested || Boolean(goldenQa?.pass));
            if (commitRequested && !passed) {
                sendJson(res, 422, { ok: false, committed: false, dryRun: false, error: "skinning commit gate failed", revisionBefore, revisionAfter: fullRigRevision(candidate), operation: "artmesh-skinning-candidate", joints: jointIds, summaries, issues, validation, skinningQa, ...(joinQa ? { joinQa } : {}), ...(goldenQa ? { goldenQa } : {}), summary: summarizeRig(candidate), ...(renderQa ? { renderQa } : {}) });
                return;
            }
            let committed = false;
            if (commitRequested) {
                const latest = await readRigFile(rigPath);
                const latestRevision = fullRigRevision(latest);
                if (latestRevision !== revisionBefore) {
                    sendJson(res, 409, { ok: false, committed: false, dryRun: false, error: "revision changed during skinning transaction", revisionBefore, currentRevision: latestRevision, summary: summarizeRig(latest) });
                    return;
                }
                await writeRigFile(rigPath, candidate);
                server.ws.send({ type: "full-reload" });
                committed = true;
                SERVER_TRANSACTION_JOURNAL.push({ id: `skinning-candidate-${Date.now()}`, appliedAt: new Date().toISOString(), revisionBefore, revisionAfter: fullRigRevision(candidate), operationIds: [`artmesh-skinning:${selected[0]?.id ?? "unknown"}`] });
                if (SERVER_TRANSACTION_JOURNAL.length > 30)
                    SERVER_TRANSACTION_JOURNAL.shift();
            }
            sendJson(res, 200, { ok: passed, committed, dryRun: !commitRequested, revisionBefore, revisionAfter: fullRigRevision(candidate), operation: "artmesh-skinning-candidate", joints: jointIds, summaries, issues, validation, skinningQa, ...(joinQa ? { joinQa } : {}), ...(goldenQa ? { goldenQa } : {}), summary: summarizeRig(candidate), ...(renderQa ? { renderQa } : {}) });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, committed: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/skinning-approval", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req));
            if (body.commit === true) {
                sendJson(res, 400, { ok: false, committed: false, dryRun: true, error: "skinning approval is dry-run only; use skinning-candidates commit after approval" });
                return;
            }
            const current = await readRigFile(rigPath);
            const revisionBefore = fullRigRevision(current);
            if (typeof body.expectedRevision !== "string") {
                sendJson(res, 400, { ok: false, approved: false, error: "expectedRevision is required" });
                return;
            }
            if (body.expectedRevision !== revisionBefore) {
                sendJson(res, 409, { ok: false, approved: false, error: "revision mismatch", revisionBefore, summary: summarizeRig(current) });
                return;
            }
            const partIds = Array.isArray(body.partIds) ? body.partIds.filter((id): id is string => typeof id === "string") : undefined;
            const roles = Array.isArray(body.roles) ? body.roles : undefined;
            const jointIds = Array.isArray(body.deformerIds) ? body.deformerIds.filter((id): id is string => typeof id === "string") : [];
            if (jointIds.length !== 3) {
                sendJson(res, 400, { ok: false, approved: false, error: "deformerIds must contain exactly three root/middle/tip rotation deformers" });
                return;
            }
            const selected = current.parts.filter((part) => (!partIds?.length || partIds.includes(part.id)) && (!roles?.length || (part.roleStatus === "confirmed" && Boolean(part.role && roles.includes(part.role)))));
            if (selected.length !== 1) {
                sendJson(res, 400, { ok: false, approved: false, error: "approval requires exactly one selected ArtMesh part", selectedPartIds: selected.map((part) => part.id), revisionBefore });
                return;
            }
            const selectedPart = selected[0];
            const candidate = structuredClone(current);
            const issues: string[] = [];
            const knownDeformerIds = new Set((current.deformers ?? []).filter((deformer) => deformer.kind === "rotate").map((deformer) => deformer.id));
            const generated = selectedPart.artMesh?.enabled ? generateArtMeshSkinning(selectedPart.artMesh, jointIds, { rootBand: typeof body.rootBand === "number" ? body.rootBand : undefined, tipBand: typeof body.tipBand === "number" ? body.tipBand : undefined }) : { skinning: undefined, issues: ["artMesh is missing or disabled"] };
            const target = candidate.parts.find((part) => part.id === selectedPart.id);
            let summary: Record<string, unknown> | undefined;
            if (!generated.skinning)
                issues.push(`${selectedPart.id}: ${generated.issues.join(", ")}`);
            if (!target?.artMesh)
                issues.push(`${selectedPart.id}: candidate artMesh is missing`);
            if (generated.skinning && target?.artMesh) {
                target.artMesh.skinning = generated.skinning;
                const audit = auditArtMeshSkinning(target.artMesh, target.artMesh.skinning, knownDeformerIds);
                summary = { partId: selectedPart.id, name: selectedPart.name, role: selectedPart.role, vertexCount: target.artMesh.vertices.length, joints: generated.skinning.joints, audit };
                if (!audit.pass)
                    issues.push(`${selectedPart.id}: ${audit.issues.join(", ")}`);
            }
            const validation = validateRig(candidate);
            const qaBody = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as Record<string, unknown> : {};
            const sampleValues = Array.isArray(qaBody.samples) ? qaBody.samples.filter((sample): sample is ParameterValues => Boolean(sample && typeof sample === "object" && !Array.isArray(sample))) : undefined;
            const skinningQa = runSkinningQa(candidate, [selectedPart.id], {
                samples: sampleValues,
                neutralTolerance: typeof qaBody.neutralTolerance === "number" ? qaBody.neutralTolerance : undefined,
                rootBlendTolerance: typeof qaBody.rootBlendTolerance === "number" ? qaBody.rootBlendTolerance : undefined,
                maxDisplacement: typeof qaBody.maxDisplacement === "number" ? qaBody.maxDisplacement : undefined
            } satisfies SkinningQaOptions);
            let renderQa: Awaited<ReturnType<typeof runSkinningRenderQa>> | undefined;
            if (qaBody.render && typeof qaBody.render === "object" && !Array.isArray(qaBody.render)) {
                const renderBody = qaBody.render as Record<string, unknown>;
                renderQa = await runSkinningRenderQa(current, candidate, publicDir, [selectedPart.id], {
                    samples: Array.isArray(renderBody.samples) ? renderBody.samples.filter((sample): sample is ParameterValues => Boolean(sample && typeof sample === "object" && !Array.isArray(sample))) : undefined,
                    width: typeof renderBody.width === "number" ? renderBody.width : undefined,
                    height: typeof renderBody.height === "number" ? renderBody.height : undefined,
                    maxAlphaLossRatio: typeof renderBody.maxAlphaLossRatio === "number" ? renderBody.maxAlphaLossRatio : undefined,
                    maxCoverageLossRatio: typeof renderBody.maxCoverageLossRatio === "number" ? renderBody.maxCoverageLossRatio : undefined,
                    maxEdgeContactIncrease: typeof renderBody.maxEdgeContactIncrease === "number" ? renderBody.maxEdgeContactIncrease : undefined,
                    diffChannelThreshold: typeof renderBody.diffChannelThreshold === "number" ? renderBody.diffChannelThreshold : undefined
                } satisfies SkinningRenderQaOptions);
                if (!renderQa.pass)
                    issues.push("skinning approval: focused render QA failed");
            }
            else
                issues.push("skinning approval requires qa.render");
            let joinQa: Awaited<ReturnType<typeof runJoinQa>> | undefined;
            if (qaBody.join && typeof qaBody.join === "object" && !Array.isArray(qaBody.join)) {
                joinQa = await runJoinQa(candidate, publicDir, qaBody.join as JoinQaRequest);
                if (!joinQa.ok)
                    issues.push("skinning approval: join QA failed");
            }
            else
                issues.push("skinning approval requires qa.join");
            const goldenNames = Array.isArray(qaBody.goldenNames) ? qaBody.goldenNames.filter((name): name is string => typeof name === "string") : [];
            const goldenResults: Array<{
                name: string;
                pass: boolean;
                failed: number;
                mismatches: Array<{
                    poseId: string;
                    region: string;
                    issues: string[];
                }>;
            }> = [];
            const goldenBody = qaBody.golden && typeof qaBody.golden === "object" && !Array.isArray(qaBody.golden) ? qaBody.golden as Record<string, unknown> : {};
            if (!goldenNames.length)
                issues.push("skinning approval requires qa.goldenNames");
            for (const name of goldenNames) {
                if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
                    issues.push(`golden name is invalid: ${name}`);
                    continue;
                }
                const manifest = await readFile(path.join(goldenRoot, name, "manifest.json"), "utf8").then((raw) => JSON.parse(raw) as {
                    checks?: unknown[];
                    render?: Record<string, unknown>;
                }).catch(() => undefined);
                const checks = Array.isArray(manifest?.checks) ? manifest!.checks.map((entry) => entry && typeof entry === "object" ? entry as Record<string, unknown> : {}).map((entry) => ({ poseId: typeof entry.poseId === "string" ? entry.poseId : "", region: typeof entry.region === "string" ? entry.region : "", baselineHash: typeof entry.baselineHash === "string" ? entry.baselineHash : "" })).filter((entry) => entry.poseId && entry.region && entry.baselineHash) : [];
                if (!checks.length) {
                    goldenResults.push({ name, pass: false, failed: 0, mismatches: [] });
                    issues.push(`golden not found or empty: ${name}`);
                    continue;
                }
                const goldenQa = await runQaCheck(current, publicDir, {
                    poses: checks.map((entry) => entry.poseId),
                    regions: checks.map((entry) => entry.region),
                    width: typeof goldenBody.width === "number" ? goldenBody.width : (typeof manifest?.render?.width === "number" ? manifest.render.width : 240),
                    height: typeof goldenBody.height === "number" ? goldenBody.height : (typeof manifest?.render?.height === "number" ? manifest.render.height : 240),
                    physics: typeof goldenBody.physics === "boolean" ? goldenBody.physics : manifest?.render?.physics === true,
                    expectedHashes: Object.fromEntries(checks.map((entry) => [`${entry.poseId}:${entry.region}`, entry.baselineHash]))
                });
                const mismatches = goldenQa.failed.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues }));
                goldenResults.push({ name, pass: goldenQa.ok, failed: mismatches.length, mismatches });
                if (!goldenQa.ok)
                    issues.push(`golden ${name} failed`);
            }
            let settling: {
                candidate: ReturnType<typeof runPhysicsSettlingQa>;
                baseline: ReturnType<typeof runPhysicsSettlingQa>;
                regressionFree: boolean;
            } | undefined;
            if (qaBody.settling && typeof qaBody.settling === "object" && !Array.isArray(qaBody.settling)) {
                const settlingBody = qaBody.settling as Record<string, unknown>;
                const settlingOptions = {
                    driveFrames: typeof settlingBody.driveFrames === "number" ? settlingBody.driveFrames : undefined,
                    settleFrames: typeof settlingBody.settleFrames === "number" ? settlingBody.settleFrames : undefined,
                    dt: typeof settlingBody.dt === "number" ? settlingBody.dt : undefined,
                    chainIds: Array.isArray(settlingBody.chainIds) ? settlingBody.chainIds.filter((id): id is string => typeof id === "string") : undefined,
                    releaseExternalForces: settlingBody.releaseExternalForces === true
                };
                const candidateSettling = runPhysicsSettlingQa(candidate, settlingOptions);
                const baselineSettling = runPhysicsSettlingQa(current, settlingOptions);
                const regressionFree = candidateSettling.issues.length <= baselineSettling.issues.length;
                settling = { candidate: candidateSettling, baseline: baselineSettling, regressionFree };
                if (!candidateSettling.pass)
                    issues.push("skinning approval: physics settling failed");
            }
            else
                issues.push("skinning approval requires qa.settling");
            const parity = { pass: Boolean(skinningQa.pass && renderQa?.pass), sharedEvaluator: true, serverRenderer: Boolean(renderQa?.pass), webglContract: "shared-applySkinningToVertices" };
            if (!parity.pass)
                issues.push("skinning approval: shared evaluator parity failed");
            const approved = issues.length === 0 && validation.ok && Boolean(summary?.audit && (summary.audit as {
                pass?: boolean;
            }).pass) && skinningQa.pass && Boolean(renderQa?.pass) && Boolean(joinQa?.ok) && goldenResults.length > 0 && goldenResults.every((entry) => entry.pass) && Boolean(settling?.candidate.pass) && parity.pass;
            const compactSettling = settling ? { candidate: { pass: settling.candidate.pass, finite: settling.candidate.finite, chainCount: settling.candidate.chains.length, failedChains: settling.candidate.chains.filter((entry) => !entry.pass).map((entry) => entry.chainId), issues: settling.candidate.issues }, baseline: { pass: settling.baseline.pass, finite: settling.baseline.finite, chainCount: settling.baseline.chains.length, failedChains: settling.baseline.chains.filter((entry) => !entry.pass).map((entry) => entry.chainId), issues: settling.baseline.issues }, regressionFree: settling.regressionFree } : undefined;
            const compactJoin = joinQa ? { ok: joinQa.ok, summary: joinQa.summary, failedPairs: joinQa.failedPairs.map((entry) => ({ poseId: entry.poseId, partAId: entry.partAId, partBId: entry.partBId, issues: entry.issues })), failedMasks: joinQa.failedMasks.map((entry) => ({ poseId: entry.poseId, ownerPartId: entry.ownerPartId, issues: entry.issues })), drawOrderPass: joinQa.drawOrder.pass } : undefined;
            sendJson(res, 200, { ok: approved, approved, committed: false, dryRun: true, revisionBefore, revisionAfter: fullRigRevision(candidate), operation: "artmesh-skinning-approval", partId: selectedPart.id, summary, issues, validation, skinningQa, renderQa, joinQa: compactJoin, golden: goldenResults, settling: compactSettling, parity });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, approved: false, committed: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/head-proxy", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const url = new URL(req.url ?? "/api/modeling/head-proxy", "http://localhost");
            const calibratedRequested = ["1", "true", "yes"].includes(String(url.searchParams.get("calibrated") ?? "").toLowerCase());
            const calibrationReport = calibratedRequested ? await calibrateRigReadiness(rig, publicDir) : undefined;
            const calibrationPoint = (id: string) => {
                const value = calibrationReport?.items.find((item) => item.id === id)?.value;
                if (!value || typeof value !== "object" || !("x" in value) || !("y" in value))
                    return undefined;
                const x = Number(value.x);
                const y = Number(value.y);
                return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
            };
            const calibration = {
                leftEye: calibrationPoint("eye-center-left"),
                rightEye: calibrationPoint("eye-center-right"),
                chin: calibrationPoint("jaw-tip")
            };
            const hasCalibration = Object.values(calibration).some(Boolean);
            const proxy = fitHeadProxy(rig, hasCalibration ? { calibration } : {});
            if (!proxy) {
                sendJson(res, 422, { ok: false, error: "unable to fit head proxy: confirmed face part or asset dimensions are missing" });
                return;
            }
            const candidates = headProxyPoseCandidates(proxy);
            sendJson(res, 200, {
                ok: true,
                revision: fullRigRevision(rig),
                proxy,
                candidates,
                calibration: { requested: calibratedRequested, status: calibrationReport?.status ?? "not-requested", calibratedCount: calibrationReport?.items.filter((item) => item.status === "calibrated").length ?? 0 },
                summary: { landmarkCount: Object.keys(proxy.landmarks).length, candidateCount: candidates.length, fitMethod: proxy.fitMethod }
            });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/symmetry", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
                return;
            }
            const current = await readRigFile(rigPath);
            const url = new URL(req.url ?? "/api/modeling/symmetry", "http://localhost");
            const rawPartIds = url.searchParams.get("partIds");
            const partIds = rawPartIds ? rawPartIds.split(",").map((id) => id.trim()).filter(Boolean) : undefined;
            const estimate = estimateSymmetryAxis(current, partIds);
            const recommendedContract = symmetryContractWithInferredLinks(current, symmetryContractFromEstimate(estimate));
            sendJson(res, 200, { ok: true, revision: fullRigRevision(current), estimate, recommendedContract, linkSummary: { total: recommendedContract.links.length, byKind: Object.fromEntries(["part", "deformer", "warp-pin", "physics"].map((kind) => [kind, recommendedContract.links.filter((link) => link.kind === kind).length])) } });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/join-transaction", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req));
            const current = await readRigFile(rigPath);
            const revisionBefore = fullRigRevision(current);
            if (typeof body.expectedRevision === "string" && body.expectedRevision !== revisionBefore) {
                sendJson(res, 409, { ok: false, error: "revision mismatch", revisionBefore, summary: summarizeRig(current) });
                return;
            }
            if (!Array.isArray(body.operations) || !body.operations.length) {
                sendJson(res, 400, { ok: false, error: "operations must be a non-empty array" });
                return;
            }
            const operations = body.operations as JoinTransactionOperation[];
            const candidate = structuredClone(current);
            const applied = applyJoinTransactionOperations(candidate, operations, false);
            const validation = validateRig(candidate);
            const qaRequest = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as JoinQaRequest : { poses: ["neutral"], includeExposure: false };
            const joinQa = await runJoinQa(candidate, publicDir, qaRequest);
            const skipped = applied.operationResults.flatMap((entry) => entry.skipped.map((skip) => ({ operationId: entry.operationId, ...skip })));
            const passed = validation.ok && joinQa.ok && applied.issues.length === 0 && skipped.length === 0;
            const commit = body.commit === true;
            if (commit && !passed) {
                sendJson(res, 422, { ok: false, committed: false, error: "join transaction gate failed", revisionBefore, operationResults: applied.operationResults, issues: applied.issues, skipped, validation, joinQa, summary: summarizeRig(current) });
                return;
            }
            if (commit) {
                const latest = await readRigFile(rigPath);
                const latestRevision = fullRigRevision(latest);
                if (latestRevision !== revisionBefore) {
                    sendJson(res, 409, { ok: false, committed: false, error: "revision changed during transaction", revisionBefore, currentRevision: latestRevision });
                    return;
                }
                await writeRigFile(rigPath, candidate);
                server.ws.send({ type: "full-reload" });
            }
            const revisionAfter = fullRigRevision(candidate);
            if (commit && passed) {
                SERVER_TRANSACTION_JOURNAL.push({ id: "join-transaction-" + Date.now(), appliedAt: new Date().toISOString(), revisionBefore, revisionAfter, operationIds: operations.map((operation) => operation.id) });
                if (SERVER_TRANSACTION_JOURNAL.length > 30)
                    SERVER_TRANSACTION_JOURNAL.shift();
            }
            sendJson(res, 200, { ok: passed, committed: commit && passed, dryRun: !commit, revisionBefore, revisionAfter, operationResults: applied.operationResults, issues: applied.issues, skipped, validation, joinQa, summary: summarizeRig(candidate), history: { scope: "server-transaction-response", persisted: false } });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, committed: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/art-path-transaction", async (req, res) => {
        try {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
                return;
            }
            const body = parseJsonObject(await readBody(req));
            const current = await readRigFile(rigPath);
            const revisionBefore = fullRigRevision(current);
            if (typeof body.expectedRevision === "string" && body.expectedRevision !== revisionBefore) {
                sendJson(res, 409, { ok: false, error: "revision mismatch", revisionBefore, summary: summarizeRig(current) });
                return;
            }
            if (!Array.isArray(body.operations) || !body.operations.length) {
                sendJson(res, 400, { ok: false, error: "operations must be a non-empty array" });
                return;
            }
            const operations = body.operations as ArtPathTransactionOperation[];
            const candidate = structuredClone(current);
            const applied = applyArtPathTransactionOperations(candidate, operations);
            const validation = validateRig(candidate);
            const qaBody = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as Record<string, unknown> : {};
            const structuralQaRequest = qaBody.structural && typeof qaBody.structural === "object" && !Array.isArray(qaBody.structural)
                ? qaBody.structural as ArtPathQaRequest
                : qaBody as ArtPathQaRequest;
            const artPathQa = runArtPathQa(candidate, structuralQaRequest);
            // Optional render QA closes the gap between a valid path record and a
            // visually safe candidate. It remains numeric-only and returns no PNG.
            const renderQaRequest = qaBody.render && typeof qaBody.render === "object" && !Array.isArray(qaBody.render)
                ? qaBody.render as QaCheckRequest
                : undefined;
            const renderQaFull = renderQaRequest ? await runQaCheck(candidate, publicDir, renderQaRequest) : undefined;
            const renderQa = renderQaFull ? {
                ok: renderQaFull.ok,
                renderedCount: renderQaFull.renderedCount,
                failed: renderQaFull.failed.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues, coverage: entry.coverage, motionDiffPixelRatio: entry.motionDiffPixelRatio })),
                failureRegions: renderQaFull.failureRegions.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues }))
            } : undefined;
            const skipped = applied.operationResults.flatMap((entry) => entry.skipped.map((skip) => ({ operationId: entry.operationId, ...skip })));
            const passed = validation.ok && artPathQa.ok && (renderQa ? renderQa.ok : true) && applied.issues.length === 0 && skipped.length === 0;
            const commit = body.commit === true;
            if (commit && !passed) {
                sendJson(res, 422, { ok: false, committed: false, error: "art-path transaction gate failed", revisionBefore, operationResults: applied.operationResults, issues: applied.issues, skipped, validation, artPathQa, renderQa, summary: summarizeRig(current) });
                return;
            }
            if (commit) {
                const latest = await readRigFile(rigPath);
                const latestRevision = fullRigRevision(latest);
                if (latestRevision !== revisionBefore) {
                    sendJson(res, 409, { ok: false, committed: false, error: "revision changed during transaction", revisionBefore, currentRevision: latestRevision });
                    return;
                }
                await writeRigFile(rigPath, candidate);
                server.ws.send({ type: "full-reload" });
            }
            const revisionAfter = fullRigRevision(candidate);
            if (commit && passed) {
                SERVER_TRANSACTION_JOURNAL.push({ id: "art-path-transaction-" + Date.now(), appliedAt: new Date().toISOString(), revisionBefore, revisionAfter, operationIds: operations.map((operation) => operation.id) });
                if (SERVER_TRANSACTION_JOURNAL.length > 30)
                    SERVER_TRANSACTION_JOURNAL.shift();
            }
            sendJson(res, 200, { ok: passed, committed: commit && passed, dryRun: !commit, revisionBefore, revisionAfter, operationResults: applied.operationResults, issues: applied.issues, skipped, validation, artPathQa, renderQa, summary: summarizeRig(candidate), history: { scope: "server-transaction-response", persisted: false } });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, committed: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/role-suggestions", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
                return;
            }
            const requestUrl = new URL(req.url ?? "/api/modeling/role-suggestions", "http://localhost");
            const includeHidden = requestUrl.searchParams.get("includeHidden") === "1";
            const rawMinConfidence = requestUrl.searchParams.get("minConfidence");
            const requestedMinConfidence = rawMinConfidence === null ? Number.NaN : Number(rawMinConfidence);
            const minConfidence = Number.isFinite(requestedMinConfidence) ? Math.max(0, Math.min(1, requestedMinConfidence)) : 0.8;
            const rig = await readRigFile(rigPath);
            const suggestions = rig.parts
                .filter((part) => part.kind === "image" && part.roleStatus !== "confirmed")
                .filter((part) => includeHidden || (part.visible && !(part.tags ?? []).some((tag) => tag === "reference" || tag === "hidden-runtime")))
                .map((part) => {
                const suggestion = inferPartRole(part);
                return suggestion ? { partId: part.id, name: part.name, currentRole: part.role ?? null, currentStatus: part.roleStatus ?? "unassigned", suggestion } : undefined;
            })
                .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
                .filter((entry) => entry.suggestion.confidence >= minConfidence);
            const byRole: Record<string, number> = {};
            for (const entry of suggestions)
                byRole[entry.suggestion.role] = (byRole[entry.suggestion.role] ?? 0) + 1;
            sendJson(res, 200, { ok: true, revision: fullRigRevision(rig), includeHidden, minConfidence, suggestions, summary: { count: suggestions.length, byRole } });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/artmesh-presets", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const requestUrl = new URL(req.url ?? "/api/modeling/artmesh-presets", "http://localhost");
            const profileId = requestUrl.searchParams.get("profile")?.trim();
            if (profileId) {
                const result = artMeshProfileCandidates(rig, profileId);
                if (!result) {
                    sendJson(res, 404, { ok: false, error: "ArtMesh profile not found: " + profileId });
                    return;
                }
                sendJson(res, 200, {
                    ok: true,
                    ...result,
                    recommendedOperation: {
                        id: "artmesh-profile-" + result.profile.id,
                        name: "ArtMesh profile: " + result.profile.label,
                        target: { roles: result.profile.roles },
                        action: {
                            type: "artmesh-generate",
                            preset: result.profile.preset,
                            topology: result.profile.topology,
                            columns: result.profile.columns,
                            rows: result.profile.rows,
                            alphaThreshold: result.profile.alphaThreshold,
                            quality: result.profile.quality
                        }
                    },
                    requiresAlphaSampler: result.profile.topology === "alpha-contour"
                });
                return;
            }
            const profiles = artMeshGenerationProfiles().map((profile) => ({
                ...artMeshProfileCandidates(rig, profile.id),
                profile
            }));
            sendJson(res, 200, { ok: true, profiles, summary: summarizeRig(rig) });
        }
        catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/part-key", async (req, res) => {
        try {
            if (req.method !== "GET" && req.method !== "POST" && req.method !== "PATCH") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFile(rigPath);
            if (req.method === "GET") {
                const requestUrl = new URL(req.url ?? "/", "http://localhost/api/modeling/part-key");
                const partId = requestUrl.searchParams.get("partId");
                if (partId) {
                    const part = rig.parts.find((entry) => entry.id === partId);
                    if (!part) {
                        sendJson(res, 404, { ok: false, error: `part not found: ${partId}` });
                        return;
                    }
                    sendJson(res, 200, { ok: true, part: modelingPartKeySummary(part), parameters: parameterDefinitionsForRig(rig), values: previewParameterValuesForRig(rig) });
                    return;
                }
                sendJson(res, 200, {
                    ok: true,
                    parts: rig.parts.filter((part) => (part.bindings?.length ?? 0) > 0).map(modelingPartKeySummary),
                    parameters: parameterDefinitionsForRig(rig),
                    values: previewParameterValuesForRig(rig),
                    summary: summarizeRig(rig)
                });
                return;
            }
            const body = parseJsonObject(await readBody(req));
            const partId = typeof body.partId === "string" ? body.partId : undefined;
            const parameterId = typeof body.parameter === "string" ? body.parameter : undefined;
            const property = isPartKeyProperty(body.property) ? body.property : undefined;
            const part = partId ? rig.parts.find((entry) => entry.id === partId) : undefined;
            const parameter = parameterId ? parameterDefinitionsForRig(rig).find((entry) => entry.id === parameterId) : undefined;
            if (!partId || !part) {
                sendJson(res, 404, { ok: false, error: `part not found: ${partId ?? ""}` });
                return;
            }
            if (!parameterId || !parameter) {
                sendJson(res, 400, { ok: false, error: `parameter not found: ${parameterId ?? ""}` });
                return;
            }
            if (!property) {
                sendJson(res, 400, { ok: false, error: "property must be one of x, y, rotation, scaleX, scaleY, opacity" });
                return;
            }
            const input = clampParameterValue(rig, parameterId, typeof body.input === "number" && Number.isFinite(body.input)
                ? body.input
                : previewParameterValuesForRig(rig)[parameterId] ?? parameter.default);
            let value = typeof body.value === "number" && Number.isFinite(body.value) ? body.value : 0;
            if (body.captureFromTransform === true) {
                value = part.transform[property] - neutralPartKeyValue(property);
                part.transform[property] = neutralPartKeyValue(property);
            }
            const binding = ensurePartModelingBinding(part, parameterId, property, rig, {
                additive: typeof body.additive === "boolean" ? body.additive : undefined,
                interpolation: modelingInterpolation(body.interpolation)
            });
            upsertModelingBindingKey(binding, Math.round(input * 1000) / 1000, Math.round(value * 1000) / 1000);
            const validation = validateRig(rig);
            if (!validation.ok) {
                sendJson(res, 400, { ok: false, error: "modeling part key produced invalid rig", validation });
                return;
            }
            await writeRigFile(rigPath, rig);
            sendJson(res, 200, { ok: true, part: modelingPartKeySummary(part), binding, validation, summary: summarizeRig(rig) });
            server.ws.send({ type: "full-reload" });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/warp-pin-mirror", async (req, res) => {
        try {
            if (req.method !== "POST" && req.method !== "PATCH") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFile(rigPath);
            const body = parseJsonObject(await readBody(req));
            const deformerId = typeof body.deformerId === "string" ? body.deformerId : undefined;
            const action = warpPinMirrorAction(body.action);
            const pinIdOrIndex = body.pinIdOrIndex ?? body.pinId ?? body.pinIndex;
            const deformers = ensureRigDeformers(rig);
            const deformer = deformerId ? deformers.find((entry) => entry.id === deformerId) : undefined;
            if (!deformerId || !deformer) {
                sendJson(res, 404, { ok: false, error: `deformer not found: ${deformerId ?? ""}` });
                return;
            }
            if (deformer.kind !== "warp") {
                sendJson(res, 400, { ok: false, error: `deformer is not warp: ${deformerId}` });
                return;
            }
            if (!action) {
                sendJson(res, 400, { ok: false, error: "action must be link, apply, or unlink" });
                return;
            }
            normalizeDeformer(deformer, rig);
            const pins = normalizeWarpDeformer(deformer.warp).pins ?? [];
            const pinIndex = resolveWarpPinIndexForApi(pins, pinIdOrIndex);
            if (pinIndex < 0) {
                sendJson(res, 404, { ok: false, error: `warp pin not found: ${String(pinIdOrIndex ?? "")}` });
                return;
            }
            const options = {
                create: typeof body.create === "boolean" ? body.create : undefined,
                tolerance: typeof body.tolerance === "number" && Number.isFinite(body.tolerance) ? body.tolerance : undefined
            };
            const result = action === "link"
                ? linkWarpPinMirrorInDeformer(deformer, pinIndex, options)
                : action === "apply"
                    ? applyWarpPinMirrorInDeformer(deformer, pinIndex, options)
                    : unlinkWarpPinMirrorInDeformer(deformer, pinIndex);
            if (!result.ok) {
                sendJson(res, 400, { ok: false, error: result.reason ?? "warp pin mirror update failed", result, summary: summarizeRig(rig) });
                return;
            }
            normalizeDeformer(deformer, rig);
            const validation = validateRig(rig);
            if (!validation.ok) {
                sendJson(res, 400, { ok: false, error: "warp pin mirror update produced invalid rig", result, validation });
                return;
            }
            const dryRun = body.dryRun === true;
            if (!dryRun) {
                await writeRigFile(rigPath, rig);
                server.ws.send({ type: "full-reload" });
            }
            sendJson(res, 200, { ok: true, dryRun, action, result, deformer, validation, summary: summarizeRig(rig), audit: auditModelingRig(rig) });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling/techniques", async (req, res) => {
        try {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFile(rigPath);
            sendJson(res, 200, { ok: true, guide: modelingTechniqueGuideForRig(rig), summary: summarizeRig(rig) });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
    server.middlewares.use("/api/modeling", async (req, res) => {
        try {
            if (req.method !== "GET" && req.method !== "PATCH") {
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }
            const rig = await readRigFile(rigPath);
            let activePoseId: string | undefined;
            if (req.method === "PATCH") {
                const body = parseJsonObject(await readBody(req));
                activePoseId = typeof body.poseId === "string" ? body.poseId : undefined;
                const overrides = parameterPatchFromBody(body);
                const values = activePoseId ? modelingPoseValuesForRig(rig, activePoseId, overrides) : previewParameterValuesForRig(rig, overrides);
                if (!values) {
                    sendJson(res, 404, { ok: false, error: `modeling pose not found: ${activePoseId}` });
                    return;
                }
                writePreviewParameterValues(rig, values);
                const validation = validateRig(rig);
                if (!validation.ok) {
                    sendJson(res, 400, { ok: false, error: "modeling pose produced invalid rig", validation });
                    return;
                }
                await writeRigFile(rigPath, rig);
                server.ws.send({ type: "full-reload" });
            }
            sendJson(res, 200, {
                ok: true,
                activePoseId,
                values: previewParameterValuesForRig(rig),
                presets: modelingPosePresetsForRig(rig),
                screenshot: {
                    modeling: "/api/screenshot?set=modeling&width=260&height=360",
                    angles: "/api/screenshot?set=angles&width=260&height=360",
                    expressions: "/api/screenshot?set=expressions&width=260&height=360"
                },
                summary: summarizeRig(rig)
            });
        }
        catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) });
        }
    });
}
