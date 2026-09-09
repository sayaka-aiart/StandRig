import type { RigPartTint } from "./types.js";

export function validatePartTint(tint: RigPartTint | undefined): string[] {
  if (!tint) return [];
  const issues: string[] = [];
  if (tint.mode !== "multiply" && tint.mode !== "screen") issues.push("tint-mode-invalid");
  if (typeof tint.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(tint.color)) issues.push("tint-color-invalid");
  if (!Number.isFinite(tint.opacity) || tint.opacity < 0 || tint.opacity > 1) issues.push("tint-opacity-invalid");
  return issues;
}

export function parseTintColor(color: string): [number, number, number] {
  const value = color.replace(/^#/, "");
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

export function applyTintChannel(source: number, tint: number, opacity: number, mode: "multiply" | "screen"): number {
  const s = source / 255;
  const t = tint / 255;
  const blended = mode === "multiply" ? s * t : 1 - (1 - s) * (1 - t);
  return Math.round(255 * (s * (1 - opacity) + blended * opacity));
}