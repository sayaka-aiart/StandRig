import { analyzeParameterDistribution, type ParameterDistributionAudit } from "./parameterDistribution.js";
import type { RigDocument } from "./types.js";

export interface ModelingTechniqueSource {
  id: string;
  title: string;
  url: string;
  usedFor: string;
}

export interface ModelingTechniqueItem {
  id: string;
  title: string;
  live2dTechnique: string;
  currentSupport: "supported" | "partial" | "missing";
  currentEvidence: string;
  qualityImpact: string;
  recommendedImplementation: string;
  priority: "P0" | "P1" | "P2" | "P3";
}

export interface CodexModelingQualityPlan {
  generatedAt: string;
  summary: {
    score: number;
    supported: number;
    partial: number;
    missing: number;
  };
  parameterDistribution: ParameterDistributionAudit;
  sources: ModelingTechniqueSource[];
  techniques: ModelingTechniqueItem[];
  codexWorkflow: Array<{
    step: string;
    purpose: string;
    automation: string;
  }>;
  nextImplementation: string[];
}

export function modelingTechniqueGuideForRig(rig: RigDocument): CodexModelingQualityPlan {
  const hasWarpPins = (rig.deformers ?? []).some((deformer) => (deformer.warp?.pins?.length ?? 0) > 0);
  const hasWarpGrid = (rig.deformers ?? []).some((deformer) => deformer.warp?.enabled);
  const hasRotationDeformer = (rig.deformers ?? []).some((deformer) => deformer.kind === "rotate");
  const hasHierarchy = rig.parts.some((part) => Boolean(part.parentId)) || (rig.deformers ?? []).some((deformer) => Boolean(deformer.parentId));
  const physicsChainCount = rig.physics?.chains?.length ?? 0;
  const hasPhysics = physicsChainCount > 0;
  const parameterDistribution = analyzeParameterDistribution(rig);
  const overloadedDeformers = parameterDistribution.overloadedTargets;

  const techniques: ModelingTechniqueItem[] = [
    {
      id: "artmesh-editable-vertices",
      title: "Editable ArtMesh vertices and triangulation",
      live2dTechnique: "PSD layers become ArtMeshes, and moving mesh vertices creates expression and motion. Meshes can be edited beyond the minimal imported state.",
      currentSupport: "partial",
      currentEvidence: `${rig.assets.length} PSD/image assets exist, but runtime deformation is still grid/pin based rather than true per-vertex ArtMesh editing.`,
      qualityImpact: "True vertices are needed for cheek, eyelid, mouth corner, collar, and hidden-edge corrections that cannot be solved by whole-image transforms.",
      recommendedImplementation: "Add per-part mesh vertex data, triangle indices, UVs, hit-testing, vertex handles, and JSON keyforms for selected vertices.",
      priority: "P0"
    },
    {
      id: "warp-deformer-divisions",
      title: "Warp deformer divisions",
      live2dTechnique: "Warp deformers use conversion divisions and Bezier divisions; higher divisions follow detailed deformation but add cost and editing effort.",
      currentSupport: hasWarpGrid ? "partial" : "missing",
      currentEvidence: hasWarpGrid ? "Warp grid rows/columns exist, and warp pins emulate localized control." : "No enabled warp grids found.",
      qualityImpact: "Controlled divisions help bend hair, clothing, and face planes without stretching unrelated pixels.",
      recommendedImplementation: "Promote current warp pins into editable deformer control grids with division presets, handles, and per-pose previews.",
      priority: "P0"
    },
    {
      id: "rotation-for-shape-preserving-motion",
      title: "Rotation deformer for shape-preserving motion",
      live2dTechnique: "Rotation deformers are used when an object should rotate without the shrinkage that can happen with linear interpolation.",
      currentSupport: hasRotationDeformer ? "partial" : "missing",
      currentEvidence: hasRotationDeformer ? "Rotate deformers exist, but standard angle/handle metadata and dedicated UI are still minimal." : "No rotate deformers found.",
      qualityImpact: "Head, arm, ribbon, and accessory rotations look cleaner when rotation is separated from warp deformation.",
      recommendedImplementation: "Add rotation-handle UI, standard angle metadata, and audit hints that suggest rotation deformers when a part is mostly rotating.",
      priority: "P1"
    },
    {
      id: "deformer-hierarchy",
      title: "Parent-child deformer hierarchy",
      live2dTechnique: "Parent deformers move children, while child deformation does not affect parents; distributing motion across hierarchy reduces keyform explosion.",
      currentSupport: hasHierarchy ? "supported" : "missing",
      currentEvidence: hasHierarchy ? "Parts and deformers already have parentId relationships." : "No parent-child relationships found.",
      qualityImpact: "This is essential for natural face/body counter-motion and for keeping neck, shoulder, and hair roots coherent.",
      recommendedImplementation: "Add hierarchy visualization, orphan/depth audit, and suggestions that split overloaded deformer parameters into parent/child layers.",
      priority: "P1"
    },
    {
      id: "parameter-distribution",
      title: "Distributed parameter keyforms",
      live2dTechnique: "Complex motion is split across objects/deformers instead of assigning many parameters to one drawable object.",
      currentSupport: overloadedDeformers.length ? "partial" : "supported",
      currentEvidence: overloadedDeformers.length ? `Modeling audit flags ${overloadedDeformers.length} review targets: ${overloadedDeformers.slice(0, 6).map((target) => target.id).join(", ")}.` : "Parameter distribution audit found no overloaded deformers.",
      qualityImpact: "Better parameter distribution keeps Codex edits understandable and avoids accidental cross-pose breakage.",
      recommendedImplementation: overloadedDeformers[0]?.splitSuggestions[0] ?? "Keep checking parameter distribution before adding stronger deformation keys.",
      priority: "P1"
    },
    {
      id: "draw-order-keyforms",
      title: "Draw order keyforms",
      live2dTechnique: "Draw order keyforms and draw order groups change which parts appear in front as the model turns or expressions change.",
      currentSupport: "missing",
      currentEvidence: "Parts have static drawOrder values, but no parameter-bound draw order keys or draw order groups.",
      qualityImpact: "Hair, cheeks, mouth interiors, arms, and clothing can pop in the wrong layer during side angles without keyed draw order.",
      recommendedImplementation: "Add parameter-bound draw order keys, draw order groups, and a front/back overlap audit for face, hair, arms, and clothes.",
      priority: "P1"
    },
    {
      id: "glue-seams",
      title: "Glue-style seam binding",
      live2dTechnique: "Glue binds overlapping vertices from two ArtMeshes, with per-vertex weights and keyform-controlled compatibility.",
      currentSupport: "missing",
      currentEvidence: "Rig schema has no glue/binding object between two meshes.",
      qualityImpact: "Neck-to-body, sleeve-to-shoulder, mouth-lip, and hair-root seams need controlled attachment instead of only coincident transforms.",
      recommendedImplementation: "Add `glue` JSON objects with partA/partB vertex pairs, weightA/weightB, compatibility bindings, and seam debug overlay.",
      priority: "P0"
    },
    {
      id: "clipping-masks",
      title: "Clipping masks",
      live2dTechnique: "Clipping masks are commonly used for blinking and other cases where one ArtMesh limits another.",
      currentSupport: "missing",
      currentEvidence: "Renderer has draw order and opacity, but no mask render pass or clipping IDs.",
      qualityImpact: "Eye whites, pupils, eyelids, mouth interior, and hair overlap can leak without masks.",
      recommendedImplementation: "Add mask part IDs, offscreen alpha mask composition, mask diagnostics, and transparent-mask support.",
      priority: "P0"
    },
    {
      id: "pose-closeup-cycle",
      title: "Pose and close-up QA cycle",
      live2dTechnique: "Cubism workflows rely on checking key poses, parent-child effects, and problematic small regions repeatedly.",
      currentSupport: "supported",
      currentEvidence: "Reference sheets, detail closeups, per-pose PNG/stats reports, baseline diff, diff-overlay crops, multi-region detail-cycle remodeling queues, part-boundary diagnostics, and first-class glue candidate extraction are implemented.",
      qualityImpact: "Codex can tune more safely when it sees pose-by-pose before/after evidence instead of one full-body screenshot.",
      recommendedImplementation: "Review and accept recurring glueCandidates, then promote them into real glue, mask, and true mesh targets.",
      priority: "P0"
    },
    {
      id: "runtime-reference-parity",
      title: "Runtime/reference evaluation parity",
      live2dTechnique: "A modeling workflow must check the same deformer and physics result that will be used at runtime; preview, generated references, and OBS should agree before fine seam tuning.",
      currentSupport: "partial",
      currentEvidence: "Browser and server renderers both resolve transforms and warp, but the evaluation code is duplicated and browser physics is not represented in server reference images yet.",
      qualityImpact: "Codex can tune against false failures if reference PNGs omit physics or diverge from the OBS renderer.",
      recommendedImplementation: "Extract a pure rig evaluator for part, deformer, warp, and physics state; add deterministic physics time for screenshots; make browser and server renderers consume the same evaluated scene.",
      priority: "P0"
    },
    {
      id: "physics-secondary-motion",
      title: "Physics and secondary motion",
      live2dTechnique: "Physics groups create delayed secondary motion for hair, clothing, and soft parts.",
      currentSupport: hasPhysics ? "supported" : "missing",
      currentEvidence: hasPhysics ? `${physicsChainCount} physics chains use authored deformer origins, temporal QA, and finite/structural-motion gates.` : "No physics chains found.",
      qualityImpact: "Hair and clothing receive delayed secondary motion without rotating around Part-local zero.",
      recommendedImplementation: "Tune per-chain stiffness/damping and add warp/pin output modes only after origin and seam QA pass.",
      priority: "P1"
    }
  ];

  const supported = techniques.filter((item) => item.currentSupport === "supported").length;
  const partial = techniques.filter((item) => item.currentSupport === "partial").length;
  const missing = techniques.filter((item) => item.currentSupport === "missing").length;
  const score = Math.round(((supported + partial * 0.55) / techniques.length) * 100);

  return {
    generatedAt: new Date().toISOString(),
    summary: { score, supported, partial, missing },
    parameterDistribution,
    sources: [
      {
        id: "live2d-artmesh",
        title: "Live2D Cubism Editor Manual: About ArtMeshes",
        url: "https://docs.live2d.com/en/cubism-editor-manual/concept-of-artmesh/",
        usedFor: "ArtMesh/mesh vertex requirements and blend-mode caveats."
      },
      {
        id: "live2d-deformer",
        title: "Live2D Cubism Editor Manual: About Deformers",
        url: "https://docs.live2d.com/en/cubism-editor-manual/deformer/",
        usedFor: "Warp vs rotation deformer roles and linear interpolation shrinkage."
      },
      {
        id: "live2d-warp",
        title: "Live2D Cubism Editor Manual: Warp Deformer",
        url: "https://docs.live2d.com/en/cubism-editor-manual/making-and-placement-of-warp-deformer/",
        usedFor: "Warp division concepts and child keyform sizing."
      },
      {
        id: "live2d-rotation",
        title: "Live2D Cubism Editor Manual: Rotation Deformer",
        url: "https://docs.live2d.com/en/cubism-editor-manual/making-and-rotation-of-rotationdeformer/",
        usedFor: "Rotation handles, standard angle, and shape-preserving motion."
      },
      {
        id: "live2d-hierarchy",
        title: "Live2D Cubism Editor Manual: Parent-Child Hierarchy Structure",
        url: "https://docs.live2d.com/en/cubism-editor-manual/system-of-parent-child-relation/",
        usedFor: "Parent/child deformation propagation."
      },
      {
        id: "live2d-parameters",
        title: "Live2D Cubism Editor Manual: Parameters",
        url: "https://docs.live2d.com/en/cubism-editor-manual/parameter/",
        usedFor: "Parameter keyform roles and standard parameter naming."
      },
      {
        id: "live2d-keyforms",
        title: "Live2D Cubism Editor Manual: Keyforms (Parent-Child Hierarchy Movement)",
        url: "https://docs.live2d.com/en/cubism-editor-manual/keyform-parent-chilid-relation/",
        usedFor: "Distributing parameters across object/deformer hierarchy."
      },
      {
        id: "live2d-draw-order",
        title: "Live2D Cubism Editor Manual: Draw Order",
        url: "https://docs.live2d.com/en/cubism-editor-manual/draworder/",
        usedFor: "Draw order keyforms and front/back overlap planning."
      },
      {
        id: "live2d-glue",
        title: "Live2D Cubism Editor Manual: Glue",
        url: "https://docs.live2d.com/en/cubism-editor-manual/glue/",
        usedFor: "Seam binding, weights, compatibility, and load tradeoffs."
      },
      {
        id: "live2d-clipping",
        title: "Live2D Cubism Editor Manual: Clipping Mask",
        url: "https://docs.live2d.com/en/cubism-editor-manual/clipping-mask/",
        usedFor: "Mask-based eyelid/eye/mouth containment and mask caveats."
      }
    ],
    techniques,
    codexWorkflow: [
      {
        step: "1. Generate reference and detail sheets",
        purpose: "See full-body pose balance and small seam failures.",
        automation: "`npm run reference:generate` plus detail links from Preview."
      },
      {
        step: "2. Run modeling technique audit",
        purpose: "Ask which Live2D-style technique is missing before changing values.",
        automation: "`GET /api/modeling/techniques` or `npm run modeling:quality-plan`."
      },
      {
        step: "3. Apply a small script-backed modeling pass",
        purpose: "Keep Codex edits reproducible and backed up.",
        automation: "Use scripts such as `rig:neck-tune`, then compare generated before/after detail sheets."
      },
      {
        step: "4. Promote recurring fixes into runtime features",
        purpose: "Avoid endlessly tuning around missing primitives.",
        automation: "When a seam repeatedly fails, implement mesh vertices, glue, masks, or deformer UI instead of more offsets."
      }
    ],
    nextImplementation: [
      "Extract a shared pure evaluator so Preview, OBS, and server reference PNGs use the same transform, warp, and physics state.",
      "Add true per-part ArtMesh vertex/triangle data and vertex keyforms.",
      "Add clipping mask render pass for eyes, mouth, and hair overlap.",
      "Add glue-style seam binding for neck/shoulder/hair-root/lip connections.",
      "Add pose manifest + individual pose PNG + image diff/alpha bbox report.",
      "Add physics v2 outputs to deformer, warp, and pin offsets with deterministic screenshot time.",
      "Add deformer hierarchy, draw-order, and parameter-overload audit to the UI."
    ]
  };
}



