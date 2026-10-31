import { randomUUID, createHash } from 'node:crypto';
import type { ModelingService } from './application/modelingService.js';
import { ApplicationError } from './application/modelingService.js';
import type { QaProgress } from './qaRunner.js';

type Job = { id: string; status: 'queued'|'running'|'completed'|'failed'|'cancelled'; createdAt: number; progress: QaProgress; result?: unknown; error?: unknown; controller: AbortController; input?: unknown; key?: string; digest?: string };
export class ModelingJobs {
  private jobs = new Map<string, Job>();
  constructor(private application: ModelingService, private schedule: <T>(run:()=>Promise<T>)=>Promise<T>, private committed: ()=>Promise<void>) {}
  capacity() { return [...this.jobs.values()].filter(j=>j.status==='queued'||j.status==='running').length < 3; }
  hasKey(key:unknown) { return typeof key==='string'&&[...this.jobs.values()].some(j=>j.key===key); }
  submit(input: unknown, key?: string) {
    if (key && !/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new ApplicationError(400,'Invalid idempotency key');
    const digest = key ? createHash('sha256').update(JSON.stringify(input)).digest('hex') : undefined;
    const previous = key ? [...this.jobs.values()].find(j=>j.key===key) : undefined;
    if (previous) { if(previous.digest!==digest)throw new ApplicationError(409,'Idempotency key has a different request');return this.view(previous); }
    if (!this.capacity()) throw new ApplicationError(429,'Modeling job queue is full');
    for (const [id,job] of this.jobs) if (!['queued','running'].includes(job.status) && (this.jobs.size >= 32 || Date.now()-job.createdAt > 3600_000)) this.jobs.delete(id);
    const job: Job = {id:randomUUID(),status:'queued',createdAt:Date.now(),progress:{stage:'queued'},controller:new AbortController(),input,key,digest};
    this.jobs.set(job.id,job);
    void this.schedule(async()=>{
      if (job.controller.signal.aborted) return;
      job.status='running';
      const owned = job.input; delete job.input;
      try {
        const result = await this.application.execute(owned,{owned:true,signal:job.controller.signal,progress:p=>{job.progress=p;}});
        job.result=result;
        if(result.committed) { try { await this.committed(); } catch(error) { job.error={playbackReload:String(error)}; } }
        job.status='completed';job.progress={stage:'completed'};
      } catch(error) {
        job.status=job.controller.signal.aborted?'cancelled':'failed';job.progress={stage:job.status};
        job.error={message:error instanceof Error?error.message:String(error),status:error instanceof ApplicationError?error.status:400,...(error instanceof ApplicationError?error.details:{})};
      }
    }).catch(error=>{job.status='failed';job.error=String(error);delete job.input;});
    return this.view(job);
  }
  get(id: string) { const job=this.jobs.get(id);if(!job)throw new ApplicationError(404,'Unknown job; service may have restarted. Verify the stored revision before retrying a write.');return this.view(job); }
  cancel(id:string) {
    const job=this.jobs.get(id);if(!job)throw new ApplicationError(404,'Unknown job');
    if (job.progress.stage==='committing')throw new ApplicationError(409,'Atomic commit has started');
    if(['queued','running'].includes(job.status)){job.controller.abort();delete job.input;job.status='cancelled';job.progress={stage:'cancelled'};}
    return this.view(job);
  }
  close() { for(const job of this.jobs.values())if(job.progress.stage!=='committing')job.controller.abort(); }
  private view(job:Job) { return {id:job.id,status:job.status,createdAt:job.createdAt,progress:job.progress,result:job.result,error:job.error}; }
}
