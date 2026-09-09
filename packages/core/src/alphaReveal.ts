import type { RgbaImage } from "./png.js";
import type { ParameterValues, RigAlphaReveal } from "./types.js";

export function validateAlphaReveal(reveal: RigAlphaReveal): boolean {
  return Boolean(reveal && typeof reveal.parameter === "string" && reveal.parameter.length
    && Number.isFinite(reveal.closed) && Number.isFinite(reveal.open) && reveal.open > reveal.closed
    && Number.isFinite(reveal.exponent) && reveal.exponent > 0 && reveal.exponent <= 4
    && (reveal.anchor === undefined || (Number.isFinite(reveal.anchor) && reveal.anchor >= 0 && reveal.anchor <= 1)));
}

/** A column-shaped aperture closing toward a configurable point in the contour.
 * RGB stays untouched. Only the moving boundary has fractional coverage.
 * This also applies when the image is drawn as an alpha clipping source.
 */
export class AlphaRevealProcessor {
  private top: Int32Array;
  private bottom: Int32Array;
  private lastValue = -1;
  private lastImage: RgbaImage;
  constructor(private source: RgbaImage, private reveal: RigAlphaReveal) {
    this.top = new Int32Array(source.width).fill(source.height);
    this.bottom = new Int32Array(source.width).fill(-1);
    this.lastImage = source;
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
      if (source.data[(y * source.width + x) * 4 + 3]) {
        this.top[x] = Math.min(this.top[x], y);
        this.bottom[x] = y;
      }
    }
  }
  render(values: ParameterValues): RgbaImage {
    const raw = values[this.reveal.parameter] ?? this.reveal.open;
    const normalized = Number.isFinite(raw) ? Math.min(1, Math.max(0, (raw - this.reveal.closed) / (this.reveal.open - this.reveal.closed))) : 1;
    if (normalized === 1) return this.source;
    if (normalized === this.lastValue) return this.lastImage;
    const fraction = normalized ** this.reveal.exponent;
    const data = new Uint8ClampedArray(this.source.data);
    for (let x = 0; x < this.source.width; x++) {
      const span = this.bottom[x] + 1 - this.top[x];
      const start = this.top[x] + span * (1 - fraction) * (this.reveal.anchor ?? 0);
      const cut = start + span * fraction;
      for (let y = 0; y < this.source.height; y++) {
        const i = (y * this.source.width + x) * 4 + 3;
        data[i] = Math.round(data[i] * Math.max(0, Math.min(y + 1, cut) - Math.max(y, start)));
      }
    }
    this.lastValue = normalized;
    return this.lastImage = { width: this.source.width, height: this.source.height, data };
  }
}

const processors = new WeakMap<RgbaImage, { key: string; processor: AlphaRevealProcessor }>();
export function applyAlphaReveal(source: RgbaImage, reveal: RigAlphaReveal | undefined, values: ParameterValues): RgbaImage {
  if (!reveal || !validateAlphaReveal(reveal)) return source;
  const key = JSON.stringify(reveal);
  let entry = processors.get(source);
  if (!entry || entry.key !== key) { entry = { key, processor: new AlphaRevealProcessor(source, reveal) }; processors.set(source, entry); }
  return entry.processor.render(values);
}
