import { qaSchema, transactionSchema } from '@standrig/contracts';
import { summarizeRig, validateRig } from '@standrig/core/inspect';
import { migrateRigDocument } from '@standrig/core/migration';
import { executeModelingOperation, type ModelingOperation } from '@standrig/core/modelingOps';
import { auditPhysicsSafety } from '@standrig/core/physicsSafety';
import { runQaCheck } from '@standrig/core/qaCheck';
import type { RigDocument } from '@standrig/core/types';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeModelingTransactionResult } from '../modelingTransactionResult.js';
import { portableBundle } from '../portableBundle.js';
import type { ModelingContext } from './context.js';
import { fullRigRevision, loadArtMeshAlphaSamplers, modelingOperationGateIssues, readRigFile, writeRigFile } from './modelingSupport.js';
export class ApplicationError extends Error {
    constructor(public status: number, message: string, public details: Record<string, unknown> = {}) { super(message); }
}
/** Owns model persistence for the default API: validate -> QA -> CAS -> checkpoint -> atomic replace. */
export class ModelingService {
    private queue: Promise<unknown> = Promise.resolve();
    constructor(readonly context: ModelingContext, private onCommit: () => void) { }
    async checkpoint(rig?: RigDocument) {
        const current = rig ?? await readRigFile(this.context.rigPath);
        const dir = path.join(this.context.rootDir, 'checkpoints');
        const bundle = await portableBundle(current, this.context.publicDir);
        const record = { id: randomUUID(), createdAt: new Date().toISOString(), revision: fullRigRevision(current), bundle };
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, record.id + '.json'), JSON.stringify(record), { flag: 'wx' });
        return { id: record.id, createdAt: record.createdAt, revision: record.revision };
    }
    execute(input: unknown) {
        const result = this.queue.catch(() => { }).then(() => this.apply(input));
        this.queue = result;
        return result;
    }
    private async apply(raw: unknown) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new ApplicationError(400, 'expected an object');
        const body = raw as Record<string, unknown>;
        const kind = body.kind ?? 'operations';
        if (!['operations', 'import', 'restore'].includes(String(kind)))
            throw new ApplicationError(400, 'invalid transaction kind');
        let operations: ModelingOperation[] = [];
        let qaRequest;
        let commit = false;
        let expectedRevision: string;
        if (kind === 'operations') {
            const { kind: _kind, ...envelope } = body;
            const parsed = transactionSchema.safeParse(envelope);
            if (!parsed.success)
                throw new ApplicationError(400, 'invalid transaction schema', { issues: parsed.error.issues });
            ({ operations, qa: qaRequest, commit, expectedRevision } = parsed.data);
        }
        else {
            const allowed = new Set(kind === 'import' ? ['kind', 'rig', 'expectedRevision', 'commit', 'qa'] : ['kind', 'checkpointId', 'expectedRevision', 'commit']);
            if (Object.keys(body).some(k => !allowed.has(k)) || typeof body.expectedRevision !== 'string' || !body.expectedRevision || (body.commit !== undefined && typeof body.commit !== 'boolean'))
                throw new ApplicationError(400, 'invalid replacement transaction schema');
            expectedRevision = body.expectedRevision;
            commit = body.commit === true;
            if (kind === 'import') {
                const parsed = qaSchema.safeParse(body.qa);
                if (!parsed.success)
                    throw new ApplicationError(400, 'import requires valid qa', { issues: parsed.error.issues });
                qaRequest = parsed.data;
                if (!body.rig || typeof body.rig !== 'object' || Array.isArray(body.rig))
                    throw new ApplicationError(400, 'import requires rig');
            }
        }
        const current = await readRigFile(this.context.rigPath);
        const revisionBefore = fullRigRevision(current);
        if (expectedRevision !== revisionBefore)
            throw new ApplicationError(409, 'revision mismatch', { revisionBefore, summary: summarizeRig(current) });
        let candidate = structuredClone(current);
        const operationResults = [];
        const operationGateIssues: ReturnType<typeof modelingOperationGateIssues> = [];
        let artMeshSampler;
        if (kind === 'import')
            candidate = migrateRigDocument(structuredClone(body.rig) as RigDocument);
        else if (kind === 'restore') {
            if (typeof body.checkpointId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.checkpointId))
                throw new ApplicationError(400, 'invalid checkpoint id');
            const record = JSON.parse(await readFile(path.join(this.context.rootDir, 'checkpoints', body.checkpointId + '.json'), 'utf8'));
            candidate = migrateRigDocument(record.bundle.rig);
        }
        else {
            const samplerRig = structuredClone(current);
            for (const operation of operations)
                if (operation.action.type === 'role-confirm')
                    executeModelingOperation(samplerRig, operation, { dryRun: false });
            const loaded = await loadArtMeshAlphaSamplers(samplerRig, this.context.publicDir, operations);
            artMeshSampler = { requiredAssetIds: loaded.requiredAssetIds, loadedAssetIds: loaded.loadedAssetIds, skipped: loaded.skipped };
            for (const operation of operations)
                operationResults.push(executeModelingOperation(candidate, operation, { dryRun: false, assetAlphaSamplers: loaded.samplers }));
            operationGateIssues.push(...modelingOperationGateIssues(operations, operationResults));
        }
        const validation = validateRig(candidate);
        const physicsSafety = auditPhysicsSafety(candidate);
        const qa = qaRequest ? await runQaCheck(candidate, this.context.publicDir, qaRequest) : undefined;
        // Restoring a known checkpoint may intentionally return to an empty/unrigged model.
        const passed = validation.ok && (kind === 'restore' || physicsSafety.pass) && (qa?.ok ?? true) && !(artMeshSampler?.skipped.length) && !operationGateIssues.length;
        const evidence = { revisionBefore, operationResults, operationGateIssues, validation, physicsSafety, qa, artMeshSampler, summary: summarizeRig(candidate) };
        if (commit && !passed)
            throw new ApplicationError(422, 'transaction gate failed', { ...evidence, committed: false });
        let rollbackCheckpoint;
        if (commit) {
            // Check all external assets before committing an imported/restored document.
            if (kind !== 'operations')
                await portableBundle(candidate, this.context.publicDir);
            const latest = await readRigFile(this.context.rigPath);
            if (fullRigRevision(latest) !== revisionBefore)
                throw new ApplicationError(409, 'revision changed during transaction', { revisionBefore, currentRevision: fullRigRevision(latest) });
            rollbackCheckpoint = await this.checkpoint(current);
            await writeRigFile(this.context.rigPath, candidate);
            this.context.journal.push({ id: randomUUID(), appliedAt: new Date().toISOString(), revisionBefore, revisionAfter: fullRigRevision(candidate), operationIds: kind === 'operations' ? operations.map(o => o.id) : [String(kind)] });
            if (this.context.journal.length > 30)
                this.context.journal.shift();
            this.onCommit();
        }
        const revisionAfter = fullRigRevision(candidate);
        const transactionResult = normalizeModelingTransactionResult({ committed: commit && passed, dryRun: !commit, revisionBefore, revisionAfter, operationResults, operationGateIssues });
        return { ok: passed, kind, committed: commit && passed, dryRun: !commit, ...evidence, revisionAfter, transactionResult, noWrite: transactionResult.noWrite, rollbackCheckpoint, history: { scope: 'server-memory', persisted: false } };
    }
}
