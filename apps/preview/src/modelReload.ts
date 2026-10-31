/** One active load, latest state only, and bounded retries independent of SSE rate. */
export class ModelReload<State, Model> {
  private latest?: State;
  private installed?: string;
  private running = false;
  private stopped = false;
  private failures = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private options: {
    key(state: State): string; load(state: State): Promise<Model>;
    install(model: Model, state: State): void; apply(state: State): void;
    discard(model: Model): void; error(error: unknown): void;
    baseDelay?: number; maxDelay?: number; random?: () => number;
  }) {}
  update(state: State) {
    if (this.stopped) return;
    if (this.latest && this.options.key(this.latest) !== this.options.key(state)) {
      this.failures = 0; clearTimeout(this.timer); this.timer = undefined;
    }
    this.latest = state;
    void this.drain();
  }
  dispose() { this.stopped = true; this.latest = undefined; clearTimeout(this.timer); }
  private async drain() {
    if (this.running || this.stopped || this.timer || !this.latest) return;
    if (this.installed === this.options.key(this.latest)) { this.options.apply(this.latest); return; }
    this.running = true;
    const state = this.latest, key = this.options.key(state);
    try {
      const model = await this.options.load(state);
      if (this.stopped || !this.latest || key !== this.options.key(this.latest)) this.options.discard(model);
      else {
        this.options.install(model, this.latest); this.installed = key; this.failures = 0;
        this.options.apply(this.latest);
      }
    } catch (error) {
      if (!this.stopped && this.latest && key === this.options.key(this.latest)) {
        this.options.error(error);
        const delay = Math.min(this.options.maxDelay ?? 30_000, (this.options.baseDelay ?? 500) * 2 ** Math.min(this.failures++, 16));
        this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, Math.min(this.options.maxDelay ?? 30_000, delay * (0.8 + (this.options.random?.() ?? Math.random()) * 0.4)));
      }
    } finally {
      this.running = false;
      if (!this.stopped && !this.timer && this.latest && this.installed !== this.options.key(this.latest)) void this.drain();
    }
  }
}
