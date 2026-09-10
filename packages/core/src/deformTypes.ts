import type { ParameterCurve, ParameterInterpolation } from './types.js';
export interface BlendWeight {
    id: string;
    parameter: string;
    neutralInput: number;
    targetInput: number;
    interpolation?: ParameterInterpolation;
    curve?: ParameterCurve;
}
/** Translation in local pixels, rotation in degrees, scale as a positive multiplier at weight=1. */
export interface TransformDelta {
    x?: number;
    y?: number;
    rotation?: number;
    scaleX?: number;
    scaleY?: number;
    opacity?: number;
}
export interface PointDelta {
    id: string;
    x: number;
    y: number;
}
export interface PartBlendShape extends BlendWeight {
    kind: 'part';
    transform: TransformDelta;
}
export interface DeformerBlendShape extends BlendWeight {
    kind: 'deformer';
    transform?: TransformDelta;
    warp?: {
        bendX?: number;
        bendY?: number;
        taperX?: number;
        taperY?: number;
    };
    pins?: PointDelta[];
    sharedPoints?: PointDelta[];
}
export interface ArtPathBlendShape extends BlendWeight {
    kind: 'art-path';
    pathId: string;
    /** Point deltas in normalized texture UV. Width is pixels; opacity is additive. */
    points?: PointDelta[];
    width?: number;
    opacity?: number;
}
export interface GlueBlendShape extends BlendWeight {
    kind: 'glue';
    glueId: string;
    strength: number;
}
export type ExtendedBlendShape = PartBlendShape | DeformerBlendShape | ArtPathBlendShape | GlueBlendShape;
export type BrushEffect = {
    mode: 'smooth';
    strength: number;
} | {
    mode: 'relax';
    strength: number;
} | {
    mode: 'inflate';
    distance: number;
} | {
    mode: 'pinch';
    strength: number;
    axis: [
        number,
        number
    ];
} | {
    mode: 'bend';
    angle: number;
    axis: [
        number,
        number
    ];
} | {
    mode: 'contour-follow';
    strength: number;
    guide: Array<[
        number,
        number
    ]>;
    vertexIds: string[];
};
export type BrushSurface = {
    kind: 'artmesh';
    space: 'mesh-local';
} | {
    kind: 'warp-pins';
    space: 'warp-local';
    width: number;
    height: number;
} | {
    kind: 'shared-warp';
    space: 'stage';
};
export type BrushDestination = {
    kind: 'base';
} | {
    kind: 'blend-shape';
    shape: BlendWeight;
} | {
    kind: 'keyform';
    parameter: string;
    input: number;
};
export interface DeformBrush {
    surface: BrushSurface;
    center: [
        number,
        number
    ];
    radius: number;
    effect: BrushEffect;
    iterations: number;
    maxDisplacement: number;
    falloff: 'linear' | 'smooth';
    lockedIds?: string[];
    /** Explicit ordered connections for irregular Warp Pins. Mesh/grid adjacency is derived. */
    edges?: Array<[
        string,
        string
    ]>;
    destination: BrushDestination;
}
