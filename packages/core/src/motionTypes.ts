export interface MotionKey {
    /** @minimum 0 */
    time: number;
    value: number;
    segment?: {
        kind: 'linear' | 'hold' | 'inverse-hold';
    } | {
        kind: 'bezier';
        control1: {
            time: number;
            value: number;
        };
        control2: {
            time: number;
            value: number;
        };
    };
}
export interface MotionTrack {
    parameter: string;
    keys: MotionKey[];
}
export interface MotionClip {
    format: 'standrig-motion';
    version: 1;
    name: string;
    /** @exclusiveMinimum 0
     * @maximum 3600 */
    duration: number;
    tracks: MotionTrack[];
}
export type MotionRequest = {
    action: 'load';
    clip: MotionClip;
} | {
    action: 'play' | 'pause' | 'stop' | 'clear';
} | {
    action: 'seek';
    /** @minimum 0
     * @maximum 3600 */
    time: number;
} | {
    action: 'configure';
    /** @minimum 0.1
     * @maximum 4 */
    speed?: number;
    loop?: boolean;
};
export interface MotionState {
    loaded: boolean;
    name: string | null;
    duration: number;
    time: number;
    running: boolean;
    active: boolean;
    ended: boolean;
    speed: number;
    loop: boolean;
    parameterIds: string[];
}
