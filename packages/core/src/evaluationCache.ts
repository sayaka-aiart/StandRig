/** Derived indexes for an owned, stable model snapshot. Never use across edits. */
export class EvaluationCache {
  private readonly buckets = new Map<string, WeakMap<object, unknown>>();
  get<T>(bucket: string, key: object, build: () => T): T {
    let entries = this.buckets.get(bucket);
    if (!entries) { entries = new WeakMap(); this.buckets.set(bucket, entries); }
    if (entries.has(key)) return entries.get(key) as T;
    const value = build(); entries.set(key, value); return value;
  }
}

let active: EvaluationCache | undefined;

/** Scope is synchronous, so other mutable models and concurrent async work stay uncached. */
export function withEvaluationCache<T>(cache: EvaluationCache | undefined, evaluate: () => T): T {
  const previous = active;
  active = cache;
  try { return evaluate(); } finally { active = previous; }
}

export function evaluationCache(): EvaluationCache | undefined { return active; }
