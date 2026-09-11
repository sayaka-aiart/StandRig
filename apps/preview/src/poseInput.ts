type Patch = Record<string, number>;

/** One request in flight; retain only the newest unsent value for each parameter. */
export class PoseInput {
  private pending: Patch = {};
  private active: Patch = {};
  private busy = false;
  private epoch = 0;
  constructor(private send: (patch: Patch) => Promise<unknown>, private accepted: (reply: unknown) => void, private failed: (error: unknown) => void) {}
  get optimistic(): Patch { return { ...this.active, ...this.pending }; }
  enqueue(patch: Patch) { Object.assign(this.pending, patch); void this.flush(); }
  reset() { this.epoch++; this.pending = {}; this.active = {}; }
  private async flush() {
    if (this.busy || !Object.keys(this.pending).length) return;
    this.busy = true;
    const epoch = this.epoch;
    this.active = this.pending; this.pending = {};
    try {
      const reply = await this.send(this.active);
      if (epoch === this.epoch) { this.active = {}; this.accepted(reply); }
    } catch (error) {
      if (epoch === this.epoch) { this.active = {}; this.failed(error); }
    } finally { this.busy = false; void this.flush(); }
  }
}
