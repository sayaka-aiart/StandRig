import type { RgbaImage } from "./png.js";
import type { ParameterValues, RigContourShade } from "./types.js";

export function validateContourShade(shade: RigContourShade): boolean {
  return Boolean(shade && /^#[0-9a-fA-F]{6}$/.test(shade.color)
    && typeof shade.yawParameter === "string" && shade.yawParameter.length
    && typeof shade.pitchParameter === "string" && shade.pitchParameter.length
    && Number.isFinite(shade.maxYaw) && shade.maxYaw > 0
    && Number.isFinite(shade.maxPitch) && shade.maxPitch > 0
    && Number.isFinite(shade.width) && shade.width > 0 && shade.width <= 0.5
    && Number.isFinite(shade.strength) && shade.strength >= 0 && shade.strength <= 1
    && Number.isFinite(shade.axisStrength) && shade.axisStrength >= 0 && shade.axisStrength <= 1
    && (shade.profile === undefined || shade.profile === "cheek")
    && (shade.farContourFade === undefined || (Number.isFinite(shade.farContourFade) && shade.farContourFade >= 0 && shade.farContourFade <= 1))
    && (shade.nearContourFade === undefined || (Number.isFinite(shade.nearContourFade) && shade.nearContourFade >= 0 && shade.nearContourFade <= 1))
    && (shade.lineWidth === undefined || (Number.isFinite(shade.lineWidth) && shade.lineWidth > 0 && shade.lineWidth <= .1)));
}

const smooth = (value: number) => { const t = Math.min(1, Math.max(0, value)); return t * t * (3 - 2 * t); };
// Color is multiplied into the source before mesh rasterization. Alpha and UVs
// stay identical, so triangle coverage cannot accumulate a separate shadow.
export class ContourShadeProcessor {
  private left: Float32Array;
  private right: Float32Array;
  private color: number[];
  private lastKey = "";
  private lastImage: RgbaImage;
  private volumeLeft?: Float32Array[];
  private volumeRight?: Float32Array[];
  private fadeLeft?: Float32Array;
  private fadeRight?: Float32Array;
  private nearFadeLeft?: Float32Array;
  private nearFadeRight?: Float32Array;
  private skinLeft?: Float32Array;
  private skinRight?: Float32Array;
  constructor(private source: RgbaImage, private shade: RigContourShade) {
    this.left = new Float32Array(source.width * source.height);
    this.right = new Float32Array(this.left.length);
    this.color = [1, 3, 5].map(i => parseInt(shade.color.slice(i, i + 2), 16) / 255);
    this.lastImage = source;
    if (shade.profile === "cheek") {
      this.volumeLeft = [-1, 0, 1].map(() => new Float32Array(this.left.length));
      this.volumeRight = [-1, 0, 1].map(() => new Float32Array(this.left.length));
    }
    if (shade.farContourFade || shade.nearContourFade) {
      this.fadeLeft = new Float32Array(this.left.length);
      this.fadeRight = new Float32Array(this.left.length);
      this.skinLeft = new Float32Array(source.height * 3);
      this.skinRight = new Float32Array(source.height * 3);
    }
    if (shade.nearContourFade) {
      this.nearFadeLeft = new Float32Array(this.left.length);
      this.nearFadeRight = new Float32Array(this.left.length);
    }
    const band = Math.max(1, source.width * shade.width);
    for (let y = 0; y < source.height; y++) {
      let l = source.width, r = -1;
      for (let x = 0; x < source.width; x++) if (source.data[(y * source.width + x) * 4 + 3] > 0) { l = Math.min(l, x); r = x; }
      if (r < l) continue;
      // Detached antialias pixels must not move the cheek boundary away from
      // its ink. Locate the main opaque span for the optional surface effects.
      let surfaceL = l, surfaceR = r, runStart = -1, longest = 0;
      if (this.volumeLeft || this.fadeLeft) for (let x = l; x <= r + 1; x++) {
        if (x <= r && source.data[(y * source.width + x) * 4 + 3] >= 128) {
          if (runStart < 0) runStart = x;
        } else if (runStart >= 0) {
          if (x - runStart > longest) { longest = x - runStart; surfaceL = runStart; surfaceR = x - 1; }
          runStart = -1;
        }
      }
      const v = y / Math.max(1, source.height - 1);
      const inkBand = Math.max(1, source.width * (shade.lineWidth ?? .035));
      const inset = Math.min((surfaceR - surfaceL) / 2, inkBand * 2.1);
      const skinX = [Math.round(surfaceL + inset), Math.round(surfaceR - inset)];
      for (let c = 0; c < 3; c++) {
        if (this.skinLeft) this.skinLeft[y * 3 + c] = source.data[(y * source.width + skinX[0]) * 4 + c];
        if (this.skinRight) this.skinRight[y * 3 + c] = source.data[(y * source.width + skinX[1]) * 4 + c];
      }
      // Preserve the chin line and the upper scalp. Only the cheek ink fades.
      const cheekInk = smooth((v - .56) / .09) * (1 - smooth((v - .88) / .08));
      // The lower near cheek overlaps the neck: replace its ink with the
      // shaded skin plane, tapering only at the very tip of the chin.
      const nearCheekInk = smooth((v - .63) / .17) * (1 - smooth((v - .985) / .015));
      const widths = [-1, 0, 1].map(pitch => band
        * (.4 + .85 * Math.exp(-(((v - (.70 + .055 * pitch)) / .17) ** 2)))
        * (1 - .6 * smooth((v - .87) / .11)));
      const cheekPlane = smooth((v - .40) / .16) * (1 - .75 * smooth((v - .94) / .06));
      for (let x = l; x <= r; x++) {
        const p = y * source.width + x;
        this.left[p] = Math.exp(-(((x - l) / band) ** 2));
        this.right[p] = Math.exp(-(((r - x) / band) ** 2));
        if (this.volumeLeft && this.volumeRight) for (let k = 0; k < 3; k++) {
          this.volumeLeft[k][p] = cheekPlane * (1 - smooth(((x - surfaceL) / widths[k] - .2) / .8));
          this.volumeRight[k][p] = cheekPlane * (1 - smooth(((surfaceR - x) / widths[k] - .2) / .8));
        }
        for (const [distance, field, nearField, skin] of [[x - surfaceL, this.fadeLeft, this.nearFadeLeft, this.skinLeft], [surfaceR - x, this.fadeRight, this.nearFadeRight, this.skinRight]] as const) {
          if (!field || !skin) continue;
          const i = p * 4;
          const contrast = (skin[y * 3] - source.data[i]) * .2126
            + (skin[y * 3 + 1] - source.data[i + 1]) * .7152
            + (skin[y * 3 + 2] - source.data[i + 2]) * .0722;
          const edgeInk = distance < -inkBand ? 0 : (1 - smooth((distance / inkBand - .5) / .5)) * smooth((contrast - 5) / 26);
          field[p] = cheekInk * edgeInk;
          if (nearField) nearField[p] = nearCheekInk * edgeInk;
        }
      }
    }
  }
  render(values: ParameterValues): RgbaImage {
    const yaw = values[this.shade.yawParameter] ?? 0;
    const pitch = values[this.shade.pitchParameter] ?? 0;
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return this.source;
    const yawWeight = smooth(Math.abs(yaw) / this.shade.maxYaw);
    const fade = (this.shade.farContourFade ?? 0) * yawWeight;
    // The near outline yields to the shaded cheek plane before maximum yaw.
    const nearFade = (this.shade.nearContourFade ?? 0) * smooth(Math.abs(yaw) / (this.shade.maxYaw * 2 / 3));
    const strength = this.shade.strength * smooth(Math.abs(yaw) / this.shade.maxYaw)
      * (this.shade.axisStrength + (1 - this.shade.axisStrength) * smooth(Math.abs(pitch) / this.shade.maxPitch));
    if (strength <= 0 && fade <= 0 && nearFade <= 0) return this.source;
    const pitchWeight = Math.min(1, Math.abs(pitch) / this.shade.maxPitch);
    const key = `${yaw < 0}:${strength}:${fade}:${nearFade}:${this.shade.profile ? pitch : 0}`;
    if (key === this.lastKey) return this.lastImage;
    const weights = yaw < 0 ? this.right : this.left;
    const volume = yaw < 0 ? this.volumeRight : this.volumeLeft;
    const fadeWeights = yaw < 0 ? this.fadeLeft : this.fadeRight;
    const skin = yaw < 0 ? this.skinLeft : this.skinRight;
    const nearFadeWeights = yaw < 0 ? this.nearFadeRight : this.nearFadeLeft;
    const nearSkin = yaw < 0 ? this.skinRight : this.skinLeft;
    const data = new Uint8ClampedArray(this.source.data);
    for (let p = 0; p < weights.length; p++) {
      const i = p * 4;
      if (!data[i + 3]) continue;
      const weight = volume ? volume[1][p] * (1 - pitchWeight) + volume[pitch < 0 ? 0 : 2][p] * pitchWeight : weights[p];
      const a = weight * strength;
      const ink = fade * (fadeWeights?.[p] ?? 0);
      const nearInk = nearFade * (nearFadeWeights?.[p] ?? 0);
      const row = Math.floor(p / this.source.width) * 3;
      for (let c = 0; c < 3; c++) {
        const skinColor = skin?.[row + c] ?? data[i + c];
        const farSoftened = data[i + c] + ink * (skinColor - data[i + c]);
        const softened = farSoftened + nearInk * ((nearSkin?.[row + c] ?? farSoftened) - farSoftened);
        data[i + c] = Math.round(softened * (1 - a * (1 - this.color[c])));
      }
    }
    this.lastKey = key;
    return this.lastImage = { width: this.source.width, height: this.source.height, data };
  }
}

const processors = new WeakMap<RgbaImage, { key: string; processor: ContourShadeProcessor }>();
export function applyContourShade(source: RgbaImage, shade: RigContourShade | undefined, values: ParameterValues): RgbaImage {
  if (!shade || !validateContourShade(shade)) return source;
  const key = JSON.stringify(shade);
  let entry = processors.get(source);
  if (!entry || entry.key !== key) { entry = { key, processor: new ContourShadeProcessor(source, shade) }; processors.set(source, entry); }
  return entry.processor.render(values);
}
