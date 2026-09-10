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
    /** @minimum 0
     * @maximum 1 */
    strength: number;
} | {
    mode: 'relax';
    /** @minimum 0
     * @maximum 1 */
    strength: number;
} | {
    mode: 'inflate';
    /** @minimum 0 */
    distance: number;
} | {
    mode: 'pinch';
    /** @minimum 0
     * @maximum 1 */
    strength: number;
    axis: [
        number,
        number
    ];
} | {
    mode: 'bend';
    /** @minimum -180
     * @maximum 180 */
    angle: number;
    axis: [
        number,
        number
    ];
} | {
    mode: 'contour-follow';
    /** @minimum 0
     * @maximum 1 */
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
    /** @exclusiveMinimum 0 */
    width: number;
    /** @exclusiveMinimum 0 */
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
    /** @exclusiveMinimum 0 */
    radius: number;
    effect: BrushEffect;
    /** @integer
     * @minimum 1
     * @maximum 50 */
    iterations: number;
    /** @exclusiveMinimum 0 */
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
