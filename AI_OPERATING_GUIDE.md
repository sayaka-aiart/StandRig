# AI operator entry point

You are operating StandRig, a local modeling and playback engine accessed through MCP or HTTP. The owner specifies the desired artwork and motion. Read AGENTS.md before editing. This document is part of the tool distribution, not permission to publish or transmit artwork.

## Connection and first reads

For MCP setup and the 12 available tools, read `docs/MCP.md`. Read `standrig://docs/contract` (AGENTS.md), then `standrig://docs/guide` via MCP resources. For imports, use only a parts-separated PSD with at least two drawable image layers; PNG/flattened PSD/PSB inputs are not supported. The parser cannot certify whether the layer separation is suitable for animation.

Default base URL: `http://127.0.0.1:5180`. Start with `GET /api/context`.
Read `context.revision`, `context.semanticHash`, `context.summary.counts`, role/modeling audit and freeze state. Never reuse IDs or revisions from an example or another model.
An empty distribution has zero assets; request material import before modeling. Numeric QA on an empty model is expected to fail with `empty-image`.

Next read `GET /api/parts`, `GET /api/deformers`, `GET /api/params`, `GET /api/modeling` and `GET /api/modeling/techniques` as needed. Query an individual `/api/parts/{id}` or `/api/deformers/{id}` for detailed bindings/topology. Prefer compact records; do not repeatedly fetch `/api/rig` or embedded data URLs.

Route inventory: `docs/api-routes.json`. Main API schemas: `docs/openapi.json`. All action variants: `docs/OPERATIONS.md` and `packages/core/src/operationRegistry.ts`. Nested Rig* types: `packages/core/src/types.ts`. Do not invent methods or action fields.

## Import and project isolation

PSD parsing is browser-side through the supplied import screen; there is no HTTP multipart PSD endpoint or MCP PSD-import tool. Import preserves initial layer placement, not a finished rig or automatic motion bindings. See docs/PSD.md for preparation and Photoshop feature limitations.
An AI with an existing compatible RigDocument uses `/api/modeling/transaction` with `kind:"import"`, the complete `rig`, current `expectedRevision`, explicit `qa` and `commit:false`. Inspect the result before committing. The PSD/sample UI uses the same path. See docs/API.md.
External textures must already exist under the selected data directory's `public/`; embedded PNG assets are portable without externalization. Legacy asset persistence is disabled by default. For a portable `standrig-bundle`, import `bundle.rig`, never the wrapper. No bundle picker is included in the PSD UI.

## Required visual reference gate

Before the first modeling write for a PSD, create the three required project-local target sheets: face neutral/max yaw/pitch/roll; full body neutral/max body yaw/pitch/roll; connections (hair roots/back hair, jaw/neck, neck/collar/shoulders, sleeves/arms, waist/skirt/thighs, thighs/lower legs).
Save source revision/hash, panel order, intended parameter extremes, prompts and acceptance checks beside them. Use `examples/reference-manifest.template.json`; placeholder entries are not evidence. All actual images must exist and be visually inspected. Do not treat snapshots of the current faulty model as accepted target artwork.

The MCP server has no image-generation or arbitrary-file-writing tool. Use separately available file/image tools or owner-provided targets to prepare these materials in the selected data directory. Explain missing capabilities if unavailable; never claim these resources were created merely by calling standrig_render.
This is an operator requirement from AGENTS.md: the transaction endpoint does not automatically inspect the manifest or judge the images. Enforce it yourself; the endpoint's HTTP success is not evidence that the visual gate passed.
When source coverage is missing, extend the missing artwork before deformation according to the owner's method. RGB alpha bleed fills invisible RGB, not visible alpha coverage.

## One regional change cycle

1. Poll `GET /api/changes?since=REVISION`. If `resyncRequired:true`, reload context and target records. If a known transaction changed your target, refresh those records. The journal is in memory; a restart can require resync.
2. Confirm actual role and target ID. Role inference is a suggestion. Use `role-confirm` only after examining the part; never infer identity from filenames alone.
3. Write a bounded transaction JSON. Always include `expectedRevision`, `commit:false`, nonempty `operations` and explicit `qa`. Use known pose IDs from `/api/modeling`; include neutral, intended extremes, intermediate and diagonal poses appropriate to the change. `poseSamples` can define exact parameter values.
4. POST it to `/api/modeling/transaction`. Check HTTP status, `ok`, `committed`, `validation.ok`, `physicsSafety.pass`, `operationGateIssues`, `operationResults[].skipped`, `qa.ok` and `qa.failed`. `revisionAfter` in a dry-run describes the candidate; it is not the stored revision. Do not use it as the next expectedRevision.
5. Confirm the stored revision is unchanged. If QA fails, request only `qa.failureRegions[].imageRequest` via `/api/qa/failure-image`; the default is a 240px before/after/diff crop. This endpoint uses the stored rig, not the discarded dry-run candidate. Candidate imagery requires a separately cloned tool/project folder containing that candidate; never claim the live screenshot shows an uncommitted candidate.
6. Create a checkpoint through `standrig_checkpoint` (or POST `/api/checkpoints`). The service automatically creates a rollback checkpoint after gates pass and before saving, for both HTTP and MCP; use `standrig_restore` to recover. Checkpoints include referenced PNGs, but also preserve the source PSD, visual evidence and transaction request separately. The default data directory is `workspace/`, not the source repository root. Server transaction history is not persistent undo.
7. After numeric checks pass and the change is authorized, send the identical body with `commit:true` and the current expectedRevision. Check `committed:true`. Do not silently remove failing QA or increase tolerances to force acceptance.
8. Run `/api/qa/check` again and compare relevant saved golden evidence. Golden POST actions are disabled by default. Render actual maximum poses using `/api/screenshot` or `/api/reference/sheet`, compare against the target images and save a visual review. Required target/max-pose sheets are exceptions to the small diagnostic-image policy. Reject holes, disconnected joints/features, perspective errors and flat translation substituting for rotation. Continue to another region only after this change is accepted.

Golden checks require real prior baseline data. `GET /api/qa/golden` lists the available goldens; an empty list is not a passed regression test. Do not register the changed output as its own proof of correctness.

## Coordinate and modeling rules

Read actual stage dimensions and parameter definitions. Stage coordinates use pixels; texture UV is normalized 0..1. Part transform pivots and ArtMesh offsets have distinct types. Read their contracts before mixing them.
Do not infer camera direction/sign from a parameter name. Use supplied reference panels and observed rendering. Define neutral keys explicitly. Avoid duplicating the same motion in parent and child layers.
Order: face/eyes/mouth/fringe/roots → neck/shoulder/clothing/body pitch → physical response of tails and cloth after static keyforms pass → visual freeze. Camera calibration and OBS are outside this package.

## Errors and acceptance

- 400: malformed or invalid request. Inspect `error` and the source contract; correct inputs.
- 404: unknown part or excluded endpoint. Refresh IDs; camera/OBS/Geometry Assist execution is not available here.
- 405: wrong HTTP method; use the documented one.
- 409: stale revision. Read changes/context, review concurrent changes, reconstruct the candidate. Do not blindly retry a commit.
- 422: transaction gate failed. Inspect validation, physics and QA. Do not bypass the transaction with raw PUT/PATCH.
- 500: inspect the local server's error and required input files. Preserve current model data before attempting repair.
- HTTP 200 with `ok:false` is failure; HTTP 200 with `committed:false` is not a saved edit.

Legacy writes are disabled by default (403). Do not enable `--allow-legacy-writes` to bypass failed checks. Operations/import require `qa` and `expectedRevision` at the server boundary. Revision uses SHA-256; fetch fresh context after upgrading. The local service serializes model requests within one process. Run only one service process per data directory.
Numeric/static/build success alone cannot establish visual quality or Model Freeze. Report actual saved visual evidence and unresolved limitations separately. The included automated tests use synthetic shapes, not the owner's character.

## Minimal client

```sh
node examples/agent-client.mjs
node examples/agent-client.mjs examples/transaction.json
```

The client prints context or sends a dry-run. It deliberately refuses `commit:true`; the owning AI must construct and verify its own explicit commit request after the above gates.

For numeric Brush operations and owner-local Part/Deformer/ArtPath/Glue Blend Shapes, read [docs/DEFORM.md](docs/DEFORM.md). The operation schema alone does not describe coordinate units or supported destination combinations.
