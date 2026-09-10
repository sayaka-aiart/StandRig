# API reference

Base URL: `http://127.0.0.1:5180`. JSON requests use `Content-Type: application/json`.
The API runs with `npm start` after `npm run build`. `npm run dev` starts only the optional UI development server and expects the service at 5180. No cloud account or model API key is required.

## Main endpoints

| Method | Path | Purpose / request |
| --- | --- | --- |
| GET | `/api/health` | App ID and available route inventory |
| GET | `/api/context` | `{ok,context:{revision,semanticHash,summary,...}}` |
| GET | `/api/changes?since=rig-...` | Current revision, changed, transactions, resyncRequired when applicable |
| GET | `/api/parts` | `{ok,parts,counts}` compact part list |
| GET | `/api/parts/{id}` | `{ok,part}` detailed part, ID URL-encoded |
| GET | `/api/deformers` | Deformer list |
| GET | `/api/deformers/{id}` | Detailed deformer |
| GET | `/api/params` | Parameter definitions and preview values |
| GET | `/api/modeling` | Modeling poses, regions and state |
| GET | `/api/modeling/audit` | Modeling issues and recommendations |
| GET | `/api/modeling/techniques` | Rig-specific modeling technique guide |
| GET | `/api/modeling/role-suggestions` | Inferred roles; not confirmation |
| GET | `/api/modeling/artmesh-presets` | Mesh generation profiles |
| GET | `/api/rig/validate` | `{ok,validation,...}` structural checks |
| GET | `/api/rig/summary` | Compact rig summary |
| GET | `/api/rig/inspect` | Rig inspection |
| POST | `/api/modeling/transaction` | Bounded operation list; detailed below |
| POST | `/api/qa/check` | Numeric renders / triangle and optional motion QA |
| POST | `/api/qa/failure-image` | Returned failure imageRequest → PNG comparison |
| POST | `/api/qa/exposure` | Source coverage/exposure diagnosis; `packages/core/src/exposureQa.ts` |
| POST | `/api/qa/joins` | Connection QA; `packages/core/src/joinQa.ts` |
| GET | `/api/modeling/physics-safety` | Structural/temporal safety; `packages/core/src/physicsSafety.ts` |
| GET | `/api/qa/golden` | List existing golden sets |
| POST | `/api/qa/golden` | Legacy POST actions disabled by default (403), including check/propose |
| GET | `/api/reference` | Available sheet IDs, detail IDs, URLs |
| GET | `/api/reference/sheet?set=ID` | Actual-model reference contact sheet PNG |
| GET | `/api/screenshot` | Actual stored model PNG; query below |
| GET | `/api/geometry/export?partId=ID&contractVersion=1.1` | Mesh geometry export; external lab runner not included |
| GET | `/api/bundle` | Model bundle JSON, including asset payloads |
| GET | `/api/schema` | Rig JSON Schema |
| GET | `/api/rig` | Whole rig, embedded asset payloads replaced with asset:// IDs |
| GET | `/api/rig?includeAssets=1` | Whole rig with actual asset sources; explicit opt-in |
| PUT, POST | `/api/rig?includeAssets=1` | Legacy replacement disabled by default (403); use import transaction |
| GET | `/api/assets/externalize` | Asset manifest diagnostics |
| POST, PUT | `/api/assets/externalize` | Legacy persistence disabled by default (403), including dry-run |

The modeling route inventory and new service routes are in `api-routes.json`, generated from `apps/service/src/routes/*.ts` with source line numbers. GET endpoints occasionally describe further actions. For advanced skinning, symmetry, glue, generation request/asset acceptance and art paths, follow the listed source handler and its imported request types. The generation endpoints manage requests and provided artwork; this package does not include an image-generation service.

The inventory also reads exact service routes from `apps/service/src/service.ts`. `defaultMethods` lists methods enabled by default; `methods` includes legacy opt-in methods. Inventory method lists summarize a handler; not every method applies to every subpath. `openapi.json` covers the principal workflows, not every inherited action-specific schema. See `docs/OPERATIONS.md` and the referenced TypeScript types for those bodies.

## Modeling transaction

```json
{
  "expectedRevision": "REPLACE_WITH_CONTEXT_REVISION",
  "commit": false,
  "operations": [{
    "id": "local-change-001",
    "name": "Adjust selected part",
    "target": {"partIds": ["REPLACE_WITH_CONFIRMED_PART_ID"]},
    "action": {"type": "transform", "property": "x", "operator": "add", "value": 1}
  }],
  "qa": {"poses": ["neutral"], "regions": ["full"], "width": 240, "height": 240, "physics": false}
}
```

This is a syntax example, not a completed motion test. Replace IDs and choose model-specific max/intermediate poses before use. `target.roles` matches only parts with confirmed roles. Where an action takes a deformerId, also include it in target.deformerIds as required by the action. Actions are discriminated by `action.type`; see OPERATIONS.md for every supported field.

The server clones the current rig, applies operations to the clone, runs validation/physics safety and required `qa`. Only `commit:true` writes. Important response fields:

| Field | Meaning |
| --- | --- |
| `ok` | Candidate gates passed; inspect even on HTTP 200 |
| `committed` / `dryRun` | Whether the stored model was changed / trial mode |
| `revisionBefore` | Revision read at transaction start |
| `revisionAfter` | Candidate revision, including during dry-run |
| `operationResults` | Matched parts, exact changes, skipped reasons |
| `operationGateIssues` | Operation-level refusal reasons |
| `validation` / `physicsSafety` | Structural and physical checks |
| `qa` | Numeric candidate QA for operations/import |
| `artMeshSampler` | Alpha-contour asset loading results |
| `transactionResult` / `noWrite` | Normalized mutation evidence |

`expectedRevision` and `qa` are required for operations/import, including dry-run. Typed operation objects reject unknown keys. Successful commit gates create a persistent `rollbackCheckpoint` immediately before atomic model replacement. Visual judgment and reference-manifest enforcement remain operator obligations.

Revisions are opaque `rig-sha256-` plus 64 hexadecimal characters: SHA-256 of the JSON-serialized complete migrated rig, including assets. Fetch fresh context after upgrading from FNV revisions; do not calculate revisions in clients. `semanticHash` remains a non-security compact hint and cannot be used for concurrency checks.

Legacy write methods return **403 `legacy_write_api_disabled`** before their handlers execute. This includes raw rig/part/deformer edits, asset persistence, golden POST actions and specialized legacy transactions. Audited read-only POST methods are listed in `packages/contracts/src/legacyPolicy.mjs`. Append-only checkpoint/export creation remains available separately. For temporary compatibility only, `npm start -- --allow-legacy-writes` explicitly re-enables old bypasses; these do not have the new transaction guarantees. Keep this flag off for AI operation.

## Import and restore transactions

After browser PSD parsing, or extracting `rig` from a portable bundle, send:

```json
{"kind":"import","expectedRevision":"CURRENT_REVISION","commit":false,"rig":{},"qa":{"poses":["neutral"],"regions":["full"],"width":240,"height":240,"physics":false}}
```

Replace `{}` with the complete compatible RigDocument. Inspect the dry-run before sending the same request with `commit:true`. Restore uses `{"kind":"restore","checkpointId":"CHECKPOINT_UUID","expectedRevision":"CURRENT_REVISION","commit":true}` at the same endpoint. Restore validates structure but can return to an empty checkpoint without QA. `/api/checkpoints/restore` delegates to this same application service. All three kinds share revision checks, serialization, rollback checkpoints and atomic persistence.

## Numeric QA and screenshots

```json
{
  "poseSamples": [
    {"poseId": "neutral", "values": {"ParamAngleX": 0, "ParamAngleY": 0}},
    {"poseId": "selected-extreme", "values": {"ParamAngleX": 30, "ParamAngleY": 0}}
  ],
  "regions": ["full"], "width": 240, "height": 240,
  "physics": false, "checkTriangleDistortion": true
}
```

Use actual ranges from `/api/params`; 30 is only an example. The response includes the stored `revision`, `ok`, `entries`, `failed`, `failureRegions`, `renderedCount`, `imagePolicy` and `cache`. Each failureRegions entry supplies an `imageRequest` accepted by `/api/qa/failure-image`. If the model is empty, `empty-image` is expected.

Pass the returned `imageRequest` intact: it includes sampled `values`, `beforeValues` and physics settings needed to reproduce custom `poseSamples`. Pose IDs in custom samples are labels, not necessarily registered modeling poses. Duplicate sample labels and unknown named poses/regions are rejected. The comparison panels are neutral/baseline pose, failed pose and pixel difference of the **same stored model**, not revisions before and after an edit.

`GET /api/screenshot?width=240&height=240&physics=0&ParamAngleX=30` renders the stored model. Query parameters support `set`, `detail`, `partIds`, `focusParts`, `forceParts`, `width`, `height`, `padding`, `transparent`, `physics`, `physicsTime`, `physicsSteps`, `supersample`, and parameter IDs. Read available sets/details from `/api/modeling` and `/api/reference`. Dimensions refer to panels for contact-sheet modes. Do numeric QA before diagnostic images; do not repeatedly request large full-body renders.

## Errors and persistence

400 invalid input; 403 disabled legacy write or foreign origin; 404 absent/excluded target; 405 method; 409 revision conflict; 422 failed commit gate; 500 internal/file error. Read the JSON error rather than inferring success from a connection. A failed dry-run can return HTTP 200 with `ok:false`. Stale updates must be rebuilt from fresh context.

Data lives under the selected data directory (default `workspace/`): `public/rig.json`, `public/assets`, `public/assets-manifest.json`, `public/goldens`, and generation evidence directories as created by the relevant handlers. Restart clears the in-memory transaction journal. Model changes notify the preview/player; save external evidence before committing.


## Playback, checkpoints and export (0.2.0)

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/api/playback` | `{ok,playback}`; transient values, sessionId, modelVersion, playing, connectedOutputs |
| GET | `/api/playback/events` | SSE `playback` events and keepalives |
| POST | `/api/playback/parameters` | `{source,sequence,values}`; see ADAPTERS.md |
| POST | `/api/playback/control` | `{command:"play"|"pause"|"reset"|"demo-start"|"demo-stop"|"demo-pointer", mode?, x?, y?}` |
| POST | `/api/playback/reload` | Reload the stored model; resets transient values/source counters |
| GET, POST | `/api/checkpoints` | List metadata / create a self-contained checkpoint |
| POST | `/api/checkpoints/restore` | `{id,expectedRevision}`; saves current state first; returns rollback metadata |
| POST | `/api/exports/bundle` | Write a self-contained bundle to the data directory and return its path |
| GET | `/api/sample` | Bundled geometric sample RigDocument; no import/write by this GET |

New playback inputs are atomically rejected with 400 on invalid values or stale source sequences. Model restore uses 409 on revision mismatch. Output connections are not rendering acknowledgments. The service rejects foreign Host/Origin with 403. Requests and frames are local only; there is no remote authentication.

`demo-start` accepts `mode:"showcase-active"` (default, original Showcase Fast & Wide) or `mode:"mouse-expression"`. The service emits demo poses at approximately 30 Hz. `demo-pointer` requires finite `x` and `y` in [-1,1] and an active mouse-expression demo; +X points right, +Y down. Mouse input is smoothed. `playback.demo` reports `active`, `mode` and discovered authored `parameterIds`. Unrigged models reject demo start. The choreography uses standard parameter IDs and clamps values to the model's declared ranges; custom-only bindings are not automatically choreographed.

`demo-stop` restores the starting values, playing flag and input source. Play/pause/reset or a valid parameter frame first stops the demo, then applies the requested change to the restored state. Invalid input leaves the demo running. Model reload/import/restore and service shutdown also stop it. Demos are transient and never edit the saved rig; closing a browser tab does not stop the service's demo.

Checkpoint creation and bundle export return **201**; restore returns **200**. Model imports and legacy handlers allow up to 64 MiB request bodies; playback/checkpoint control bodies have a 1 MiB limit. Errors must be inspected even when HTTP status is 200. The checkpoint/export files stay on the service host; returned paths are not download URLs.

## Portable bundle import

Read the exported JSON and check `format:"standrig-bundle"`. Extract `bundle.rig` and submit it through the import transaction described above using fresh context revision and explicit QA. Inspect dry-run before committing, then confirm `committed:true`, `rollbackCheckpoint` and actual browser rendering. Never pass the bundle wrapper as the rig. MCP has no bundle-import tool; use an HTTP-capable client. For ordinary resume, start the service with the same data directory; no re-import is necessary.

## Native motion playback

Use GET/POST `/api/playback/motion` or MCP `standrig_motion` to load and control a native clip. Playback supports seek, speed, loop and channel ownership. Embedded `StandRigPlayer` exposes the same transport. See [MOTION.md](MOTION.md) for the strict format, external-input arbitration, physics seek limitations and future Live2D importer contract. Actual motion3 import is not included.

## Optional Cubism connection

See [CUBISM-BRIDGE.md](CUBISM-BRIDGE.md) for the separate HTTP adapter, connection status, read queries and transient pose tools.

## Optional Cubism connection

See [CUBISM-BRIDGE.md](CUBISM-BRIDGE.md) for /api/bridge/status, /api/bridge/read and /api/bridge/pose.

## Optional Cubism connection

See [CUBISM-BRIDGE.md](CUBISM-BRIDGE.md) for /api/bridge/status, /api/bridge/read and /api/bridge/pose.

## Optional Cubism connection

See [CUBISM-BRIDGE.md](CUBISM-BRIDGE.md) for /api/bridge/status, /api/bridge/read and /api/bridge/pose.
