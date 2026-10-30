import type { RigBlendMode, RigDocument, RigPart } from './types.js';
import type { RgbaImage } from './png.js';

/** PSD names are normalized once at import; rendering uses the same vocabulary everywhere. */
export function psdBlendMode(value: string | undefined): RigBlendMode | undefined {
  const mode = String(value ?? 'normal').trim().toLowerCase();
  if (mode === 'pass through') return undefined;
  if (['linear dodge', 'linear dodge (add)', 'add', 'additive'].includes(mode)) return 'additive';
  if (mode === 'color dodge') return 'color-dodge';
  if (mode === 'soft light') return 'soft-light';
  return ['normal', 'multiply', 'screen', 'overlay'].includes(mode) ? mode as RigBlendMode : undefined;
}

export function canvasBlendMode(mode: RigBlendMode | undefined): GlobalCompositeOperation {
  return mode === 'additive' ? 'lighter' : mode === 'normal' || !mode ? 'source-over' : mode;
}

/** Separable blend function, with straight channels in [0,1]. */
export function blendChannel(backdrop: number, source: number, mode: RigBlendMode): number {
  switch (mode) {
    case 'multiply': return backdrop * source;
    case 'screen': return 1 - (1 - backdrop) * (1 - source);
    case 'additive': return Math.min(1, backdrop + source);
    case 'color-dodge': return backdrop === 0 ? 0 : source >= 1 ? 1 : Math.min(1, backdrop / (1 - source));
    case 'overlay': return backdrop <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
    case 'soft-light': {
      const d = backdrop <= 0.25 ? ((16 * backdrop - 12) * backdrop + 4) * backdrop : Math.sqrt(backdrop);
      return source <= 0.5 ? backdrop - (1 - 2 * source) * backdrop * (1 - backdrop) : backdrop + (2 * source - 1) * (d - backdrop);
    }
    default: return source;
  }
}

/** Straight-alpha source-over, or a clipped layer whose backdrop alpha must stay fixed. */
export function compositeRgba(target: RgbaImage, source: RgbaImage, mode: RigBlendMode, opacity = 1, preserveAlpha = false): void {
  if (target.width !== source.width || target.height !== source.height) throw new Error('Composite dimensions must match');
  for (let i=0;i<target.data.length;i+=4) {
    const sa = source.data[i+3] / 255 * opacity, da = target.data[i+3] / 255;
    if (sa <= 0 || (preserveAlpha && da <= 0)) continue;
    const oa = preserveAlpha ? da : sa + da * (1-sa);
    for (let c=0;c<3;c++) {
      const s=source.data[i+c]/255, d=target.data[i+c]/255, b=blendChannel(d,s,mode);
      target.data[i+c] = Math.round(255 * (preserveAlpha ? d*(1-sa)+b*sa : (s*sa*(1-da)+b*sa*da+d*da*(1-sa))/oa));
    }
    target.data[i+3] = Math.round(oa*255);
  }
}

export interface CompositeNode { part: RigPart; children: CompositeNode[]; clipped: CompositeNode[] }

/** Explicit opt-in: old rigs retain their global draw order and existing alpha-mask semantics. */
export function hasLayerCompositing(rig: RigDocument): boolean {
  return rig.parts.some(part => part.compositing !== undefined || part.clippingBaseId !== undefined || part.rasterMaskPartId !== undefined);
}

export function layerCompositingPlan(rig: RigDocument): CompositeNode[] {
  const nodes = new Map(rig.parts.map(part => [part.id, {part, children: [], clipped: []} as CompositeNode]));
  const roots: CompositeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.part.parentId ? nodes.get(node.part.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const prepare = (list: CompositeNode[]): CompositeNode[] => {
    list.sort((a,b) => a.part.drawOrder - b.part.drawOrder);
    const siblings = new Map(list.map(node => [node.part.id, node]));
    for (const node of list) node.children = prepare(node.children);
    return list.filter(node => {
      const base = node.part.clippingBaseId ? siblings.get(node.part.clippingBaseId) : undefined;
      if (base && base !== node) { base.clipped.push(node); return false; }
      return true;
    });
  };
  return prepare(roots);
}

export interface LayerPainter<Surface> {
  create(): Surface;
  release(surface: Surface): void;
  state(part: RigPart): {opacity: number; visible: boolean} | undefined;
  draw(surface: Surface, part: RigPart, opacityScale: number, mode: RigBlendMode): void;
  compose(target: Surface, source: Surface, mode: RigBlendMode, opacity: number, preserveAlpha?: boolean): void;
  mask?(surface: Surface, part: RigPart): void;
}

/** Isolated groups and clipping stacks share one traversal in Canvas and numeric QA. */
export function paintLayerPlan<Surface>(plan: CompositeNode[], target: Surface, painter: LayerPainter<Surface>): void {
  const paint = (node: CompositeNode, destination: Surface, scale: number, unclipped = false, normalOuter = false, unmasked = false): void => {
    const state = painter.state(node.part);
    if (!state?.visible || state.opacity <= 0) return;
    const opacity = state.opacity * scale;
    const mode = normalOuter ? 'normal' : node.part.blendMode ?? 'normal';
    if (!unclipped && node.clipped.length) {
      const stack = painter.create();
      paint(node, stack, 1 / state.opacity, true, true);
      for (const overlay of node.clipped) {
        const content = painter.create();
        paint(overlay, content, scale, true, true);
        painter.compose(stack, content, overlay.part.blendMode ?? 'normal', 1, true);
        painter.release(content);
      }
      painter.compose(destination, stack, mode, opacity);
      painter.release(stack);
    } else if (!unmasked && node.part.rasterMaskPartId) {
      const content=painter.create();
      paint(node,content,1/state.opacity,true,true,true);
      painter.mask?.(content,node.part);
      painter.compose(destination,content,mode,opacity);
      painter.release(content);
    } else if (node.part.kind === 'group') {
      if (node.part.compositing === 'isolate') {
        const group = painter.create();
        for (const child of node.children) paint(child, group, 1 / state.opacity);
        painter.compose(destination, group, mode, opacity);
        painter.release(group);
      } else {
        for (const child of node.children) paint(child, destination, scale);
      }
    } else painter.draw(destination, node.part, scale, mode);
  };
  for (const node of plan) paint(node, target, 1);
}
