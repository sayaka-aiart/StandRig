/// <reference types="vite/client" />

import type { RigInspectionResult } from "./rig/inspect";
import type { ModelingAuditResult } from "./rig/modelingAudit";
import type { ModelFreezeReadiness } from "./rig/modelFreeze";
import type { ModelingPosePreset } from "./rig/modeling";
import type { ModelingOperation, ModelingOperationResult } from "./rig/modelingOps";
import type { ModelingHistoryEntry } from "./rig/modelingHistory";
import type { GlueSeamHandle, RendererParityResult } from "./rig/renderer";
import type { WarpPinMirrorResult } from "./rig/warpPinLinks";
import type { PromoteGlueCandidatesOptions, PromoteGlueCandidatesResult } from "./rig/glue";
import type { ParameterValues, RigDeformer, RigDocument, RigGlue, RigGlueCandidate, RigPart, RigPhysics, RigTracking, RigWarpPin, TrackingInputValues, TransformProperty } from "./rig/types";
import type { TrackingProfile } from "./rig/trackingProfile";
import type { ModelBundle } from "./rig/bundle";

declare global {
  interface Window {
    codexRig?: {
      getRig: () => RigDocument;
      inspect: () => RigInspectionResult;
      auditModeling?: () => ModelingAuditResult;
      getModelFreezeReadiness?: () => ModelFreezeReadiness;
      setRig: (rig: RigDocument) => Promise<void>;
      getParams: () => ParameterValues;
      setParams: (values: Partial<ParameterValues>) => void;
      getModelingPoses?: () => Array<ModelingPosePreset & { values: ParameterValues }>;
      previewModelingOperation?: (operation: ModelingOperation) => ModelingOperationResult;
      applyModelingOperation?: (operation: ModelingOperation) => ModelingOperationResult;
      getModelingOperationHistory?: () => { canUndo: boolean; canRedo: boolean; undoCount: number; redoCount: number; entries: ModelingHistoryEntry[] };
      undoModelingOperation?: () => ModelingHistoryEntry | undefined;
      redoModelingOperation?: () => ModelingHistoryEntry | undefined;
      applyModelingPose?: (poseId: string) => ParameterValues;
      upsertPartKey?: (partId: string, parameter: string, property: TransformProperty, input: number, value: number) => RigPart | undefined;
      getPhysics?: () => RigPhysics;
      getDeformers?: () => RigDeformer[];
      getGlueCandidates?: () => RigGlueCandidate[];
      getGlue?: () => RigGlue[];
      getGlueSeamHandles?: () => GlueSeamHandle[];
      hitTestGlueSeamPoint?: (clientX: number, clientY: number) => GlueSeamHandle | undefined;
      clientPointToPartUv?: (partId: string, clientX: number, clientY: number) => { u: number; v: number } | undefined;
      updateGlueSeamPoint?: (glueId: string, seamIndex: number, side: "a" | "b", uv: { u: number; v: number }) => RigGlue | undefined;
      promoteGlueCandidates?: (options?: PromoteGlueCandidatesOptions) => PromoteGlueCandidatesResult;
      getWarpPins?: (deformerId: string) => RigWarpPin[];
      getSelectedWarpPin?: () => { deformerId: string; pinIndex: number; pin: RigWarpPin } | undefined;
      getWarpPinEditMode?: () => "position" | "offset";
      setWarpPinEditMode?: (mode: "position" | "offset") => "position" | "offset";
      selectWarpPin?: (deformerId: string, pinIdOrIndex: string | number) => RigWarpPin | undefined;
      nudgeWarpPin?: (deformerId: string, pinIdOrIndex: string | number, delta: { u?: number; v?: number }) => RigWarpPin | undefined;
      nudgeWarpPinOffset?: (deformerId: string, pinIdOrIndex: string | number, delta: { x?: number; y?: number }) => RigWarpPin | undefined;
      mirrorWarpPin?: (deformerId: string, pinIdOrIndex: string | number, options?: { create?: boolean; tolerance?: number }) => RigWarpPin | undefined;
      linkWarpPinMirror?: (deformerId: string, pinIdOrIndex: string | number, options?: { create?: boolean; tolerance?: number }) => WarpPinMirrorResult | undefined;
      applyWarpPinMirrorLink?: (deformerId: string, pinIdOrIndex: string | number, options?: { create?: boolean; tolerance?: number }) => WarpPinMirrorResult | undefined;
      unlinkWarpPinMirror?: (deformerId: string, pinIdOrIndex: string | number) => WarpPinMirrorResult | undefined;
      updateWarpPin?: (deformerId: string, pinIdOrIndex: string | number, patch: Partial<RigWarpPin>) => RigWarpPin | undefined;
      updateDeformers?: (deformers: RigDeformer[]) => void;
      updateGlueCandidates?: (glueCandidates: RigGlueCandidate[]) => void;
      updateGlue?: (glue: RigGlue[]) => void;
      updatePhysics?: (physics: RigPhysics) => void;
      getTracking?: () => RigTracking;
      updateTracking?: (tracking: RigTracking) => void;
      applyTracking?: (values: Partial<TrackingInputValues>) => ParameterValues;
      startFaceTracking?: () => Promise<void>;
      stopFaceTracking?: () => void;
      getTrackingProfile?: () => TrackingProfile;
      saveTrackingProfile?: () => Promise<void>;
      reloadTrackingProfile?: () => Promise<void>;
      loadTrackingRecording?: (recording: unknown) => boolean;
      playTrackingRecording?: (options?: { loop?: boolean }) => void;
      stopTrackingPlayback?: () => void;
      exportModelBundle?: () => ModelBundle;
      updatePart: (id: string, patch: Partial<RigPart>) => void;
      selectPart?: (id: string) => void;
      saveRig?: () => Promise<void>;
      renderOnce?: () => void;
      renderParity?: (options?: { fitPadding?: number; threshold?: number; maxDifferingPixelRatio?: number; maxMeanChannelDelta?: number; webglMeshPartIds?: readonly string[] }) => RendererParityResult;
      webglContextRecoveryProbe?: (delayMs?: number) => Promise<{ supported: boolean; statusAfterLoss: string; statusAfterRestore: string }>;
    };
  }
}

export {};
