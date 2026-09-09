import { auditRgbaImage, diffRgbaImages, type AlphaBoundingBox, type RgbaImageAudit } from "./imageAudit.js";
import { defaultParameterValues } from "./parameters.js";
import { decodePng } from "./png.js";
import { renderRigScreenshot } from "./serverRenderer.js";
import type { ParameterValues, RigDocument } from "./types.js";

export interface SkinningRenderQaOptions {
  samples?: ParameterValues[];
  width?: number;
  height?: number;
  maxAlphaLossRatio?: number;
  maxCoverageLossRatio?: number;
  maxEdgeContactIncrease?: number;
  diffChannelThreshold?: number;
}

export interface SkinningRenderQaEntry {
  sampleIndex: number;
  width: number;
  height: number;
  diffPixelRatio: number;
  alphaLossRatio: number;
  alphaGainRatio: number;
  beforeCoverage: number;
  afterCoverage: number;
  coverageLossRatio: number;
  beforeBBox: AlphaBoundingBox | null;
  afterBBox: AlphaBoundingBox | null;
  beforeEdgeContact: number;
  afterEdgeContact: number;
  pass: boolean;
  issues: string[];
}

export interface SkinningRenderQaResult {
  pass: boolean;
  partIds: string[];
  sampleCount: number;
  width: number;
  height: number;
  maxAlphaLossRatio: number;
  maxCoverageLossRatio: number;
  maxEdgeContactIncrease: number;
  entries: SkinningRenderQaEntry[];
  issues: string[];
}

/** Compare a candidate's focused server render against the production rig. */
export async function runSkinningRenderQa(
  beforeRig: RigDocument,
  candidateRig: RigDocument,
  publicDir: string,
  partIds: readonly string[],
  options: SkinningRenderQaOptions = {}
): Promise<SkinningRenderQaResult> {
  const width = clampInteger(options.width ?? 240, 64, 480);
  const height = clampInteger(options.height ?? 240, 64, 480);
  const maxAlphaLossRatio = clamp(Number(options.maxAlphaLossRatio ?? 0.2), 0, 1, 0.2);
  const maxCoverageLossRatio = clamp(Number(options.maxCoverageLossRatio ?? 0.35), 0, 1, 0.35);
  const maxEdgeContactIncrease = clamp(Number(options.maxEdgeContactIncrease ?? 0.1), 0, 1, 0.1);
  const diffChannelThreshold = clampInteger(options.diffChannelThreshold ?? 2, 0, 255);
  const defaults = defaultParameterValues(beforeRig);
  const samples = (options.samples?.length ? options.samples : [{}]).map((sample) => ({ ...defaults, ...sample }));
  const entries: SkinningRenderQaEntry[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const values = samples[index];
    const renderOptions = {
      width,
      height,
      fitPadding: 12,
      transparent: true,
      set: "single" as const,
      detail: "full" as const,
      focusParts: false,
      partIds: [...partIds],
      forceParts: true,
      values,
      physics: false,
      physicsTime: 0,
      physicsSteps: 0,
      supersample: 1
    };
    const before = decodePng((await renderRigScreenshot(beforeRig, publicDir, renderOptions)).png);
    const after = decodePng((await renderRigScreenshot(candidateRig, publicDir, renderOptions)).png);
    entries.push(auditRenderPair(before, after, index, { width, height, maxAlphaLossRatio, maxCoverageLossRatio, maxEdgeContactIncrease, diffChannelThreshold }));
  }
  const issues = entries.flatMap((entry) => entry.issues.map((issue) => `sample-${entry.sampleIndex}: ${issue}`));
  return { pass: entries.length > 0 && issues.length === 0, partIds: [...partIds], sampleCount: entries.length, width, height, maxAlphaLossRatio, maxCoverageLossRatio, maxEdgeContactIncrease, entries, issues };
}

function auditRenderPair(before: ReturnType<typeof decodePng>, after: ReturnType<typeof decodePng>, sampleIndex: number, limits: { width: number; height: number; maxAlphaLossRatio: number; maxCoverageLossRatio: number; maxEdgeContactIncrease: number; diffChannelThreshold: number }): SkinningRenderQaEntry {
  const diff = diffRgbaImages(before, after, { diffChannelThreshold: limits.diffChannelThreshold, alphaChangeThreshold: 2 });
  const beforeAudit = diff.before;
  const afterAudit = diff.after;
  const beforeCoverage = coverage(beforeAudit);
  const afterCoverage = coverage(afterAudit);
  const alphaLossRatio = beforeAudit.nonTransparentPixelCount ? diff.alphaLossPixelCount / beforeAudit.nonTransparentPixelCount : 0;
  const alphaGainRatio = beforeAudit.nonTransparentPixelCount ? diff.alphaGainPixelCount / beforeAudit.nonTransparentPixelCount : 0;
  const coverageLossRatio = beforeAudit.nonTransparentPixelCount ? Math.max(0, beforeAudit.nonTransparentPixelCount - afterAudit.nonTransparentPixelCount) / beforeAudit.nonTransparentPixelCount : 0;
  const beforeEdgeContact = beforeAudit.totalPixelCount ? beforeAudit.edgeContact.pixelCount / beforeAudit.totalPixelCount : 0;
  const afterEdgeContact = afterAudit.totalPixelCount ? afterAudit.edgeContact.pixelCount / afterAudit.totalPixelCount : 0;
  const issues: string[] = [];
  if (!afterAudit.nonTransparentPixelCount) issues.push("empty-candidate-render");
  if (alphaLossRatio > limits.maxAlphaLossRatio) issues.push(`alpha-loss-ratio ${alphaLossRatio.toFixed(4)} exceeds ${limits.maxAlphaLossRatio.toFixed(4)}`);
  if (coverageLossRatio > limits.maxCoverageLossRatio) issues.push(`coverage-loss-ratio ${coverageLossRatio.toFixed(4)} exceeds ${limits.maxCoverageLossRatio.toFixed(4)}`);
  if (afterEdgeContact - beforeEdgeContact > limits.maxEdgeContactIncrease) issues.push(`edge-contact increase ${(afterEdgeContact - beforeEdgeContact).toFixed(4)} exceeds ${limits.maxEdgeContactIncrease.toFixed(4)}`);
  return { sampleIndex, width: limits.width, height: limits.height, diffPixelRatio: diff.diffPixelRatio, alphaLossRatio, alphaGainRatio, beforeCoverage, afterCoverage, coverageLossRatio, beforeBBox: beforeAudit.alphaBBox, afterBBox: afterAudit.alphaBBox, beforeEdgeContact, afterEdgeContact, pass: issues.length === 0, issues };
}

function coverage(audit: RgbaImageAudit): number { return audit.totalPixelCount ? audit.nonTransparentPixelCount / audit.totalPixelCount : 0; }
function clamp(value: number, min: number, max: number, fallback: number): number { return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback; }
function clampInteger(value: number, min: number, max: number): number { return Math.round(clamp(Number(value), min, max, min)); }