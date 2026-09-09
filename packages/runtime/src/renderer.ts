import { evaluateRigParts, resolveRigFrame, invertMatrix, multiplyMatrices, applyPhysicsParameterOffsets, resolvePhysicsFrame as resolveRuntimePhysicsFrame, scaleMatrix, transformMatrixPoint, translateMatrix, type EvaluatedPartState, type Matrix2D, type PhysicsValue } from "@standrig/core/evaluator";
import { hasWarpEffect, normalizeWarpDeformer, warpPoint, type ResolvedWarpDeformer } from "@standrig/core/warp";
import { hasSharedWarpFieldEffect, normalizeSharedWarpField } from "@standrig/core/sharedWarp";
import { projectSharedWarpPoint, unprojectSharedWarpPoint } from "@standrig/core/sharedWarpProjection";
import { readRigGlue } from "@standrig/core/glue";
import { resolveGlueWarpForPart } from "@standrig/core/glueWarp";
import { isCanonicalArtMesh, resolveArtMesh, type ResolvedArtMesh } from "@standrig/core/artMesh";
import { readRigArtPaths, resolveArtPath } from "@standrig/core/artPath";
import { applySkinningToVertices } from "@standrig/core/skinning";
import { glueStitchOffsetToLocal, hasGlueStitches, glueStitchRestScale, projectArtMeshVertex, resolveGlueStitchOffsets, type GlueVertexOffset, type GlueVertexOffsets } from "@standrig/core/glueVertex";
import { createPartClipResolver, sameResolvedPartClip } from "@standrig/core/mask";
import { prepareRigBindingOrder } from "@standrig/core/bindingPreparation";
import { ContourShadeProcessor, validateContourShade } from "@standrig/core/contourShade";
import { AlphaRevealProcessor, validateAlphaReveal } from "@standrig/core/alphaReveal";
import type { RgbaImage } from "@standrig/core/png";
import { expandTriangleForCoverage, localCoverageOverlap } from "@standrig/core/triangleCoverage";
import { alphaMaskHit, triangleUvAtPoint, type AlphaMask, type HitVertex } from "@standrig/core/hitTesting";
import { comparePixelBuffers, WebGLArtMeshRenderer, type PixelParityResult } from "./webglMesh.js";
import type {
  AssetDefinition,
  ParameterValues,
  PhysicsChain,
  RigDeformer,
  RigDocument,
  RigGlue,
  RigPart,
  TransformProperty
} from "@standrig/core/types";


async function waitForWebGLRendererStatus(renderer: WebGLArtMeshRenderer, expected: "ready" | "context-lost" | "restore-failed", timeoutMs = 1000): Promise<boolean> {
  if (renderer.status === expected) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      renderer.canvas.removeEventListener("webglcontextlost", onChange);
      renderer.canvas.removeEventListener("webglcontextrestored", onChange);
      window.clearTimeout(timeoutId);
      resolve(value);
    };
    const onChange = () => finish(renderer.status === expected);
    const timeoutId = window.setTimeout(() => finish(renderer.status === expected), Math.max(0, timeoutMs));
    renderer.canvas.addEventListener("webglcontextlost", onChange);
    renderer.canvas.addEventListener("webglcontextrestored", onChange);
  });
}

interface CanvasView {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  pixelWidth: number;
  pixelHeight: number;
  fittedScale: number;
  offsetX: number;
  offsetY: number;
  cssBaseMatrix: Matrix2D;
  pixelBaseMatrix: Matrix2D;
}

export interface WarpPinHandle {
  deformerId: string;
  partId: string;
  pinIndex: number;
  pinId: string;
  name: string;
  x: number;
  y: number;
  radiusPx: number;
  targetX: number;
  targetY: number;
  offsetX: number;
  offsetY: number;
  u: number;
  v: number;
  enabled: boolean;
}

export interface SharedWarpHandle {
  deformerId: string;
  pointIndex: number;
  pointId: string;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  enabled: boolean;
}
export interface ArtMeshVertexHandle {
  partId: string;
  vertexIndex: number;
  vertexId: string;
  x: number;
  y: number;
  localX: number;
  localY: number;
  u: number;
  v: number;
}
export interface GlueSeamHandle {
  glueId: string;
  glueName: string;
  seamIndex: number;
  side: "a" | "b";
  partId: string;
  partName: string;
  x: number;
  y: number;
  u: number;
  v: number;
  radiusPx: number;
  strength: number;
  enabled: boolean;
}

const MIN_SCALE = 0.001;

export interface RenderOptions {
  transparent?: boolean;
  showBounds?: boolean;
  fitPadding?: number;
  selectedPartId?: string;
  selectedDeformerId?: string;
  selectedWarpPinIndex?: number;
  selectedArtMeshVertexIndex?: number;
  warpPinEditMode?: "position" | "offset";
  webglMesh?: boolean;
  /** Diagnostic filter: only these part IDs use the WebGL ArtMesh path. */
  webglMeshPartIds?: readonly string[];
  /** Display-only zoom multiplier around the stage center. */
  zoom?: number;
  /** Display-only pan in CSS pixels; canvas dataset is used when omitted. */
  panX?: number;
  panY?: number;
}


export class RigRuntime {
  rig: RigDocument;

  private images = new Map<string, HTMLImageElement>();
  private tintedImages = new Map<string, HTMLCanvasElement>();
  private revealImages = new Map<string, { source: CanvasImageSource; key: string; processor: AlphaRevealProcessor; canvas: HTMLCanvasElement; last?: RgbaImage }>();
  private contourImages = new Map<string, { source: CanvasImageSource; key: string; processor: ContourShadeProcessor; canvas: HTMLCanvasElement; last?: RgbaImage }>();
  private alphaMasks = new Map<string, AlphaMask>();
  private physicsState = new Map<string, PhysicsValue>();
  private lastFrameTime = performance.now();
  private clippingLayers: Array<HTMLCanvasElement | undefined> = [undefined, undefined];
  private clippingLayerAllocations = 0;
  private webglMeshRenderer?: WebGLArtMeshRenderer;
  private webglMeshError?: string;

  constructor(rig: RigDocument) {
    this.rig = prepareRigBindingOrder(rig);
  }

  resumeClock() { this.lastFrameTime = performance.now(); }
  resetPhysics() { this.physicsState.clear(); this.resumeClock(); }

  async setRig(rig: RigDocument) {
    this.rig = prepareRigBindingOrder(rig);
    this.images.clear();
    this.tintedImages.clear();
    this.revealImages.clear();
    this.contourImages.clear();
    this.alphaMasks.clear();
    this.physicsState.clear();
    await this.loadAssets();
  }

  async loadAssets() {
    const pending = this.rig.assets.map((asset) => this.loadAsset(asset));
    await Promise.all(pending);
  }

  getWebGLMeshStatus() {
    const renderer = this.webglMeshRenderer;
    return { supported: Boolean(renderer), status: renderer?.status ?? "canvas-fallback", error: this.webglMeshError };
  }

  async probeWebGLContextRecovery(delayMs = 0) {
    const renderer = this.getWebGLMeshRenderer(true);
    if (!renderer) return { supported: false, statusAfterLoss: "unsupported", statusAfterRestore: "unsupported" };
    const simulated = renderer.simulateContextLoss();
    if (!simulated) return { supported: true, simulated: false, statusAfterLoss: renderer.status, statusAfterRestore: renderer.status };
    const lossObserved = await waitForWebGLRendererStatus(renderer, "context-lost");
    const statusAfterLoss = renderer.status;
    await new Promise((resolve) => window.setTimeout(resolve, Math.max(16, Math.min(2000, delayMs))));
    const restoreRequested = renderer.simulateContextRestore();
    const restoreObserved = restoreRequested && await waitForWebGLRendererStatus(renderer, "ready");
    if (restoreObserved) await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
    const restored = lossObserved && restoreObserved && renderer.status === "ready";
    return { supported: true, simulated: true, restored, statusAfterLoss, statusAfterRestore: renderer.status };
  }

  renderParity(canvas: HTMLCanvasElement, params: ParameterValues, options: { fitPadding?: number; threshold?: number; maxDifferingPixelRatio?: number; maxMeanChannelDelta?: number; webglMeshPartIds?: readonly string[] } = {}): PixelParityResult & { physics: "disabled"; webglStatus: ReturnType<RigRuntime["getWebGLMeshStatus"]> } {
    const context = canvas.getContext("2d");
    if (!context || canvas.width <= 0 || canvas.height <= 0) {
      return { width: canvas.width, height: canvas.height, differingPixels: 0, differingPixelRatio: 1, maxChannelDelta: 0, meanChannelDelta: 0, gate: { maxDifferingPixelRatio: options.maxDifferingPixelRatio ?? 0.0005, maxMeanChannelDelta: options.maxMeanChannelDelta ?? 0.25 }, pass: false, physics: "disabled", webglStatus: this.getWebGLMeshStatus() };
    }
    const previous = context.getImageData(0, 0, canvas.width, canvas.height);
    this.render(canvas, params, { transparent: true, fitPadding: options.fitPadding ?? 18, webglMesh: false });
    const canvasPixels = context.getImageData(0, 0, canvas.width, canvas.height);
    this.render(canvas, params, { transparent: true, fitPadding: options.fitPadding ?? 18, webglMesh: true, webglMeshPartIds: options.webglMeshPartIds });
    const webglPixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const compared = comparePixelBuffers(canvasPixels.data, webglPixels.data, canvas.width, canvas.height, options.threshold ?? 2, { maxDifferingPixelRatio: options.maxDifferingPixelRatio ?? 0.0005, maxMeanChannelDelta: options.maxMeanChannelDelta ?? 0.25 });
    context.putImageData(previous, 0, 0);
    return { ...compared, physics: "disabled", webglStatus: this.getWebGLMeshStatus() };
  }
  render(canvas: HTMLCanvasElement, params: ParameterValues, options: RenderOptions = {}) {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const view = this.getCanvasView(canvas, options);
    if (canvas.width !== view.pixelWidth || canvas.height !== view.pixelHeight) {
      canvas.width = view.pixelWidth;
      canvas.height = view.pixelHeight;
    }

    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, view.cssWidth, view.cssHeight);

    if (!options.transparent) {
      drawChecker(ctx, view.cssWidth, view.cssHeight);
    }

    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;

    const frame = resolveRigFrame(this.rig, params, view.pixelBaseMatrix, { physicsState: this.physicsState, physicsTime: now / 1000, physicsDt: dt });
    const effectiveParams = frame.values;
    const computed = frame.parts;
    const skinningTransforms = frame.skinningTransforms;
    // Vertex glue is solved once per frame against the same projected positions the draw loop uses,
    // so Canvas, WebGL and the server renderer close a seam by the identical amount.
    const glueStitch = hasGlueStitches(this.rig)
      ? resolveGlueStitchOffsets(this.rig, {
          restScale: glueStitchRestScale(view.pixelBaseMatrix),
          projectVertex: (partId, vertexId) => this.projectGlueVertex(partId, vertexId, computed, effectiveParams, view.pixelBaseMatrix, skinningTransforms)
        }).offsets
      : undefined;
    const webglMeshRenderer = this.getWebGLMeshRenderer(options.webglMesh === true);
    const webglMeshPartIds = options.webglMeshPartIds?.length ? new Set(options.webglMeshPartIds) : undefined;
    // Rect-grid meshes retain a complete image rectangle and are intentionally
    // kept on the Canvas path even when they are deformed. This avoids a
    // second rasterization seam at the WebGL boundary; alpha-contour meshes
    // remain the explicit WebGL opt-in path for sparse geometry.
    const webglRendererForPart = (part: RigPart) => webglMeshRenderer && part.artMesh?.generator.topology === "alpha-contour" && (!webglMeshPartIds || webglMeshPartIds.has(part.id)) ? webglMeshRenderer : undefined;
    const renderable = [...this.rig.parts]
      .filter((part) => part.kind === "image" && part.assetId)
      .sort((left, right) => left.drawOrder - right.drawOrder);

    const resolveClip = createPartClipResolver(this.rig);
    for (let index = 0; index < renderable.length;) {
      const part = renderable[index];
      const clip = resolveClip(part);
      if (!clip) {
        this.drawRenderablePart(ctx, part, computed, effectiveParams, view.pixelBaseMatrix, false, webglRendererForPart(part), skinningTransforms, glueStitch);
        this.drawPartDebug(ctx, part, computed, view, options);
        index += 1;
        continue;
      }

      const maskedParts: RigPart[] = [];
      while (index < renderable.length && sameResolvedPartClip(clip, resolveClip(renderable[index]))) {
        maskedParts.push(renderable[index]);
        index += 1;
      }
      const contentLayer = this.prepareClippingLayer(canvas, 0);
      const contentContext = contentLayer.getContext("2d");
      const maskLayer = this.prepareClippingLayer(canvas, 1);
      const maskContext = maskLayer.getContext("2d");
      if (!contentContext || !maskContext) {
        for (const maskedPart of maskedParts) {
          this.drawRenderablePart(ctx, maskedPart, computed, effectiveParams, view.pixelBaseMatrix, false, webglRendererForPart(maskedPart), skinningTransforms, glueStitch);
          this.drawPartDebug(ctx, maskedPart, computed, view, options);
        }
        continue;
      }

      for (const maskedPart of maskedParts) this.drawRenderablePart(contentContext, maskedPart, computed, effectiveParams, view.pixelBaseMatrix, false, webglRendererForPart(maskedPart), skinningTransforms, glueStitch);
      for (const maskPart of clip.maskParts) this.drawRenderablePart(maskContext, maskPart, computed, effectiveParams, view.pixelBaseMatrix, clip.clip.maskOpacity === "ignore", webglRendererForPart(maskPart), skinningTransforms, glueStitch);
      contentContext.save();
      contentContext.setTransform(1, 0, 0, 1, 0, 0);
      contentContext.globalAlpha = 1;
      contentContext.globalCompositeOperation = "destination-in";
      contentContext.drawImage(maskLayer, 0, 0);
      contentContext.restore();
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(contentLayer, 0, 0);
      ctx.restore();
      for (const maskedPart of maskedParts) this.drawPartDebug(ctx, maskedPart, computed, view, options);
    }
    if (options.showBounds) {
      this.drawGlueOverlay(ctx, computed, view);
    }

    if (options.selectedDeformerId) {
      this.drawWarpPinOverlay(ctx, params, view, options);
    }

    if (options.selectedPartId) {
      this.drawArtMeshOverlay(ctx, params, view, options);
    }

    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  }

  hitTestPart(
    canvas: HTMLCanvasElement,
    params: ParameterValues,
    clientX: number,
    clientY: number,
    options: RenderOptions = {}
  ): string | undefined {
    const view = this.getCanvasView(canvas, options);
    const point = this.cssPointFromClient(canvas, clientX, clientY);
    const computed = this.computePartStates(params, new Map(), view.cssBaseMatrix);
    const renderable = [...this.rig.parts]
      .filter((part) => part.kind === "image" && part.assetId)
      .sort((left, right) => right.drawOrder - left.drawOrder);

    for (const part of renderable) {
      const size = this.partSize(part);
      const partState = computed.get(part.id);
      if (!size || !partState || !partState.visible || partState.opacity <= 0) {
        continue;
      }

      if (this.hitTestRenderablePart(point, part, partState, size, computed, params, view.cssBaseMatrix)) {
        return part.id;
      }
    }

    return undefined;
  }

  private hitTestRenderablePart(
    point: { x: number; y: number }, part: RigPart, partState: EvaluatedPartState,
    size: { image: HTMLImageElement; width: number; height: number }, computed: Map<string, EvaluatedPartState>,
    params: ParameterValues, baseMatrix: Matrix2D
  ): boolean {
    const left = -partState.pose.pivotX * size.width, top = -partState.pose.pivotY * size.height;
    const bounds = { left, top, width: size.width, height: size.height };
    const warp = this.resolveRenderableWarp(part, partState, size, computed);
    const artMesh = resolveArtMesh(part, size.width, size.height, params);
    const project = (x: number, y: number, u: number, v: number): HitVertex => {
      const warped = hasWarpEffect(warp) ? warpPoint(x, y, bounds, warp) : { x, y };
      const rendered = projectSharedWarpPoint(warped, partState.matrix, baseMatrix, partState.sharedWarps);
      return { x: rendered.x, y: rendered.y, u, v };
    };
    let vertices: HitVertex[] = [], triangles: number[] = [];
    if (artMesh) {
      vertices = artMesh.vertices.map((vertex) => project(left + vertex.x, top + vertex.y, vertex.u, vertex.v));
      triangles = artMesh.triangles;
    } else {
      const columns = Math.max(1, Math.round(warp?.grid.columns ?? 1), ...(partState.sharedWarps?.filter(hasSharedWarpFieldEffect).map((field) => field.grid.columns) ?? []));
      const rows = Math.max(1, Math.round(warp?.grid.rows ?? 1), ...(partState.sharedWarps?.filter(hasSharedWarpFieldEffect).map((field) => field.grid.rows) ?? []));
      for (let row = 0; row <= rows; row += 1) for (let column = 0; column <= columns; column += 1) { const u = column / columns, v = row / rows; vertices.push(project(left + u * size.width, top + v * size.height, u, v)); }
      const stride = columns + 1;
      for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) { const a = row * stride + column, b = a + 1, d = a + stride, c = d + 1; triangles.push(a, b, c, a, c, d); }
    }
    const mask = part.assetId ? this.alphaMasks.get(part.assetId) : undefined;
    const threshold = part.artMesh?.generator.alphaThreshold ?? 8;
    for (let index = 0; index < triangles.length; index += 3) {
      const a = vertices[triangles[index]], b = vertices[triangles[index + 1]], c = vertices[triangles[index + 2]];
      if (!a || !b || !c) continue;
      const uv = triangleUvAtPoint(point, [a, b, c]);
      if (uv && alphaMaskHit(mask, uv, threshold)) return true;
    }
    return false;
  }
  clientPointToParentSpace(
    canvas: HTMLCanvasElement,
    params: ParameterValues,
    partId: string,
    clientX: number,
    clientY: number,
    options: RenderOptions = {}
  ): { x: number; y: number } | undefined {
    const part = this.rig.parts.find((entry) => entry.id === partId);
    if (!part) {
      return undefined;
    }

    const view = this.getCanvasView(canvas, options);
    const point = this.cssPointFromClient(canvas, clientX, clientY);
    const computed = this.computePartStates(params, new Map(), view.cssBaseMatrix);
    const partState = computed.get(part.id);
    const parentMatrix = partState?.parentMatrix ?? (part.parentId ? computed.get(part.parentId)?.matrix ?? view.cssBaseMatrix : view.cssBaseMatrix);
    const parentPoint = point.matrixTransform(domMatrixFromMatrix(parentMatrix).inverse());
    return { x: parentPoint.x, y: parentPoint.y };
  }

  hitTestWarpPin(
    canvas: HTMLCanvasElement,
    params: ParameterValues,
    deformerId: string,
    clientX: number,
    clientY: number,
    options: RenderOptions = {}
  ): WarpPinHandle | undefined {
    const point = this.cssPointFromClient(canvas, clientX, clientY);
    const handles = this.getWarpPinHandles(canvas, params, deformerId, options);
    const useOffsetTarget = options.warpPinEditMode === "offset";
    return handles
      .slice()
      .reverse()
      .find((handle) => {
        const x = useOffsetTarget ? handle.targetX : handle.x;
        const y = useOffsetTarget ? handle.targetY : handle.y;
        return Math.hypot(x - point.x, y - point.y) <= Math.max(10, Math.min(18, handle.radiusPx * 0.4));
      });
  }

  clientPointToPartLocal(
    canvas: HTMLCanvasElement,
    params: ParameterValues,
    partId: string,
    clientX: number,
    clientY: number,
    options: RenderOptions = {}
  ): { x: number; y: number } | undefined {
    const part = this.rig.parts.find((entry) => entry.id === partId);
    if (!part) {
      return undefined;
    }

    const view = this.getCanvasView(canvas, options);
    const point = this.cssPointFromClient(canvas, clientX, clientY);
    const computed = this.computePartStates(params, new Map(), view.cssBaseMatrix);
    const partState = computed.get(part.id);
    if (!partState) {
      return undefined;
    }

    const localPoint = unprojectSharedWarpPoint({ x: point.x, y: point.y }, partState.matrix, view.cssBaseMatrix, partState.sharedWarps);
    return { x: localPoint.x, y: localPoint.y };
  }

  clientPointToWarpPinUv(
    canvas: HTMLCanvasElement,
    params: ParameterValues,
    partId: string,
    clientX: number,
    clientY: number,
    options: RenderOptions = {}
  ): { u: number; v: number } | undefined {
    const part = this.rig.parts.find((entry) => entry.id === partId);
    const size = part ? this.partSize(part) : undefined;
    if (!part || !size) {
      return undefined;
    }

    const view = this.getCanvasView(canvas, options);
    const point = this.cssPointFromClient(canvas, clientX, clientY);
    const computed = this.computePartStates(params, new Map(), view.cssBaseMatrix);
    const partState = computed.get(part.id);
    if (!partState) {
      return undefined;
    }

    const localPoint = unprojectSharedWarpPoint({ x: point.x, y: point.y }, partState.matrix, view.cssBaseMatrix, partState.sharedWarps);
    const left = -partState.pose.pivotX * size.width;
    const top = -partState.pose.pivotY * size.height;
    return {
      u: clamp01((localPoint.x - left) / Math.max(0.001, size.width)),
      v: clamp01((localPoint.y - top) / Math.max(0.001, size.height))
    };
  }

  clientPointToPartUv(
    canvas: HTMLCanvasElement,
    params: ParameterValues,
    partId: string,
    clientX: number,
    clientY: number,
    options: RenderOptions = {}
  ): { u: number; v: number } | undefined {
    return this.clientPointToWarpPinUv(canvas, params, partId, clientX, clientY, options);
  }
  getWarpPinHandles(
    canvas: HTMLCanvasElement,
    params: ParameterValues,
    deformerId: string,
    options: RenderOptions = {}
  ): WarpPinHandle[] {
    const view = this.getCanvasView(canvas, options);
    return this.collectWarpPinHandles(params, deformerId, view.cssBaseMatrix, options.selectedPartId);
  }


  getArtMeshVertexHandles(
    canvas: HTMLCanvasElement,
    params: ParameterValues,
    partId: string,
    options: RenderOptions = {}
  ): ArtMeshVertexHandle[] {
    const part = this.rig.parts.find((entry) => entry.id === partId);
    const size = part ? this.partSize(part) : undefined;
    if (!part || !size) return [];
    const view = this.getCanvasView(canvas, options);
    const computed = this.computePartStates(params, new Map(), view.cssBaseMatrix);
    const partState = computed.get(part.id);
    const mesh = resolveArtMesh(part, size.width, size.height, params);
    if (!partState || !partState.visible || partState.opacity <= 0 || !mesh) return [];
    const left = -partState.pose.pivotX * size.width;
    const top = -partState.pose.pivotY * size.height;
    const warp = this.resolveRenderableWarp(part, partState, size, computed);
    const bounds = { left, top, width: size.width, height: size.height };
    return mesh.vertices.map((vertex, vertexIndex) => {
      const localX = left + vertex.x;
      const localY = top + vertex.y;
      const warped = hasWarpEffect(warp) ? warpPoint(localX, localY, bounds, warp) : { x: localX, y: localY };
      const projected = projectSharedWarpPoint(warped, partState.matrix, view.cssBaseMatrix, partState.sharedWarps);
      return {
        partId: part.id,
        vertexIndex,
        vertexId: vertex.id,
        x: projected.x,
        y: projected.y,
        localX,
        localY,
        u: vertex.u,
        v: vertex.v
      };
    });
  }

  hitTestArtMeshVertex(
    canvas: HTMLCanvasElement,
    params: ParameterValues,
    partId: string,
    clientX: number,
    clientY: number,
    options: RenderOptions = {}
  ): ArtMeshVertexHandle | undefined {
    const point = this.cssPointFromClient(canvas, clientX, clientY);
    return this.getArtMeshVertexHandles(canvas, params, partId, options)
      .slice()
      .reverse()
      .find((handle) => Math.hypot(handle.x - point.x, handle.y - point.y) <= 10);
  }
  getSharedWarpHandles(canvas: HTMLCanvasElement, deformerId: string, options: RenderOptions = {}): SharedWarpHandle[] {
    const deformer = (this.rig.deformers ?? []).find((entry) => entry.id === deformerId);
    if (!deformer?.sharedWarp) return [];
    const field = normalizeSharedWarpField(deformer.sharedWarp);
    const view = this.getCanvasView(canvas, options);
    return field.controlPoints.map((point, pointIndex) => {
      const stageX = field.bounds.left + (point.column / field.grid.columns) * field.bounds.width;
      const stageY = field.bounds.top + (point.row / field.grid.rows) * field.bounds.height;
      const rendered = transformMatrixPoint(view.cssBaseMatrix, stageX + point.offsetX, stageY + point.offsetY);
      return { deformerId, pointIndex, pointId: point.id, x: rendered.x, y: rendered.y, offsetX: point.offsetX, offsetY: point.offsetY, enabled: field.enabled && point.enabled !== false };
    });
  }

  clientPointToStage(canvas: HTMLCanvasElement, clientX: number, clientY: number, options: RenderOptions = {}): { x: number; y: number } {
    const view = this.getCanvasView(canvas, options);
    const point = this.cssPointFromClient(canvas, clientX, clientY);
    return transformMatrixPoint(invertMatrix(view.cssBaseMatrix), point.x, point.y);
  }
  hitTestSharedWarpHandle(canvas: HTMLCanvasElement, deformerId: string, clientX: number, clientY: number, options: RenderOptions = {}): SharedWarpHandle | undefined {
    const point = this.cssPointFromClient(canvas, clientX, clientY);
    return this.getSharedWarpHandles(canvas, deformerId, options).slice().reverse().find((handle) => Math.hypot(handle.x - point.x, handle.y - point.y) <= 14);
  }
  getGlueSeamHandles(canvas: HTMLCanvasElement, params: ParameterValues, options: RenderOptions = {}): GlueSeamHandle[] {
    const view = this.getCanvasView(canvas, options);
    const computed = this.computePartStates(params, new Map(), view.cssBaseMatrix);
    return this.collectGlueSeamHandles(computed);
  }

  hitTestGlueSeamPoint(
    canvas: HTMLCanvasElement,
    params: ParameterValues,
    clientX: number,
    clientY: number,
    options: RenderOptions = {}
  ): GlueSeamHandle | undefined {
    const point = this.cssPointFromClient(canvas, clientX, clientY);
    let best: GlueSeamHandle | undefined;
    let bestDistance = Infinity;
    for (const handle of this.getGlueSeamHandles(canvas, params, options)) {
      const distance = Math.hypot(handle.x - point.x, handle.y - point.y);
      const hitRadius = Math.max(9, Math.min(18, handle.radiusPx * 0.28));
      if (distance <= hitRadius && distance < bestDistance) {
        best = handle;
        bestDistance = distance;
      }
    }
    return best;
  }

  private drawGlueOverlay(ctx: CanvasRenderingContext2D, computed: Map<string, EvaluatedPartState>, view: CanvasView) {
    const glues = readRigGlue(this.rig)
      .filter((glue) => glue.enabled && glue.status !== "disabled" && glue.debugVisible !== false)
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    if (!glues.length) {
      return;
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `${Math.max(10, 11 * view.dpr)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const glue of glues) {
      const partA = this.rig.parts.find((part) => part.id === glue.partAId);
      const partB = this.rig.parts.find((part) => part.id === glue.partBId);
      const stateA = partA ? computed.get(partA.id) : undefined;
      const stateB = partB ? computed.get(partB.id) : undefined;
      const sizeA = partA ? this.partSize(partA) : undefined;
      const sizeB = partB ? this.partSize(partB) : undefined;
      if (!partA || !partB || !stateA || !stateB || !sizeA || !sizeB || !stateA.visible || !stateB.visible) {
        continue;
      }

      const active = glue.status === "active";
      const alpha = Math.max(0.18, Math.min(0.82, glue.strength));
      const strokeColor = active ? "rgba(94, 234, 212, 0.92)" : "rgba(255, 214, 102, 0.82)";
      const fillColor = active ? "rgba(11, 68, 71, 0.88)" : "rgba(72, 55, 12, 0.84)";
      const labelColor = active ? "#9ff8ee" : "#ffe4a3";
      const seamPoints = glue.seamPoints?.length
        ? glue.seamPoints.map((point) => ({ a: point.a, b: point.b, radius: point.radius, strength: point.strength }))
        : [{ a: { u: 0.5, v: 0.5 }, b: { u: 0.5, v: 0.5 }, radius: undefined, strength: undefined }];
      const labelPoints: DOMPoint[] = [];

      ctx.globalAlpha = alpha;
      ctx.strokeStyle = strokeColor;
      ctx.fillStyle = fillColor;
      ctx.lineWidth = Math.max(1.2, 2.1 * view.dpr);
      ctx.setLineDash(active ? [] : [5 * view.dpr, 4 * view.dpr]);

      seamPoints.forEach((point, index) => {
        const pointA = this.glueUvPoint(stateA, sizeA.width, sizeA.height, point.a.u, point.a.v);
        const pointB = this.glueUvPoint(stateB, sizeB.width, sizeB.height, point.b.u, point.b.v);
        labelPoints.push(pointA, pointB);
        ctx.beginPath();
        ctx.moveTo(pointA.x, pointA.y);
        ctx.lineTo(pointB.x, pointB.y);
        ctx.stroke();

        const radiusA = this.glueRadiusPx(stateA, sizeA.width, sizeA.height, point.radius, point.strength ?? glue.strength);
        const radiusB = this.glueRadiusPx(stateB, sizeB.width, sizeB.height, point.radius, point.strength ?? glue.strength);
        ctx.save();
        ctx.globalAlpha = Math.min(0.32, alpha * 0.45);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(pointA.x, pointA.y, radiusA, 0, Math.PI * 2);
        ctx.arc(pointB.x, pointB.y, radiusB, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        const dotRadius = Math.max(4.5, 5.2 * view.dpr);
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = fillColor;
        ctx.strokeStyle = strokeColor;
        ctx.beginPath();
        ctx.arc(pointA.x, pointA.y, dotRadius, 0, Math.PI * 2);
        ctx.arc(pointB.x, pointB.y, dotRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = labelColor;
        ctx.font = `${Math.max(9, 10 * view.dpr)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillText(String(index + 1), pointA.x, pointA.y + 0.4 * view.dpr);
        ctx.fillText(String(index + 1), pointB.x, pointB.y + 0.4 * view.dpr);
        ctx.font = `${Math.max(10, 11 * view.dpr)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = strokeColor;
        ctx.setLineDash(active ? [] : [5 * view.dpr, 4 * view.dpr]);
      });
      ctx.setLineDash([]);

      const labelCenter = averageDomPoints(labelPoints);
      if (!labelCenter) {
        continue;
      }
      const label = glue.region ?? glue.mode;
      const labelWidth = Math.min(170 * view.dpr, Math.max(54 * view.dpr, ctx.measureText(label).width + 16 * view.dpr));
      const labelHeight = 18 * view.dpr;
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = "rgba(14, 18, 23, 0.84)";
      ctx.strokeStyle = active ? "rgba(94, 234, 212, 0.7)" : "rgba(255, 214, 102, 0.66)";
      ctx.lineWidth = Math.max(1, view.dpr);
      ctx.beginPath();
      ctx.roundRect(labelCenter.x - labelWidth / 2, labelCenter.y - labelHeight / 2, labelWidth, labelHeight, 5 * view.dpr);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = labelColor;
      ctx.fillText(label, labelCenter.x, labelCenter.y + 0.5 * view.dpr, labelWidth - 10 * view.dpr);
    }
    ctx.restore();
  }

  private glueUvPoint(partState: EvaluatedPartState, width: number, height: number, u: number, v: number): DOMPoint {
    const localX = -partState.pose.pivotX * width + clamp01(u) * width;
    const localY = -partState.pose.pivotY * height + clamp01(v) * height;
    return new DOMPoint(localX, localY).matrixTransform(domMatrixFromMatrix(partState.matrix));
  }

  private glueRadiusPx(partState: EvaluatedPartState, width: number, height: number, radius: number | undefined, strength: number): number {
    const scaleX = Math.hypot(partState.matrix.a, partState.matrix.b);
    const scaleY = Math.hypot(partState.matrix.c, partState.matrix.d);
    const averageScale = Math.max(0.001, (scaleX + scaleY) * 0.5);
    const normalizedRadius = Math.max(0.04, Math.min(0.7, radius ?? (0.16 + clamp01(strength) * 0.34)));
    return Math.max(8, Math.min(90, Math.min(width, height) * normalizedRadius * averageScale));
  }

  private glueAnchorPoint(partState: EvaluatedPartState, width: number, height: number): DOMPoint {
    return this.glueUvPoint(partState, width, height, 0.5, 0.5);
  }
  private prepareClippingLayer(canvas: HTMLCanvasElement, index: 0 | 1): HTMLCanvasElement {
    let layer = this.clippingLayers[index];
    if (!layer) {
      layer = document.createElement("canvas");
      this.clippingLayers[index] = layer;
      this.clippingLayerAllocations += 1;
    }
    if (layer.width !== canvas.width || layer.height !== canvas.height) {
      layer.width = canvas.width;
      layer.height = canvas.height;
    } else {
      const context = layer.getContext("2d");
      context?.save();
      context?.setTransform(1, 0, 0, 1, 0, 0);
      context?.clearRect(0, 0, layer.width, layer.height);
      context?.restore();
    }
    return layer;
  }
  getClippingLayerAllocationCount(): number { return this.clippingLayerAllocations; }

  private getWebGLMeshRenderer(enabled: boolean): WebGLArtMeshRenderer | undefined {
    if (!enabled) return undefined;
    if (this.webglMeshRenderer) return this.webglMeshRenderer;
    try {
      this.webglMeshRenderer = new WebGLArtMeshRenderer();
      this.webglMeshError = undefined;
      return this.webglMeshRenderer;
    } catch (error) {
      this.webglMeshError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }
private resolveTintedImage(partId: string, image: HTMLImageElement, tint: RigPart["tint"]): CanvasImageSource {
    if (!tint || (tint.mode !== "multiply" && tint.mode !== "screen") || !/^#[0-9a-fA-F]{6}$/.test(tint.color) || !Number.isFinite(tint.opacity) || tint.opacity <= 0) return image;
    const opacity = Math.min(1, Math.max(0, tint.opacity));
    if (opacity <= 0) return image;
    const key = `${partId}:${tint.mode}:${tint.color.toLowerCase()}:${opacity}`;
    const cached = this.tintedImages.get(key);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext("2d");
    if (!context || canvas.width <= 0 || canvas.height <= 0) return image;

    // Build a tint layer from the source alpha before blending it. Drawing a
    // solid rectangle directly with multiply or screen fills transparent
    // pixels as well, turning a sparse ArtMesh into an opaque rectangle in
    // the browser renderer. source-in keeps the tint layer limited to the
    // source alpha, while the final blend preserves the transparent shape.
    const tintLayer = document.createElement("canvas");
    tintLayer.width = canvas.width;
    tintLayer.height = canvas.height;
    const tintContext = tintLayer.getContext("2d");
    if (!tintContext) return image;
    tintContext.drawImage(image, 0, 0);
    tintContext.globalCompositeOperation = "source-in";
    tintContext.globalAlpha = 1;
    tintContext.fillStyle = tint.color;
    tintContext.fillRect(0, 0, tintLayer.width, tintLayer.height);
    tintContext.globalCompositeOperation = "source-over";

    context.drawImage(image, 0, 0);
    context.globalCompositeOperation = tint.mode === "multiply" ? "multiply" : "screen";
    context.globalAlpha = opacity;
    context.drawImage(tintLayer, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    this.tintedImages.set(key, canvas);
    return canvas;
  }
  private resolveContourImage(part: RigPart, source: CanvasImageSource, width: number, height: number, params: ParameterValues): CanvasImageSource {
    if (!part.contourShade || !validateContourShade(part.contourShade)) return source;
    if (!(params[part.contourShade.yawParameter] ?? 0)
      || (part.contourShade.strength === 0 && !part.contourShade.farContourFade && !part.contourShade.nearContourFade)) return source;
    const key = JSON.stringify(part.contourShade);
    let entry = this.contourImages.get(part.id);
    if (!entry || entry.source !== source || entry.key !== key) {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.drawImage(source, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      entry = { source, key, canvas, processor: new ContourShadeProcessor(pixels, part.contourShade) };
      this.contourImages.set(part.id, entry);
    }
    const pixels = entry.processor.render(params);
    if (pixels !== entry.last) {
      const context = entry.canvas.getContext("2d")!;
      const frame = context.createImageData(width, height);
      frame.data.set(pixels.data);
      context.putImageData(frame, 0, 0);
      entry.last = pixels;
    }
    return entry.canvas;
  }
  private resolveRevealImage(part: RigPart, source: CanvasImageSource, width: number, height: number, params: ParameterValues): CanvasImageSource {
    if (!part.alphaReveal || !validateAlphaReveal(part.alphaReveal)) return source;
    if ((params[part.alphaReveal.parameter] ?? part.alphaReveal.open) >= part.alphaReveal.open) return source;
    const key = JSON.stringify(part.alphaReveal);
    let entry = this.revealImages.get(part.id);
    // Dynamic contour-color canvases can change in place, so rebuild their
    // source pixels. Static images use a single cached aperture processor.
    if (!entry || entry.source !== source || entry.key !== key || (source instanceof HTMLCanvasElement && part.contourShade)) {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.drawImage(source, 0, 0, width, height);
      entry = { source, key, canvas, processor: new AlphaRevealProcessor(context.getImageData(0, 0, width, height), part.alphaReveal) };
      this.revealImages.set(part.id, entry);
    }
    const pixels = entry.processor.render(params);
    if (pixels !== entry.last) {
      const context = entry.canvas.getContext("2d")!;
      const frame = context.createImageData(width, height); frame.data.set(pixels.data);
      context.putImageData(frame, 0, 0); entry.last = pixels;
    }
    return entry.canvas;
  }
  private drawRenderablePart(
    ctx: CanvasRenderingContext2D,
    part: RigPart,
    computed: Map<string, EvaluatedPartState>,
    params: ParameterValues,
    baseMatrix: Matrix2D,
    ignoreVisualAlpha = false,
    webglMeshRenderer?: WebGLArtMeshRenderer,
    skinningTransforms?: ReadonlyMap<string, Matrix2D>,
    glueStitch?: GlueVertexOffsets
  ) {
    const size = this.partSize(part);
    const partState = computed.get(part.id);
    if (!size || !partState || (!ignoreVisualAlpha && (!partState.visible || partState.opacity <= 0))) {
      return;
    }

    ctx.save();
    ctx.setTransform(partState.matrix.a, partState.matrix.b, partState.matrix.c, partState.matrix.d, partState.matrix.e, partState.matrix.f);
    ctx.globalAlpha = ignoreVisualAlpha ? 1 : Math.min(1, Math.max(0, partState.opacity));
    ctx.globalCompositeOperation = ignoreVisualAlpha ? "source-over" : part.blendMode === "multiply" ? "multiply" : part.blendMode === "screen" ? "screen" : part.blendMode === "additive" ? "lighter" : "source-over";
    const tintedImage = this.resolveTintedImage(part.id, size.image, part.tint);
    const coloredImage = ignoreVisualAlpha ? tintedImage : this.resolveContourImage(part, tintedImage, size.width, size.height, params);
    const sourceImage = this.resolveRevealImage(part, coloredImage, size.width, size.height, params);
    const left = -partState.pose.pivotX * size.width;
    const top = -partState.pose.pivotY * size.height;
    const warp = this.resolveRenderableWarp(part, partState, size, computed);
    const baseArtMesh = resolveArtMesh(part, size.width, size.height, params);
    const artMesh = baseArtMesh && part.artMesh?.skinning
      ? { ...baseArtMesh, vertices: applySkinningToVertices(baseArtMesh.vertices, part.artMesh.skinning, skinningTransforms) }
      : baseArtMesh;
    const sharedWarps = partState.sharedWarps;
    const stitchOffsets = localStitchOffsets(glueStitch?.get(part.id), partState.matrix);
    const hasSharedWarp = Boolean(sharedWarps?.some(hasSharedWarpFieldEffect));
    const project = hasSharedWarp ? (point: { x: number; y: number }) => {
      const rendered = projectSharedWarpPoint(point, partState.matrix, baseMatrix, sharedWarps);
      return transformMatrixPoint(invertMatrix(partState.matrix), rendered.x, rendered.y);
    } : undefined;
    const sharedGrid = hasSharedWarp ? {
      columns: Math.max(1, ...(sharedWarps ?? []).filter(hasSharedWarpFieldEffect).map((field) => field.grid.columns)),
      rows: Math.max(1, ...(sharedWarps ?? []).filter(hasSharedWarpFieldEffect).map((field) => field.grid.rows))
    } : undefined;
    if (artMesh && !isCanonicalArtMesh(artMesh, size.width, size.height) && !hasWarpEffect(warp) && !hasSharedWarp) {
      if (webglMeshRenderer) {
        const projectedVertices = artMesh.vertices.map((vertex) => {
          const offset = stitchOffsets?.get(vertex.id);
          const local = { x: left + vertex.x + (offset?.dx ?? 0), y: top + vertex.y + (offset?.dy ?? 0) };
          const screen = projectSharedWarpPoint(local, partState.matrix, baseMatrix, sharedWarps);
          return { x: screen.x, y: screen.y, u: vertex.u, v: vertex.v };
        });
        if (webglMeshRenderer.draw(ctx, sourceImage as HTMLImageElement, projectedVertices, artMesh.triangles, ignoreVisualAlpha ? 1 : partState.opacity, ignoreVisualAlpha ? "source-over" : part.blendMode === "multiply" ? "multiply" : part.blendMode === "screen" ? "screen" : part.blendMode === "additive" ? "lighter" : "source-over")) {
          drawArtPathsCanvas(ctx, part, params, size.width, size.height, left, top, warp, project);
          ctx.restore();
          return;
        }
      }
      drawArtMesh(ctx, sourceImage as HTMLImageElement, left, top, size.width, size.height, artMesh, warp, project, stitchOffsets);
    } else if (artMesh) {
      drawArtMesh(ctx, sourceImage as HTMLImageElement, left, top, size.width, size.height, artMesh, warp, project, stitchOffsets);
    } else if (hasWarpEffect(warp) || hasSharedWarp) {
      drawWarpedImage(ctx, sourceImage as HTMLImageElement, left, top, size.width, size.height, warp, project, sharedGrid);
    } else {
      ctx.drawImage(sourceImage, left, top, size.width, size.height);
    }
    drawArtPathsCanvas(ctx, part, params, size.width, size.height, left, top, warp, project);
    ctx.restore();
  }

  /** Screen position of one ArtMesh vertex, matching the draw path exactly. */
  private projectGlueVertex(
    partId: string,
    vertexId: string,
    computed: Map<string, EvaluatedPartState>,
    params: ParameterValues,
    baseMatrix: Matrix2D,
    skinningTransforms?: ReadonlyMap<string, Matrix2D>
  ): { x: number; y: number } | undefined {
    const part = this.rig.parts.find((entry) => entry.id === partId);
    const partState = part ? computed.get(part.id) : undefined;
    const size = part ? this.partSize(part) : undefined;
    if (!part || !partState || !size || !partState.visible || partState.opacity <= 0) {
      return undefined;
    }
    const baseArtMesh = resolveArtMesh(part, size.width, size.height, params);
    if (!baseArtMesh) {
      return undefined;
    }
    const vertices = part.artMesh?.skinning
      ? applySkinningToVertices(baseArtMesh.vertices, part.artMesh.skinning, skinningTransforms)
      : baseArtMesh.vertices;
    const vertex = vertices.find((entry) => entry.id === vertexId);
    if (!vertex) {
      return undefined;
    }
    return projectArtMeshVertex(vertex, {
      pose: partState.pose,
      matrix: partState.matrix,
      baseMatrix,
      sharedWarps: partState.sharedWarps,
      warp: this.resolveRenderableWarp(part, partState, size, computed),
      sourceWidth: size.width,
      sourceHeight: size.height
    });
  }

  private drawPartDebug(
    ctx: CanvasRenderingContext2D,
    part: RigPart,
    computed: Map<string, EvaluatedPartState>,
    view: CanvasView,
    options: RenderOptions
  ) {
    const size = this.partSize(part);
    const partState = computed.get(part.id);
    const isSelected = part.id === options.selectedPartId;
    if (!size || !partState || (!options.showBounds && !isSelected)) {
      return;
    }

    ctx.save();
    ctx.setTransform(partState.matrix.a, partState.matrix.b, partState.matrix.c, partState.matrix.d, partState.matrix.e, partState.matrix.f);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.lineWidth = (isSelected ? 2 : 1) / view.fittedScale;
    ctx.strokeStyle = isSelected ? "rgba(255, 202, 91, 0.96)" : "rgba(35, 190, 210, 0.88)";
    ctx.strokeRect(-partState.pose.pivotX * size.width, -partState.pose.pivotY * size.height, size.width, size.height);
    if (isSelected) {
      const radius = 4 / view.fittedScale;
      ctx.fillStyle = "rgba(255, 202, 91, 0.96)";
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  private resolveRenderableWarp(
    part: RigPart,
    partState: EvaluatedPartState,
    size: { width: number; height: number },
    computed: Map<string, EvaluatedPartState>
  ): ResolvedWarpDeformer | undefined {
    return resolveGlueWarpForPart(this.rig, part, partState, size, computed, (entry) => {
      const partSize = this.partSize(entry);
      return partSize ? { width: partSize.width, height: partSize.height } : undefined;
    });
  }
  private drawArtMeshOverlay(ctx: CanvasRenderingContext2D, params: ParameterValues, view: CanvasView, options: RenderOptions) {
    if (!options.selectedPartId || options.selectedArtMeshVertexIndex === undefined) return;
    const part = this.rig.parts.find((entry) => entry.id === options.selectedPartId);
    if (!part?.artMesh?.enabled) return;
    const handles = this.getArtMeshVertexHandles(ctx.canvas as HTMLCanvasElement, params, part.id, options);
    if (!handles.length) return;

    ctx.save();
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(56, 189, 248, 0.64)";
    ctx.lineWidth = 1;
    for (let index = 0; index < part.artMesh.triangles.length; index += 3) {
      const a = handles[part.artMesh.triangles[index]];
      const b = handles[part.artMesh.triangles[index + 1]];
      const c = handles[part.artMesh.triangles[index + 2]];
      if (!a || !b || !c) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.closePath();
      ctx.stroke();
    }

    handles.forEach((handle) => {
      const selected = handle.vertexIndex === options.selectedArtMeshVertexIndex;
      const radius = selected ? 6 : 4;
      if (selected) {
        ctx.fillStyle = "rgba(251, 191, 36, 0.2)";
        ctx.strokeStyle = "rgba(251, 191, 36, 0.96)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, radius + 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = selected ? "rgba(251, 191, 36, 0.98)" : "rgba(14, 116, 144, 0.94)";
      ctx.strokeStyle = selected ? "rgba(255, 251, 235, 0.98)" : "rgba(224, 242, 254, 0.94)";
      ctx.lineWidth = selected ? 2 : 1.25;
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  }
  private drawWarpPinOverlay(ctx: CanvasRenderingContext2D, params: ParameterValues, view: CanvasView, options: RenderOptions) {
    if (!options.selectedDeformerId) {
      return;
    }
    const handles = this.collectWarpPinHandles(params, options.selectedDeformerId, view.cssBaseMatrix, options.selectedPartId);
    const sharedHandles = this.getSharedWarpHandles(ctx.canvas as HTMLCanvasElement, options.selectedDeformerId, { fitPadding: 18 });
    const sharedDeformer = (this.rig.deformers ?? []).find((entry) => entry.id === options.selectedDeformerId);
    const sharedField = sharedDeformer?.sharedWarp ? normalizeSharedWarpField(sharedDeformer.sharedWarp) : undefined;
    if (!handles.length && !sharedHandles.length) {
      return;
    }

    ctx.save();
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    const offsetMode = options.warpPinEditMode === "offset";
    if (sharedField) {
      const origin = transformMatrixPoint(view.cssBaseMatrix, sharedField.bounds.left, sharedField.bounds.top);
      const far = transformMatrixPoint(view.cssBaseMatrix, sharedField.bounds.left + sharedField.bounds.width, sharedField.bounds.top + sharedField.bounds.height);
      ctx.save();
      ctx.globalAlpha = sharedField.enabled ? 0.7 : 0.28;
      ctx.strokeStyle = "rgba(129, 140, 248, 0.95)";
      ctx.fillStyle = "rgba(99, 102, 241, 0.07)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.fillRect(origin.x, origin.y, far.x - origin.x, far.y - origin.y);
      ctx.strokeRect(origin.x, origin.y, far.x - origin.x, far.y - origin.y);
      ctx.setLineDash([]);
      ctx.globalAlpha = sharedField.enabled ? 0.46 : 0.18;
      ctx.strokeStyle = "rgba(165, 180, 252, 0.9)";
      ctx.lineWidth = 1;
      for (let column = 1; column < sharedField.grid.columns; column += 1) {
        const x = origin.x + ((far.x - origin.x) * column) / sharedField.grid.columns;
        ctx.beginPath();
        ctx.moveTo(x, origin.y);
        ctx.lineTo(x, far.y);
        ctx.stroke();
      }
      for (let row = 1; row < sharedField.grid.rows; row += 1) {
        const y = origin.y + ((far.y - origin.y) * row) / sharedField.grid.rows;
        ctx.beginPath();
        ctx.moveTo(origin.x, y);
        ctx.lineTo(far.x, y);
        ctx.stroke();
      }
      ctx.restore();
    }
    for (const handle of handles) {
      const isSelected = handle.pinIndex === options.selectedWarpPinIndex;
      const radius = Math.max(7, Math.min(26, handle.radiusPx * (isSelected ? 0.34 : 0.28)));
      const fieldRadius = Math.max(radius + 2, Math.min(52, handle.radiusPx));
      const offsetLength = Math.hypot(handle.targetX - handle.x, handle.targetY - handle.y);
      ctx.globalAlpha = handle.enabled ? 1 : 0.45;

      if (offsetMode && (isSelected || offsetLength > 0.5)) {
        ctx.strokeStyle = isSelected ? "rgba(94, 234, 212, 0.88)" : "rgba(255, 214, 102, 0.54)";
        ctx.lineWidth = isSelected ? 2 : 1.2;
        ctx.beginPath();
        ctx.moveTo(handle.x, handle.y);
        ctx.lineTo(handle.targetX, handle.targetY);
        ctx.stroke();
      }

      if (isSelected) {
        const focusX = offsetMode ? handle.targetX : handle.x;
        const focusY = offsetMode ? handle.targetY : handle.y;
        ctx.fillStyle = "rgba(45, 212, 191, 0.16)";
        ctx.strokeStyle = "rgba(94, 234, 212, 0.92)";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(focusX, focusY, radius + 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      ctx.strokeStyle = isSelected
        ? "rgba(94, 234, 212, 0.98)"
        : handle.enabled
          ? "rgba(255, 214, 102, 0.95)"
          : "rgba(150, 160, 170, 0.82)";
      ctx.fillStyle = isSelected && !offsetMode
        ? "rgba(12, 74, 80, 0.92)"
        : handle.enabled
          ? "rgba(24, 28, 34, 0.88)"
          : "rgba(24, 28, 34, 0.58)";
      ctx.lineWidth = isSelected && !offsetMode ? 2.2 : 1.5;
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = isSelected && !offsetMode ? "#7fffea" : handle.enabled ? "#ffd666" : "#9aa4af";
      ctx.fillText(String(handle.pinIndex + 1), handle.x, handle.y + 0.5);

      if (offsetMode) {
        const targetRadius = Math.max(6, radius * (isSelected ? 0.82 : 0.68));
        ctx.globalAlpha = handle.enabled ? 1 : 0.45;
        ctx.fillStyle = isSelected ? "rgba(12, 74, 80, 0.94)" : "rgba(24, 28, 34, 0.78)";
        ctx.strokeStyle = isSelected ? "rgba(94, 234, 212, 0.98)" : "rgba(255, 214, 102, 0.7)";
        ctx.lineWidth = isSelected ? 2.2 : 1.3;
        ctx.beginPath();
        ctx.rect(handle.targetX - targetRadius, handle.targetY - targetRadius, targetRadius * 2, targetRadius * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = isSelected ? "#7fffea" : "#ffd666";
        ctx.fillText("O", handle.targetX, handle.targetY + 0.5);
      }

      ctx.globalAlpha = handle.enabled ? (isSelected ? 0.38 : 0.22) : 0.12;
      ctx.strokeStyle = isSelected ? "rgba(94, 234, 212, 0.72)" : handle.enabled ? "rgba(255, 214, 102, 0.95)" : "rgba(150, 160, 170, 0.82)";
      ctx.lineWidth = isSelected ? 2 : 1.5;
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, fieldRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const handle of sharedHandles) {
      ctx.globalAlpha = handle.enabled ? 0.96 : 0.42;
      ctx.fillStyle = "rgba(99, 102, 241, 0.86)";
      ctx.strokeStyle = "rgba(224, 231, 255, 0.96)";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.rect(handle.x - 6, handle.y - 6, 12, 12);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(String(handle.pointIndex + 1), handle.x, handle.y + 0.5);
    }
    ctx.restore();
  }

  private collectGlueSeamHandles(computed: Map<string, EvaluatedPartState>): GlueSeamHandle[] {
    const handles: GlueSeamHandle[] = [];
    const glues = readRigGlue(this.rig)
      .filter((glue) => glue.enabled && glue.status !== "disabled" && glue.debugVisible !== false && glue.seamPoints?.length)
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));

    for (const glue of glues) {
      const partA = this.rig.parts.find((part) => part.id === glue.partAId);
      const partB = this.rig.parts.find((part) => part.id === glue.partBId);
      const stateA = partA ? computed.get(partA.id) : undefined;
      const stateB = partB ? computed.get(partB.id) : undefined;
      const sizeA = partA ? this.partSize(partA) : undefined;
      const sizeB = partB ? this.partSize(partB) : undefined;
      if (!partA || !partB || !stateA || !stateB || !sizeA || !sizeB || !stateA.visible || !stateB.visible) {
        continue;
      }

      glue.seamPoints?.forEach((point, seamIndex) => {
        handles.push(this.glueSeamHandleForPoint(glue, seamIndex, "a", partA, stateA, sizeA.width, sizeA.height, point.a.u, point.a.v, point.radius, point.strength));
        handles.push(this.glueSeamHandleForPoint(glue, seamIndex, "b", partB, stateB, sizeB.width, sizeB.height, point.b.u, point.b.v, point.radius, point.strength));
      });
    }

    return handles;
  }

  private glueSeamHandleForPoint(
    glue: RigGlue,
    seamIndex: number,
    side: "a" | "b",
    part: RigPart,
    partState: EvaluatedPartState,
    width: number,
    height: number,
    u: number,
    v: number,
    radius: number | undefined,
    strength: number | undefined
  ): GlueSeamHandle {
    const point = this.glueUvPoint(partState, width, height, u, v);
    const handleStrength = strength ?? glue.strength;
    return {
      glueId: glue.id,
      glueName: glue.name,
      seamIndex,
      side,
      partId: part.id,
      partName: part.name,
      x: point.x,
      y: point.y,
      u,
      v,
      radiusPx: this.glueRadiusPx(partState, width, height, radius, handleStrength),
      strength: handleStrength,
      enabled: glue.enabled && glue.status !== "disabled"
    };
  }
  private collectWarpPinHandles(params: ParameterValues, deformerId: string, baseMatrix: Matrix2D, selectedPartId?: string): WarpPinHandle[] {
    const deformer = (this.rig.deformers ?? []).find((entry) => entry.id === deformerId);
    if (!deformer || deformer.kind !== "warp") {
      return [];
    }
    const warp = normalizeWarpDeformer(deformer.warp);
    const pins = warp.pins ?? [];
    if (!warp.enabled || !pins.length) {
      return [];
    }

    const targetParts = this.imagePartsForDeformer(deformer);
    const selectedPart = selectedPartId ? targetParts.find((part) => part.id === selectedPartId) : undefined;
    const parts = selectedPart ? [selectedPart] : targetParts.slice(0, 1);
    if (!parts.length) {
      return [];
    }

    const computed = this.computePartStates(params, new Map(), baseMatrix);
    const handles: WarpPinHandle[] = [];
    for (const part of parts) {
      const size = this.partSize(part);
      const partState = computed.get(part.id);
      if (!size || !partState || !partState.visible || partState.opacity <= 0) {
        continue;
      }
      const left = -partState.pose.pivotX * size.width;
      const top = -partState.pose.pivotY * size.height;
      const scaleX = Math.hypot(partState.matrix.a, partState.matrix.b);
      const scaleY = Math.hypot(partState.matrix.c, partState.matrix.d);
      const radiusBase = Math.max(6, Math.min(size.width * scaleX, size.height * scaleY));
      pins.forEach((pin, pinIndex) => {
        const localX = left + pin.u * size.width;
        const localY = top + pin.v * size.height;
        const point = projectSharedWarpPoint({ x: localX, y: localY }, partState.matrix, baseMatrix, partState.sharedWarps);
        const targetPoint = projectSharedWarpPoint({ x: localX + pin.offsetX, y: localY + pin.offsetY }, partState.matrix, baseMatrix, partState.sharedWarps);
        handles.push({
          deformerId,
          partId: part.id,
          pinIndex,
          pinId: pin.id,
          name: pin.name,
          x: point.x,
          y: point.y,
          radiusPx: Math.max(6, Math.min(64, pin.radius * radiusBase)),
          targetX: targetPoint.x,
          targetY: targetPoint.y,
          offsetX: pin.offsetX,
          offsetY: pin.offsetY,
          u: pin.u,
          v: pin.v,
          enabled: pin.enabled !== false
        });
      });
    }
    return handles;
  }

  private imagePartsForDeformer(deformer: RigDeformer): RigPart[] {
    const targetIds = new Set(deformer.targetPartIds ?? []);
    const directParts = this.rig.parts.filter((part) => part.deformerId === deformer.id || targetIds.has(part.id));
    const childrenByParent = new Map<string | null, RigPart[]>();
    for (const part of this.rig.parts) {
      const children = childrenByParent.get(part.parentId) ?? [];
      children.push(part);
      childrenByParent.set(part.parentId, children);
    }

    const images: RigPart[] = [];
    const seen = new Set<string>();
    const visit = (part: RigPart) => {
      if (seen.has(part.id)) {
        return;
      }
      seen.add(part.id);
      if (part.kind === "image" && part.assetId) {
        images.push(part);
      }
      for (const child of childrenByParent.get(part.id) ?? []) {
        visit(child);
      }
    };
    directParts.forEach(visit);
    return images.sort((left, right) => left.drawOrder - right.drawOrder);
  }

  private async loadAsset(asset: AssetDefinition) {
    const image = new Image();
    image.decoding = "async";
    image.src = asset.src;
    await image.decode().catch(
      () =>
        new Promise<void>((resolve) => {
          image.onload = () => resolve();
          image.onerror = () => resolve();
        })
    );
    this.images.set(asset.id, image);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (width > 0 && height > 0) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context?.drawImage(image, 0, 0, width, height);
        const rgba = context?.getImageData(0, 0, width, height).data;
        if (rgba) {
          const alpha = new Uint8Array(width * height);
          for (let index = 0; index < alpha.length; index += 1) alpha[index] = rgba[index * 4 + 3];
          this.alphaMasks.set(asset.id, { width, height, alpha });
        }
      } catch (_error) {
        // Tainted or unreadable canvases retain geometric hit testing.
      }
    }
  }

  private getCanvasView(canvas: HTMLCanvasElement, options: RenderOptions): CanvasView {
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, rect.width || this.rig.stage.width);
    const cssHeight = Math.max(1, rect.height || this.rig.stage.height);
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);
    const padding = options.fitPadding ?? 18;
    const availableWidth = Math.max(1, cssWidth - padding * 2);
    const availableHeight = Math.max(1, cssHeight - padding * 2);
    const scale = Math.min(availableWidth / this.rig.stage.width, availableHeight / this.rig.stage.height);
    const canvasZoom = Number(canvas.dataset.codexPreviewZoom ?? Number.NaN);
    const requestedZoom = options.zoom ?? canvasZoom;
    const zoom = Number.isFinite(requestedZoom) ? Math.min(3, Math.max(0.5, requestedZoom)) : 1;
    const fittedScale = Math.max(MIN_SCALE, scale * zoom);
    const canvasPanX = Number(canvas.dataset.codexPreviewPanX ?? Number.NaN);
    const canvasPanY = Number(canvas.dataset.codexPreviewPanY ?? Number.NaN);
    const requestedPanX = options.panX ?? canvasPanX;
    const requestedPanY = options.panY ?? canvasPanY;
    const panX = Number.isFinite(requestedPanX) ? Math.max(-cssWidth * 2, Math.min(cssWidth * 2, requestedPanX)) : 0;
    const panY = Number.isFinite(requestedPanY) ? Math.max(-cssHeight * 2, Math.min(cssHeight * 2, requestedPanY)) : 0;
    const offsetX = (cssWidth - this.rig.stage.width * fittedScale) / 2 + panX;
    const offsetY = (cssHeight - this.rig.stage.height * fittedScale) / 2 + panY;

    const cssBaseMatrix = multiplyMatrices(translateMatrix(offsetX, offsetY), scaleMatrix(fittedScale, fittedScale));
    const pixelBaseMatrix = multiplyMatrices(scaleMatrix(dpr, dpr), cssBaseMatrix);

    return {
      cssWidth,
      cssHeight,
      dpr,
      pixelWidth,
      pixelHeight,
      fittedScale,
      offsetX,
      offsetY,
      cssBaseMatrix,
      pixelBaseMatrix
    };
  }

  private cssPointFromClient(canvas: HTMLCanvasElement, clientX: number, clientY: number): DOMPoint {
    const rect = canvas.getBoundingClientRect();
    return new DOMPoint(clientX - rect.left, clientY - rect.top);
  }

  private computePartStates(
    params: ParameterValues,
    physicsOffsets: Map<string, Partial<Record<TransformProperty, number>>>,
    baseMatrix: Matrix2D,
    physicsDeformerOffsets: Map<string, Partial<Record<TransformProperty, number>>> = new Map()
  ): Map<string, EvaluatedPartState> {
    return evaluateRigParts(this.rig, params, baseMatrix, { physicsOffsets, physicsDeformerOffsets });
  }
  private partSize(part: RigPart): { image: HTMLImageElement; width: number; height: number } | undefined {
    if (!part.assetId) {
      return undefined;
    }
    const asset = this.rig.assets.find((entry) => entry.id === part.assetId);
    const image = this.images.get(part.assetId);
    if (!asset || !image) {
      return undefined;
    }
    return {
      image,
      width: asset.width ?? image.naturalWidth,
      height: asset.height ?? image.naturalHeight
    };
  }

  private resolvePhysicsOffsets(
    params: ParameterValues,
    dt: number,
    timeSeconds: number
  ): Map<string, Partial<Record<TransformProperty, number>>> {
    return resolveRuntimePhysicsFrame(this.rig, params, this.physicsState, dt, timeSeconds).partOffsets;
  }
}

function averageDomPoints(points: DOMPoint[]): DOMPoint | undefined {
  if (!points.length) {
    return undefined;
  }
  const sum = points.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 });
  return new DOMPoint(sum.x / points.length, sum.y / points.length);
}
function domMatrixFromMatrix(matrix: Matrix2D): DOMMatrix {
  return new DOMMatrix([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f]);
}
function drawArtPathsCanvas(
  ctx: CanvasRenderingContext2D,
  part: RigPart,
  values: ParameterValues,
  width: number,
  height: number,
  left: number,
  top: number,
  warp: ResolvedWarpDeformer | undefined,
  project?: (point: { x: number; y: number }) => { x: number; y: number }
) {
  const paths = readRigArtPaths(part);
  if (!paths.length) return;
  const bounds = { left, top, width, height };
  const baseAlpha = ctx.globalAlpha;
  for (const path of paths) {
    const resolved = resolveArtPath(path, values, width, height);
    if (!resolved) continue;
    const points = resolved.points.map((point) => {
      const local = { x: left + point.u * width, y: top + point.v * height };
      const warped = hasWarpEffect(warp) ? warpPoint(local.x, local.y, bounds, warp) : local;
      return project ? project(warped) : warped;
    });
    if (points.length < 2 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) continue;
    ctx.save();
    ctx.globalAlpha = baseAlpha * resolved.strokeColor[3] / 255;
    ctx.strokeStyle = `rgb(${resolved.strokeColor[0]} ${resolved.strokeColor[1]} ${resolved.strokeColor[2]})`;
    ctx.lineWidth = resolved.strokeWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    if (resolved.curve === "smooth" && points.length > 2 && !resolved.closed) {
      for (let index = 1; index < points.length - 1; index += 1) {
        const current = points[index];
        const next = points[index + 1];
        const midpoint = { x: (current.x + next.x) / 2, y: (current.y + next.y) / 2 };
        ctx.quadraticCurveTo(current.x, current.y, midpoint.x, midpoint.y);
      }
      const last = points[points.length - 1];
      ctx.lineTo(last.x, last.y);
    } else {
      for (let index = 1; index < points.length; index += 1) ctx.lineTo(points[index].x, points[index].y);
    }
    if (resolved.closed) ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
}
function localStitchOffsets(offsets: Map<string, GlueVertexOffset> | undefined, matrix: Matrix2D): Map<string, GlueVertexOffset> | undefined {
  if (!offsets?.size) {
    return undefined;
  }
  const local = new Map<string, GlueVertexOffset>();
  for (const [vertexId, offset] of offsets) {
    local.set(vertexId, glueStitchOffsetToLocal(offset, matrix));
  }
  return local;
}

function drawArtMesh(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  left: number,
  top: number,
  width: number,
  height: number,
  mesh: ResolvedArtMesh,
  warp: ResolvedWarpDeformer | undefined,
  project?: (point: { x: number; y: number }) => { x: number; y: number },
  stitchOffsets?: Map<string, GlueVertexOffset>
) {
  const bounds = { left, top, width, height };
  const imageWidth = image.naturalWidth || image.width || width;
  const imageHeight = image.naturalHeight || image.height || height;
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const source = [mesh.vertices[mesh.triangles[index]], mesh.vertices[mesh.triangles[index + 1]], mesh.vertices[mesh.triangles[index + 2]]];
    if (source.some((vertex) => !vertex)) continue;
    const target = source.map((vertex) => {
      const x = left + vertex.x;
      const y = top + vertex.y;
      const warped = hasWarpEffect(warp) ? warpPoint(x, y, bounds, warp) : { x, y };
      const projected = project ? project(warped) : warped;
      // The stitch is applied after warp and shared warps so it always has the final say.
      const offset = stitchOffsets?.get(vertex.id);
      return offset ? { x: projected.x + offset.dx, y: projected.y + offset.dy } : projected;
    });
    const matrix = affineTriangleMatrix(
      source.map((vertex) => ({ x: vertex.u * imageWidth, y: vertex.v * imageHeight })),
      target
    );
    if (!matrix) continue;
    ctx.save();
    const coverage = expandTriangleForCoverage(target as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }], localCoverageOverlap(ctx.getTransform()));
    ctx.beginPath();
    ctx.moveTo(coverage[0].x, coverage[0].y);
    ctx.lineTo(coverage[1].x, coverage[1].y);
    ctx.lineTo(coverage[2].x, coverage[2].y);
    ctx.closePath();
    ctx.clip();
    ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    ctx.drawImage(image, 0, 0, imageWidth, imageHeight);
    ctx.restore();
  }
}

function affineTriangleMatrix(source: Array<{ x: number; y: number }>, target: Array<{ x: number; y: number }>) {
  const [s0, s1, s2] = source;
  const [t0, t1, t2] = target;
  const sx1 = s1.x - s0.x;
  const sy1 = s1.y - s0.y;
  const sx2 = s2.x - s0.x;
  const sy2 = s2.y - s0.y;
  const determinant = sx1 * sy2 - sy1 * sx2;
  if (Math.abs(determinant) < 0.00001) return undefined;
  const tx1 = t1.x - t0.x;
  const ty1 = t1.y - t0.y;
  const tx2 = t2.x - t0.x;
  const ty2 = t2.y - t0.y;
  const a = (tx1 * sy2 - tx2 * sy1) / determinant;
  const c = (sx1 * tx2 - sx2 * tx1) / determinant;
  const b = (ty1 * sy2 - ty2 * sy1) / determinant;
  const d = (sx1 * ty2 - sx2 * ty1) / determinant;
  return { a, b, c, d, e: t0.x - a * s0.x - c * s0.y, f: t0.y - b * s0.x - d * s0.y };
}
function drawWarpedImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  left: number,
  top: number,
  width: number,
  height: number,
  warp: ResolvedWarpDeformer | undefined,
  project?: (point: { x: number; y: number }) => { x: number; y: number },
  sharedGrid?: { columns: number; rows: number }
) {
  const columns = Math.max(1, Math.round(warp?.grid.columns ?? 1), sharedGrid?.columns ?? 1);
  const rows = Math.max(1, Math.round(warp?.grid.rows ?? 1), sharedGrid?.rows ?? 1);
  const bounds = { left, top, width, height };
  const imageWidth = image.naturalWidth || image.width || width;
  const imageHeight = image.naturalHeight || image.height || height;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x0 = left + (width * column) / columns;
      const x1 = left + (width * (column + 1)) / columns;
      const y0 = top + (height * row) / rows;
      const y1 = top + (height * (row + 1)) / rows;
      const p00 = project ? project(hasWarpEffect(warp) ? warpPoint(x0, y0, bounds, warp) : { x: x0, y: y0 }) : (hasWarpEffect(warp) ? warpPoint(x0, y0, bounds, warp) : { x: x0, y: y0 });
      const p10 = project ? project(hasWarpEffect(warp) ? warpPoint(x1, y0, bounds, warp) : { x: x1, y: y0 }) : (hasWarpEffect(warp) ? warpPoint(x1, y0, bounds, warp) : { x: x1, y: y0 });
      const p11 = project ? project(hasWarpEffect(warp) ? warpPoint(x1, y1, bounds, warp) : { x: x1, y: y1 }) : (hasWarpEffect(warp) ? warpPoint(x1, y1, bounds, warp) : { x: x1, y: y1 });
      const p01 = project ? project(hasWarpEffect(warp) ? warpPoint(x0, y1, bounds, warp) : { x: x0, y: y1 }) : (hasWarpEffect(warp) ? warpPoint(x0, y1, bounds, warp) : { x: x0, y: y1 });
      drawWarpedCell(ctx, image, { x0, y0, x1, y1, left, top, width, height, imageWidth, imageHeight }, p00, p10, p11, p01);
    }
  }
}

function drawWarpedCell(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  rect: { x0: number; y0: number; x1: number; y1: number; left: number; top: number; width: number; height: number; imageWidth: number; imageHeight: number },
  p00: { x: number; y: number },
  p10: { x: number; y: number },
  p11: { x: number; y: number },
  p01: { x: number; y: number }
) {
  // Match the server renderer: a pin warp makes a cell non-affine, so p11
  // must participate in the mapping rather than only in the clipping path.
  const sx0 = ((rect.x0 - rect.left) / rect.width) * rect.imageWidth;
  const sy0 = ((rect.y0 - rect.top) / rect.height) * rect.imageHeight;
  const sx1 = ((rect.x1 - rect.left) / rect.width) * rect.imageWidth;
  const sy1 = ((rect.y1 - rect.top) / rect.height) * rect.imageHeight;
  drawWarpedTriangle(ctx, image, rect.imageWidth, rect.imageHeight, [
    { x: sx0, y: sy0 },
    { x: sx1, y: sy0 },
    { x: sx1, y: sy1 }
  ], [p00, p10, p11]);
  drawWarpedTriangle(ctx, image, rect.imageWidth, rect.imageHeight, [
    { x: sx0, y: sy0 },
    { x: sx1, y: sy1 },
    { x: sx0, y: sy1 }
  ], [p00, p11, p01]);
}

function drawWarpedTriangle(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  imageWidth: number,
  imageHeight: number,
  source: Array<{ x: number; y: number }>,
  target: Array<{ x: number; y: number }>
) {
  const matrix = affineTriangleMatrix(source, target);
  if (!matrix) return;
  ctx.save();
  const coverage = expandTriangleForCoverage(target as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }], localCoverageOverlap(ctx.getTransform()));
  ctx.beginPath();
  ctx.moveTo(coverage[0].x, coverage[0].y);
  ctx.lineTo(coverage[1].x, coverage[1].y);
  ctx.lineTo(coverage[2].x, coverage[2].y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  ctx.drawImage(image, 0, 0, imageWidth, imageHeight);
  ctx.restore();
}
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function drawChecker(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const size = 18;
  ctx.fillStyle = "#eef0f3";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#d8dde4";
  for (let y = 0; y < height; y += size) {
    for (let x = 0; x < width; x += size) {
      if ((x / size + y / size) % 2 === 0) {
        ctx.fillRect(x, y, size, size);
      }
    }
  }
}


