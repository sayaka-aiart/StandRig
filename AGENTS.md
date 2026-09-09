# StandRig modeling agent contract

## Mandatory pre-model visual reference gate

1. Before the first modeling write for a PSD, generate and save all of the following project-local targets: a face close-up sheet covering neutral and maximum yaw/pitch/roll, a full-body sheet covering neutral and maximum body yaw/pitch/roll, and a connection-overlap sheet for hair roots/back hair, jaw/neck, neck/collar/shoulders, sleeves/arms, waist/skirt/thighs, and thighs/lower legs.
2. Save a manifest beside the images that pins the source revision/hash, panel order, intended parameter extremes, prompts, and acceptance checks. Modeling transactions are blocked until this manifest and every required target image exist.
3. If the PSD does not contain enough hidden artwork to keep a connection covered at maximum motion, generate or paint the missing extension before deforming it. Do not hide missing source coverage with thresholds or by reducing the target range.
4. After each accepted head or body change, render the actual model at the same maximum poses and compare it visually with the targets. Reject square transparency holes, detached features, flat translation used as rotation, broken perspective, and any connection gap.
5. Numeric QA is necessary but never sufficient for Model Freeze. Freeze requires a saved visual-review report and actual face/full-body/contact-sheet evidence for all maximum poses.
6. The failure-image size limits below apply to diagnostic images from numeric QA. The required pre-model target sheets and final maximum-pose visual comparison sheets are explicit exceptions.

## Low-token workflow

1. Start with `GET /api/context`; do not open `public/rig.json` unless the context API explicitly lacks required detail.
2. Address parts by confirmed role ID and then request a compact part/deformer record only when needed.
3. Poll `/api/changes?since=<revision>` before reloading context; resync only when it reports `resyncRequired`.
4. Run numeric QA before requesting any image.
5. Call `/api/qa/failure-image` only for entries returned in `failed`; it returns one before/after/diff comparison PNG.
6. Request failure-region images only; use 240px crops or one contact sheet, never a set of independent full-body PNGs.
7. Apply modeling changes through `/api/modeling/transaction` once available. Until then, use dry-run modeling operations and preserve a rollback point.
8. After every accepted change, run QA/golden checks before editing another region.

## Data-size rules

- Prefer `/api/context`, `/api/rig/summary`, `/api/parts`, `/api/modeling/audit`.
- Do not request embedded asset data or full rig documents by default.
- Treat `data:` URLs as opt-in diagnostic data only.

## Modeling order

1. Head: face, eyes, mouth, fringe, hair roots.
2. Body: neck/shoulder/clothing joints and body pitch.
3. Bind physics outputs only to tail/cloth meshes after static keyforms pass.
4. Freeze model with saved visual evidence. Camera tracking and OBS control are external adapters; playback and numeric input are included.
## Distribution entry point

Read AI_OPERATING_GUIDE.md, docs/MCP.md and docs/API.md. Work only on parts-separated PSDs; no automatic part separation. Default model data is in workspace/, which must never be published. Start at http://127.0.0.1:5180/api/context.
