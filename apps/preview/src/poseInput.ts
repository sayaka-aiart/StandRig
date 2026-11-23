import type { VisemeId } from '@standrig/core/facialTypes';

type Patch = Record<string, number>;
type Pose = { values: Patch; clearViseme: boolean };
type Viseme = { id: VisemeId };
type PreviewInput = Pose | Viseme;

/** Keep parameters and vowel selections in order, coalescing adjacent edits. */
export class PoseInput {
  private pending: PreviewInput[] = [];
  private active?: PreviewInput;
  private busy = false;
  private epoch = 0;
  constructor(private send: (input: PreviewInput) => Promise<unknown>, private accepted: (reply: unknown) => void, private failed: (error: unknown) => void) {}
  get optimistic(): Patch {
    const values = this.active && 'values' in this.active ? { ...this.active.values } : {};
    for (const input of this.pending) if ('values' in input) Object.assign(values, input.values);
    return values;
  }
  enqueue(values: Patch, clearViseme = false) {
    const last = this.pending.at(-1);
    if (last && 'values' in last) {
      Object.assign(last.values, values);
      last.clearViseme ||= clearViseme;
    } else {
      this.pending.push({ values: { ...values }, clearViseme });
    }
    void this.flush();
  }
  enqueueViseme(id: VisemeId) {
    const last = this.pending.at(-1);
    if (last && 'id' in last) last.id = id;
    else this.pending.push({ id });
    void this.flush();
  }
  reset() { this.epoch++; this.pending = []; this.active = undefined; }
  private async flush() {
    if (this.busy) return;
    const input = this.pending.shift();
    if (!input) return;
    this.busy = true;
    const epoch = this.epoch;
    this.active = input;
    try {
      const reply = await this.send(input);
      if (epoch === this.epoch) { this.active = undefined; this.accepted(reply); }
    } catch (error) {
      if (epoch === this.epoch) { this.active = undefined; this.failed(error); }
    } finally { this.busy = false; void this.flush(); }
  }
}
