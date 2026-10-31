import { qaSchema, transactionSchema } from '@standrig/contracts';
import { summarizeRig, validateRig } from '@standrig/core/inspect';
import { migrateRigDocument } from '@standrig/core/migration';
import { executeModelingOperation, type ModelingOperation } from '@standrig/core/modelingOps';
import { auditPhysicsSafety } from '@standrig/core/physicsSafety';
import type { RigDocument } from '@standrig/core/types';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeModelingTransactionResult } from '../modelingTransactionResult.js';
import type { ModelingContext } from './context.js';
import { fullRigRevision, loadArtMeshAlphaSamplers, modelingOperationGateIssues, readRigFile, writeRigFile } from './modelingSupport.js';
import { runServiceQa, type QaProgress } from '../qaRunner.js';
import { externalizeRigAssets, type RigAssetManifest } from '@standrig/core/assetManifest';
import { pngBytes, putAsset } from '../assetStorage.js';
import { writeJsonFile } from './modelingSupport.js';
import { readRigSnapshot } from './modelingSupport.js';
import { fileStamp } from '../fileStamp.js';
export class ApplicationError extends Error {
    constructor(public status: number, message: string, public details: Record<string, unknown> = {}) { super(message); }
}
/** Owns model persistence for the default API: validate -> QA -> CAS -> checkpoint -> atomic replace. */
export class ModelingService {
    private queue: Promise<unknown> = Promise.resolve();
    constructor(readonly context: ModelingContext, private onCommit: (rig: RigDocument) => void) { }
    async checkpoint(rig?: RigDocument) {
        const current = rig ?? await readRigFile(this.context.rigPath);
        return this.context.checkpoints.create(current,fullRigRevision(current),{owned:rig===undefined});
    }
    execute(input: unknown, options: { owned?: boolean; signal?: AbortSignal; progress?: (value: QaProgress) => void } = {}) {
        const result = this.queue.catch(() => { }).then(() => { options.signal?.throwIfAborted(); return this.apply(input, options); });
        this.queue = result;
        return result;
    }
    private async apply(raw: unknown, options: { owned?: boolean; signal?: AbortSignal; progress?: (value: QaProgress) => void }) {
        options.progress?.({stage:'validating'});
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
        const currentSnapshot = await readRigSnapshot(this.context.rigPath);
        const current = currentSnapshot.rig;
        const revisionBefore = fullRigRevision(current);
        if (expectedRevision !== revisionBefore)
            throw new ApplicationError(409, 'revision mismatch', { revisionBefore, summary: summarizeRig(current) });
        let candidate: RigDocument;
        const operationResults = [];
        const operationGateIssues: ReturnType<typeof modelingOperationGateIssues> = [];
        let artMeshSampler;
        if (kind === 'import') {
            candidate = migrateRigDocument((options.owned ? body.rig : structuredClone(body.rig)) as RigDocument);
            if(options.owned)delete body.rig;
        }
        else if (kind === 'restore') {
            if (typeof body.checkpointId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.checkpointId))
                throw new ApplicationError(400, 'invalid checkpoint id');
            candidate = migrateRigDocument(await this.context.checkpoints.restore(body.checkpointId));
        }
        else {
            candidate = structuredClone(current);
            const samplerRig = operations.some(operation => operation.action.type === 'role-confirm') ? structuredClone(current) : current;
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
        options.signal?.throwIfAborted();
        const qa = validation.ok && qaRequest ? await runServiceQa(candidate, this.context.publicDir, qaRequest, this.context.qaOptions, options.progress, options.signal) : undefined;
        // Restoring a known checkpoint may intentionally return to an empty/unrigged model.
        const passed = validation.ok && (kind === 'restore' || physicsSafety.pass) && (qa?.ok ?? true) && !(artMeshSampler?.skipped.length) && !operationGateIssues.length;
        // Prepare deterministic external references for both dry-run and commit; no files yet.
        const importedAssets = (kind==='import'||kind==='restore') && passed ? await externalizeRigAssets(candidate,'/assets',{owned:true}) : undefined;
        const evidence = { revisionBefore, operationResults, operationGateIssues, validation, physicsSafety, qa, artMeshSampler, summary: summarizeRig(candidate) };
        if (commit && !passed)
            throw new ApplicationError(422, 'transaction gate failed', { ...evidence, committed: false });
        let rollbackCheckpoint;
        const revisionAfter = fullRigRevision(candidate);
        if (commit) {
            // Check all external assets before committing an imported/restored document.
            if (kind !== 'operations') for(const asset of candidate.assets) {
                const prepared=importedAssets?.files.get(asset.src);
                await pngBytes(prepared?{...asset,src:'data:image/png;base64,'+Buffer.from(prepared).toString('base64')}:asset,this.context.publicDir);
            }
            const assertRevision = async()=>{
                if(await fileStamp(this.context.rigPath)===currentSnapshot.stamp)return;
                const latest=await readRigSnapshot(this.context.rigPath),revision=fullRigRevision(latest.rig);
                if(revision!==revisionBefore)throw new ApplicationError(409,'revision changed during transaction',{revisionBefore,currentRevision:revision});
            };
            await assertRevision();
            options.signal?.throwIfAborted();
            options.progress?.({stage:'committing'});
            rollbackCheckpoint = await this.context.checkpoints.create(current,revisionBefore,{owned:true});
            if(importedAssets){
                for(const [url,bytes] of importedAssets.files)await putAsset(this.context.assetsDir,path.basename(url,'.png'),bytes);
                const manifest:RigAssetManifest=await readFile(this.context.assetManifestPath,'utf8').then(raw=>JSON.parse(raw)).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return {format:'standrig-assets',version:1,entries:[]};});
                if(manifest.format!=='standrig-assets'||manifest.version!==1||!Array.isArray(manifest.entries))throw Error('Invalid asset manifest');
                const entries=new Map(manifest.entries.map(entry=>[entry.assetId,entry]));for(const entry of importedAssets.manifest.entries)entries.set(entry.assetId,entry);
                await writeJsonFile(this.context.assetManifestPath,{...manifest,entries:[...entries.values()]});
            }
            await assertRevision();
            await writeRigFile(this.context.rigPath, candidate);
            this.context.journal.push({ id: randomUUID(), appliedAt: new Date().toISOString(), revisionBefore, revisionAfter, operationIds: kind === 'operations' ? operations.map(o => o.id) : [String(kind)] });
            if (this.context.journal.length > 30)
                this.context.journal.shift();
            this.onCommit(candidate);
        }
        const transactionResult = normalizeModelingTransactionResult({ committed: commit && passed, dryRun: !commit, revisionBefore, revisionAfter, operationResults, operationGateIssues });
        return { ok: passed, kind, committed: commit && passed, dryRun: !commit, ...evidence, revisionAfter, transactionResult, noWrite: transactionResult.noWrite, rollbackCheckpoint, history: { scope: 'server-memory', persisted: false } };
    }
}
