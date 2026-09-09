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
| GET, POST | `/api/modeling/physics-safety` | Structural/temporal safety; `packages/core/src/physicsSafety.ts` |
| GET | `/api/qa/golden` | List existing golden sets |
| POST | `/api/qa/golden` | Check/propose/register golden via action; see implementation and visual workflow first |
| GET | `/api/reference` | Available sheet IDs, detail IDs, URLs |
| GET | `/api/reference/sheet?set=ID` | Actual-model reference contact sheet PNG |
| GET | `/api/screenshot` | Actual stored model PNG; query below |
| GET | `/api/geometry/export?partId=ID&contractVersion=1.1` | Mesh geometry export; external lab runner not included |
| GET | `/api/bundle` | Model bundle JSON, including asset payloads |
| GET | `/api/schema` | Rig JSON Schema |
| GET | `/api/rig` | Whole rig, embedded asset payloads replaced with asset:// IDs |
| GET | `/api/rig?includeAssets=1` | Whole rig with actual asset sources; explicit opt-in |
| PUT, POST | `/api/rig?includeAssets=1` | Import/restore a full RigDocument, replacing current model |
| GET | `/api/assets/externalize` | Asset manifest diagnostics |
| POST, PUT | `/api/assets/externalize` | `{rig:FULL_RIG,dryRun:true}`; false persists assets and rig |

The modeling route inventory and new service routes are in `api-routes.json`, generated from `apps/service/src/rigApiPlugin.ts` with source line numbers. GET endpoints occasionally describe further actions. For advanced skinning, symmetry, glue, generation request/asset acceptance and art paths, follow the listed source handler and its imported request types. The generation endpoints manage requests and provided artwork; this package does not include an image-generation service.

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

The server clones the current rig, applies operations to the clone, runs validation/physics safety and optional `qa`. Only `commit:true` writes. Important response fields:

| Field | Meaning |
| --- | --- |
| `ok` | Candidate gates passed; inspect even on HTTP 200 |
| `committed` / `dryRun` | Whether the stored model was changed / trial mode |
| `revisionBefore` | Revision read at transaction start |
| `revisionAfter` | Candidate revision, including during dry-run |
| `operationResults` | Matched parts, exact changes, skipped reasons |
| `operationGateIssues` | Operation-level refusal reasons |
| `validation` / `physicsSafety` | Structural and physical checks |
| `qa` | Numeric candidate QA if supplied |
| `artMeshSampler` | Alpha-contour asset loading results |
| `transactionResult` / `noWrite` | Normalized mutation evidence |

`expectedRevision` and `qa` are optional server fields, but the AI workflow requires both. There is no automatic persistent undo, visual judgment or reference-manifest enforcement in this handler. Preserve a file backup and visual evidence yourself. Raw rig/part/deformer PATCH endpoints can bypass these checks and should not replace this workflow.

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

`GET /api/screenshot?width=240&height=240&physics=0&ParamAngleX=30` renders the stored model. Query parameters support `set`, `detail`, `partIds`, `focusParts`, `forceParts`, `width`, `height`, `padding`, `transparent`, `physics`, `physicsTime`, `physicsSteps`, `supersample`, and parameter IDs. Read available sets/details from `/api/modeling` and `/api/reference`. Dimensions refer to panels for contact-sheet modes. Do numeric QA before diagnostic images; do not repeatedly request large full-body renders.

## Errors and persistence

400 invalid input; 404 absent/excluded target; 405 method; 409 revision conflict; 422 failed commit gate; 500 internal/file error. Read the JSON error rather than inferring success from a connection. A failed dry-run can return HTTP 200 with `ok:false`. Stale updates must be rebuilt from fresh context.

Data lives under the selected data directory (default `workspace/`): `public/rig.json`, `public/assets`, `public/assets-manifest.json`, `public/goldens`, and generation evidence directories as created by the relevant handlers. Restart clears the in-memory transaction journal. Model changes notify the preview/player; save external evidence before committing.


## Playback, checkpoints and export (0.2.0)

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/api/playback` | `{ok,playback}`; transient values, modelVersion, playing, connectedOutputs |
| GET | `/api/playback/events` | SSE `playback` events and keepalives |
| POST | `/api/playback/parameters` | `{source,sequence,values}`; see ADAPTERS.md |
| POST | `/api/playback/control` | `{command:"play"|"pause"|"reset"}` |
| POST | `/api/playback/reload` | Reload the stored model; resets transient values/source counters |
| GET, POST | `/api/checkpoints` | List metadata / create a self-contained checkpoint |
| POST | `/api/checkpoints/restore` | `{id,expectedRevision}`; saves current state first; returns rollback metadata |
| POST | `/api/exports/bundle` | Write a self-contained bundle to the data directory and return its path |
| GET | `/api/sample` | Bundled geometric sample RigDocument; no import/write by this GET |

New playback inputs are atomically rejected with 400 on invalid values or stale source sequences. Model restore uses 409 on revision mismatch. Output connections are not rendering acknowledgments. The service rejects foreign Host/Origin with 403. Requests and frames are local only; there is no remote authentication.
