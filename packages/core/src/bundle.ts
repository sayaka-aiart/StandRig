import { parseTrackingProfile, type TrackingProfile } from "./trackingProfile.js";
import { cloneRig, type RigDocument } from "./types.js";
import { hydrateRigAssets, type RigAssetManifest } from "./assetManifest.js";

/**
 * Self-contained model bundle: rig (with data-URL assets) plus the tracking
 * profile in one JSON document. This is the handoff format for the future
 * standalone tracking/streaming runtime (TRACKING_ROADMAP.md Phase T3).
 */
export const MODEL_BUNDLE_FORMAT = "standrig-bundle";
export const MODEL_BUNDLE_VERSION = 1;

export interface ModelBundle {
  format: typeof MODEL_BUNDLE_FORMAT;
  version: typeof MODEL_BUNDLE_VERSION;
  name: string;
  exportedAt: string;
  rig: RigDocument;
  trackingProfile?: TrackingProfile;
}

export function createModelBundle(rig: RigDocument, trackingProfile?: TrackingProfile): ModelBundle {
  return {
    format: MODEL_BUNDLE_FORMAT,
    version: MODEL_BUNDLE_VERSION,
    name: rig.name || "model",
    exportedAt: new Date().toISOString(),
    rig: cloneRig(rig),
    trackingProfile
  };
}

export async function createSelfContainedModelBundle(
  rig: RigDocument,
  manifest: RigAssetManifest,
  read: (path: string) => Promise<Uint8Array>,
  trackingProfile?: TrackingProfile
): Promise<ModelBundle> {
  return createModelBundle(await hydrateRigAssets(rig, manifest, read), trackingProfile);
}
export function parseModelBundle(value: unknown): { rig: RigDocument; trackingProfile?: TrackingProfile } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<ModelBundle>;
  if (record.format !== MODEL_BUNDLE_FORMAT || record.version !== MODEL_BUNDLE_VERSION) {
    return undefined;
  }
  const rig = record.rig as RigDocument | undefined;
  if (!rig || typeof rig !== "object" || typeof rig.schemaVersion !== "string" || !Array.isArray(rig.parts)) {
    return undefined;
  }
  const trackingProfile = record.trackingProfile ? parseTrackingProfile(record.trackingProfile, rig) : undefined;
  return { rig, trackingProfile };
}
