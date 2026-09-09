import { normalizeTracking } from "./tracking.js";
import type { RigDocument, RigTracking } from "./types.js";

/**
 * Tracking settings live in their own file (public/tracking-profile.json) so
 * modeling-side rig rebuilds and backup restores never revert tracking work.
 * The rig.json `tracking` section remains as a fallback for rigs without a
 * profile; when a profile exists it wins.
 */
export const TRACKING_PROFILE_FORMAT = "standrig-tracking-profile";
export const TRACKING_PROFILE_VERSION = 1;
export const TRACKING_PROFILE_FILENAME = "tracking-profile.json";

export interface TrackingProfile {
  format: typeof TRACKING_PROFILE_FORMAT;
  version: typeof TRACKING_PROFILE_VERSION;
  name?: string;
  updatedAt?: string;
  tracking: RigTracking;
}

export interface TrackingProfilePreset {
  id: string;
  name: string;
  updatedAt: string;
  profile: TrackingProfile;
}

export function createTrackingProfile(rig: RigDocument, tracking?: RigTracking, name?: string): TrackingProfile {
  return {
    format: TRACKING_PROFILE_FORMAT,
    version: TRACKING_PROFILE_VERSION,
    name: name ?? `${rig.name || "model"} tracking profile`,
    updatedAt: new Date().toISOString(),
    tracking: normalizeTracking(tracking ?? rig.tracking, rig)
  };
}

export function parseTrackingProfile(value: unknown, rig: RigDocument): TrackingProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<TrackingProfile> & { tracking?: unknown };
  if (record.format !== TRACKING_PROFILE_FORMAT || record.version !== TRACKING_PROFILE_VERSION) {
    return undefined;
  }
  if (!record.tracking || typeof record.tracking !== "object" || Array.isArray(record.tracking)) {
    return undefined;
  }
  return {
    format: TRACKING_PROFILE_FORMAT,
    version: TRACKING_PROFILE_VERSION,
    name: typeof record.name === "string" && record.name.trim() ? record.name : undefined,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
    tracking: normalizeTracking(record.tracking as RigTracking, rig)
  };
}

export function parseTrackingProfilePreset(value: unknown, rig: RigDocument): TrackingProfilePreset | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as { id?: unknown; name?: unknown; updatedAt?: unknown; profile?: unknown };
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
  if (!id) {
    return undefined;
  }
  const profile = parseTrackingProfile(record.profile, rig);
  if (!profile) {
    return undefined;
  }
  const name = typeof record.name === "string" && record.name.trim()
    ? record.name.trim()
    : profile.name ?? "tracking preset";
  return {
    id,
    name,
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim() ? record.updatedAt : profile.updatedAt ?? new Date(0).toISOString(),
    profile: { ...profile, name }
  };
}

export function parseTrackingProfilePresets(value: unknown, rig: RigDocument): TrackingProfilePreset[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  return value
    .map((entry) => parseTrackingProfilePreset(entry, rig))
    .filter((preset): preset is TrackingProfilePreset => {
      if (!preset || seen.has(preset.id)) {
        return false;
      }
      seen.add(preset.id);
      return true;
    });
}
/**
 * Browser-side loader. Prefers the dev-server API, then the static file for
 * API-less hosting. Returns undefined when no profile exists so callers keep
 * the rig.json tracking fallback.
 */
export async function fetchTrackingProfile(rig: RigDocument): Promise<TrackingProfile | undefined> {
  const apiResponse = await fetch("/api/tracking-profile", { cache: "no-store" }).catch(() => null);
  if (apiResponse?.ok) {
    const body = (await apiResponse.json().catch(() => undefined)) as { profile?: unknown } | undefined;
    const profile = parseTrackingProfile(body?.profile, rig);
    if (profile) {
      return profile;
    }
  }

  const staticResponse = await fetch(`/${TRACKING_PROFILE_FILENAME}`, { cache: "no-store" }).catch(() => null);
  if (staticResponse?.ok) {
    const body = await staticResponse.json().catch(() => undefined);
    const profile = parseTrackingProfile(body, rig);
    if (profile) {
      return profile;
    }
  }

  return undefined;
}

export async function saveTrackingProfile(profile: TrackingProfile): Promise<"api" | "download" | "failed"> {
  const body = JSON.stringify(profile, null, 2);
  const response = await fetch("/api/tracking-profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body
  }).catch(() => null);

  if (response?.ok) {
    return "api";
  }

  try {
    const blob = new Blob([`${body}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = TRACKING_PROFILE_FILENAME;
    anchor.click();
    URL.revokeObjectURL(url);
    return "download";
  } catch (_error) {
    return "failed";
  }
}
