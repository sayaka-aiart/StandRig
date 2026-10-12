export { RigRuntime } from "./renderer.js";
export type { RenderOptions } from "./renderer.js";
export * from "./playback.js";
export { FacialController } from './facial.js';
export { parseExpression, importExpression, exportExpression, VISEME_IDS } from '@standrig/core/facial';
export type { FacialPresets, FacialRequest, FacialState, ExpressionDocument, RegisteredExpression, VisemeId } from '@standrig/core/facial';

export { MotionController } from './motion.js';
export { parseMotion, sampleMotion, importMotionWith } from '@standrig/core/motion';
export type { MotionClip, MotionRequest, MotionState, MotionImporter, MotionImportContext, MotionImportIssue } from '@standrig/core/motion';
