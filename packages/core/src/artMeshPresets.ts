import type { RigArtMeshPreset, RigArtMeshQuality, RigArtMeshTopology, RigDocument, RigPartRole } from "./types.js";

export interface ArtMeshGenerationProfile {
  id: string;
  label: string;
  roles: RigPartRole[];
  preset: RigArtMeshPreset;
  topology: RigArtMeshTopology;
  columns: number;
  rows: number;
  alphaThreshold: number;
  quality: Pick<RigArtMeshQuality, "minTriangleArea" | "maxTriangleAspectRatio">;
  boundaryPolicy: "lock-and-pin";
  purpose: string;
}

const PROFILES: readonly ArtMeshGenerationProfile[] = [
  {
    id: "face-outline",
    label: "Face contour",
    roles: ["face"],
    preset: "outline",
    topology: "alpha-contour",
    columns: 8,
    rows: 6,
    alphaThreshold: 8,
    quality: { minTriangleArea: 4, maxTriangleAspectRatio: 8 },
    boundaryPolicy: "lock-and-pin",
    purpose: "輪郭・顎の外周を保持し、AngleX/Yの局所変形へ備える"
  },
  {
    id: "eyelids",
    label: "Eyelids and lashes",
    roles: ["eye-left", "eye-right"],
    preset: "eyelid",
    topology: "alpha-contour",
    columns: 4,
    rows: 3,
    alphaThreshold: 8,
    quality: { minTriangleArea: 1.5, maxTriangleAspectRatio: 8 },
    boundaryPolicy: "lock-and-pin",
    purpose: "上まつ毛・まぶたの閉じ形状と目周辺の接合を保持する"
  },
  {
    id: "mouth",
    label: "Mouth and lips",
    roles: ["mouth"],
    preset: "mouth",
    topology: "alpha-contour",
    columns: 6,
    rows: 3,
    alphaThreshold: 8,
    quality: { minTriangleArea: 1, maxTriangleAspectRatio: 8 },
    boundaryPolicy: "lock-and-pin",
    purpose: "口線・上下唇・口内の開閉と中間形状を局所制御する"
  },
  {
    id: "hair-roots",
    label: "Hair roots",
    roles: ["hair-front", "hair-back", "hair-side", "hair-tail-left", "hair-tail-right"],
    preset: "hair-root",
    topology: "alpha-contour",
    columns: 6,
    rows: 4,
    alphaThreshold: 8,
    quality: { minTriangleArea: 2, maxTriangleAspectRatio: 10 },
    boundaryPolicy: "lock-and-pin",
    purpose: "前髪・後ろ髪・ツインテール根元の固定と局所追従を分離する"
  },
  {
    id: "face-features",
    label: "Brows and cheeks",
    roles: ["brow-left", "brow-right", "face-feature"],
    preset: "face-feature",
    topology: "alpha-contour",
    columns: 6,
    rows: 3,
    alphaThreshold: 8,
    quality: { minTriangleArea: 1, maxTriangleAspectRatio: 10 },
    boundaryPolicy: "lock-and-pin",
    purpose: "眉・頬を独立ArtMesh化し、ParamBrowLY/RY・ParamCheekのneutral境界と局所変形を準備する"
  },
  {
    id: "neck-shoulders",
    label: "Neck and shoulder joints",
    roles: ["neck", "torso", "clothing"],
    preset: "outline",
    topology: "rect-grid",
    columns: 4,
    rows: 3,
    alphaThreshold: 8,
    quality: { minTriangleArea: 4, maxTriangleAspectRatio: 10 },
    boundaryPolicy: "lock-and-pin",
    purpose: "首・肩・胸上端の接合部を固定し、後段のBody変形へ備える"
  }
];

export function artMeshGenerationProfiles(): ArtMeshGenerationProfile[] {
  return PROFILES.map((profile) => ({ ...profile, roles: [...profile.roles], quality: { ...profile.quality } }));
}

export function getArtMeshGenerationProfile(id: string): ArtMeshGenerationProfile | undefined {
  const profile = PROFILES.find((entry) => entry.id === id);
  return profile ? structuredClone(profile) : undefined;
}

export interface ArtMeshProfileCandidate {
  id: string;
  name: string;
  role?: RigPartRole;
  roleStatus?: "suggested" | "confirmed";
  assetId?: string;
  hasArtMesh: boolean;
  eligible: boolean;
  reason?: "role-not-confirmed" | "asset-required" | "artmesh-exists";
}

export function artMeshProfileCandidates(rig: RigDocument, profileId: string): {
  profile: ArtMeshGenerationProfile;
  candidates: ArtMeshProfileCandidate[];
  eligiblePartIds: string[];
} | undefined {
  const profile = getArtMeshGenerationProfile(profileId);
  if (!profile) return undefined;
  const candidates = rig.parts
    .filter((part) => part.kind === "image" && profile.roles.includes(part.role ?? "unknown"))
    .map((part) => {
      const hasArtMesh = part.artMesh?.enabled === true;
      const roleConfirmed = part.roleStatus === "confirmed";
      const eligible = roleConfirmed && Boolean(part.assetId) && !hasArtMesh;
      const reason: ArtMeshProfileCandidate["reason"] = eligible ? undefined : hasArtMesh ? "artmesh-exists" : !roleConfirmed ? "role-not-confirmed" : "asset-required";
      return {
        id: part.id,
        name: part.name,
        role: part.role,
        roleStatus: part.roleStatus,
        assetId: part.assetId,
        hasArtMesh,
        eligible,
        reason
      };
    });
  return { profile, candidates, eligiblePartIds: candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.id) };
}