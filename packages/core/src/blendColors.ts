import { keyformGridIssues, sampleKeyformGrid } from "./multiBindings.js";
import type { ParameterValues, RigBlendColorKeyform, RigPart, RigPartBlendColors, RigRgb } from "./types.js";

export interface ResolvedBlendColors {
  multiply: RigRgb;
  screen: RigRgb;
}

const WHITE: RigRgb = [1, 1, 1];
const BLACK: RigRgb = [0, 0, 0];

/**
 * The multiply and screen colors a part draws with at these values, or undefined when they leave
 * the texture unchanged (white multiply, black screen), so callers can skip the pixel pass.
 */
export function resolvePartBlendColors(part: Pick<RigPart, "blendColors">, values: ParameterValues): ResolvedBlendColors | undefined {
  const colors = part.blendColors;
  if (!colors) return undefined;
  const staticMultiply = validRgb(colors.multiply) ? colors.multiply : WHITE;
  const staticScreen = validRgb(colors.screen) ? colors.screen : BLACK;
  let multiply = staticMultiply, screen = staticScreen;
  if (colors.parameters && colors.keyforms?.length) {
    multiply = sampleRgb(colors, values, (keyform) => keyform.multiply ?? staticMultiply) ?? staticMultiply;
    screen = sampleRgb(colors, values, (keyform) => keyform.screen ?? staticScreen) ?? staticScreen;
  }
  if (multiply.every((channel) => channel === 1) && screen.every((channel) => channel === 0)) return undefined;
  return { multiply, screen };
}

function sampleRgb(colors: RigPartBlendColors, values: ParameterValues, colorOf: (keyform: RigBlendColorKeyform) => RigRgb): RigRgb | undefined {
  const channels = [0, 1, 2].map((channel) => sampleKeyformGrid(colors.parameters!, colors.keyforms, (keyform) => colorOf(keyform)[channel], values));
  return channels.every((channel) => channel !== undefined) ? (channels.map((channel) => clamp01(channel!)) as RigRgb) : undefined;
}

/** Applies the multiply color, then the screen color, to one straight-alpha 0..255 channel. */
export function applyBlendColorChannel(source: number, multiply: number, screen: number): number {
  const multiplied = (source / 255) * multiply;
  return Math.round(255 * (multiplied + screen - multiplied * screen));
}

/** Applies the color pass to straight-alpha RGBA pixels into a new buffer. */
export function applyBlendColorsToRgba(pixels: Uint8ClampedArray | Uint8Array, colors: ResolvedBlendColors): Uint8ClampedArray {
  const output = new Uint8ClampedArray(pixels.length);
  const [mr, mg, mb] = colors.multiply, [sr, sg, sb] = colors.screen;
  for (let index = 0; index < pixels.length; index += 4) {
    output[index] = applyBlendColorChannel(pixels[index], mr, sr);
    output[index + 1] = applyBlendColorChannel(pixels[index + 1], mg, sg);
    output[index + 2] = applyBlendColorChannel(pixels[index + 2], mb, sb);
    output[index + 3] = pixels[index + 3];
  }
  return output;
}

/** A stable cache key for resolved colors, quantized to 8 bits per channel like the output. */
export function blendColorsCacheKey(colors: ResolvedBlendColors | undefined): string {
  if (!colors) return "";
  return [...colors.multiply, ...colors.screen].map((channel) => Math.round(channel * 255)).join(",");
}

export function blendColorIssues(colors: RigPartBlendColors | undefined, knownParameters: ReadonlySet<string>): string[] {
  if (colors === undefined) return [];
  if (!colors || typeof colors !== "object") return ["blendColors must be an object"];
  const issues: string[] = [];
  if (colors.multiply !== undefined && !validRgb(colors.multiply)) issues.push("multiply must be three numbers in 0..1");
  if (colors.screen !== undefined && !validRgb(colors.screen)) issues.push("screen must be three numbers in 0..1");
  if ((colors.parameters === undefined) !== (colors.keyforms === undefined)) issues.push("parameters and keyforms go together");
  if (colors.parameters !== undefined) {
    issues.push(...keyformGridIssues(colors.parameters, colors.keyforms, () => 0, knownParameters));
    for (const keyform of colors.keyforms ?? []) {
      if ((keyform.multiply !== undefined && !validRgb(keyform.multiply)) || (keyform.screen !== undefined && !validRgb(keyform.screen))) {
        issues.push("keyform colors must be three numbers in 0..1");
        break;
      }
    }
  }
  return issues;
}

function validRgb(color: unknown): color is RigRgb {
  return Array.isArray(color) && color.length === 3 && color.every((channel) => typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 1);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
