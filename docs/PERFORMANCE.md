# Large models and dense keyforms

The existing JSON and `.srig` formats remain supported. No artwork, motion keys or
deformation ranges are reduced by these optimizations.

## Storage and export

Small model JSON remains indented. Once its compact representation exceeds
8,388,608 characters, browser JSON exports and service model saves use compact
JSON. This avoids multiplying a dense offset document into a much larger
indented string. Parsing, JSON serialization and browser model loading still
need the full document in memory. This is not a streaming/binary model format.

Portable export and manifest hydration each create one owned geometry copy.
Embedding assets does not require a second complete model clone. Exported models
remain independent of the current model; PNG checks, local-path confinement,
manifest verification, transaction QA and atomic file replacement are retained.
Import/restore no longer clone a current model that will immediately be discarded.
Operation transactions still edit a separate candidate.

The HTTP model-body limit remains 384 MiB. Compressed-file size is not the same as
expanded JSON size. Packed offset JSON and automatic external PNG storage are
described below. Parsing still needs the full JSON document in memory; these
changes do not implement a streaming geometry container.

## Playback and editing

`StandRigPlayer` owns a cloned model snapshot. Its `RigRuntime` caches derived grid
indexes, key order, mesh structural validation and normalized sparse-offset lists
for that snapshot. Grid lookup selects only the enclosing 4 or 8 corners using
binary axis search. Visited multi-keyforms also compile numeric Float64 offset
lanes in mesh-vertex order, retaining sparse-presence information. This trades
some snapshot memory for fewer per-corner string/Map lookups. Rendered frames are
not retained. The original mutable authoring representation remains available.

Core functions and default `new RigRuntime(rig)` remain uncached for mutable
callers. In-place edits are visible on the next evaluation as before. An explicit
`new RigRuntime(rig, { cacheEvaluation: true })` requires an owned stable snapshot;
after any model edit, call `await runtime.setRig(rig)`, even if reusing the same
object. That discards the old indexes. Disposal also releases them. Cache scopes
are synchronous, nested safely and are restored after errors.

Motion-track time lookup already uses binary search. These changes primarily
address dense model keyforms, not the number of authored motion keys. Values,
interpolation, duplicate-key behavior, incomplete-grid rejection and zero-weight
replacement corners are preserved.

## Measuring locally

Build first, then run separate processes for comparable peaks:

```sh
node --expose-gc --max-old-space-size=8192 scripts/benchmark-model.mjs --model MODEL_JSON --poses POSE_FRAMES_JSON --output geometry-uncached.json
node --expose-gc --max-old-space-size=8192 scripts/benchmark-model.mjs --model MODEL_JSON --poses POSE_FRAMES_JSON --prepared --output geometry-prepared.json
node --expose-gc --max-old-space-size=8192 scripts/benchmark-model.mjs --mode bundle --model MODEL_JSON --public-dir PUBLIC_DIRECTORY --output bundle.json
```

The utility reads owner-specified local inputs and never uploads or copies them
into the source repository. It reports parsing separately, first-frame and warm
geometry time, the geometry-output hash, RSS/heap and process peak RSS. Geometry
timing excludes Canvas/WebGL drawing, GPU completion and display scheduling; it
is not an end-to-end FPS measurement. Cache construction remains cold-start work.

## Requests and playback delivery

The standalone service caches one current model generation, shared read-only
with playback to avoid a second resident geometry copy, keyed by file
identity/size and nanosecond modification/change timestamps. Concurrent loads
share preparation. `/api/rig` and `/api/context` cache derived responses and
negotiate asynchronous gzip or brotli compression; clients can revalidate ETags
to receive 304 with no body. `includeAssets` and `packed` have distinct response
identities, and `Vary: Accept-Encoding` is set. Context's model-dependent audit,
physics checks and full revision hash are computed once per generation; current
journal metadata is overlaid separately. External file replacement invalidates
the generation. This cache is private to these read paths, not a global mutable
RigDocument cache.

Player model loading uses one active load, retains only the latest requested
session/model version and retries failures with capped exponential backoff and
jitter (500ms initial, 30s cap). Superseded/disposed loads cannot install.
`fetchRigDocument` also coalesces in-flight fetches and permits HTTP revalidation.
API failures do not automatically trigger a second full static-file download;
the static fallback is reserved for an unavailable/unsupported API.

New browser clients opt into `/api/playback/events?delta=1`. Connection/reload
starts with a full snapshot and parameter catalogue; subsequent packets carry
changed fields and parameter values. Per-connection sequences detect gaps and
trigger a new full subscription. Backpressure skips unsent frames without
advancing that connection's baseline; drain sends a catch-up delta. The original
full-snapshot SSE protocol remains available without this query parameter; new
clients also accept legacy snapshots from an older running backend.
The model's parameter catalogue is prepared on model load, rather than rebuilt
for each broadcast. Content-addressed PNG URLs use immutable browser caching;
other static files support ETag revalidation.

Reads bypass the write queue. Only audited read-only POST routes bypass it;
mutation requests remain ordered. Disconnected requests are skipped before
queued dispatch. Active standalone QA is cancellable on disconnect. Atomic
model replacement and CAS checks are retained. Compressed POST bodies accept
gzip/br with separate wire and expanded byte accounting. Browser import requests
use native gzip when available and large enough, with ordinary JSON fallback.
Motion has a separate 16 MiB route limit; other playback commands retain 1 MiB.
Existing motion key-count/range/curve validation is unchanged; no key thinning
is performed.

## QA resources and jobs

Standalone `/api/qa/check` and transaction QA run in worker threads. Each QA
request uses one immutable temporary snapshot, loaded once per worker, then
partitions pose groups. Worker count is bounded by available CPU (reserving a
core where possible), available memory, estimated expanded model/visible-texture
memory, task count and configuration. Auto mode caps at eight workers and gives
large snapshots at least four poses per worker to amortize startup/texture
decoding. One worker still keeps rendering off the service event loop. If the
budget cannot fit one worker, QA reports an insufficient-budget error instead
of ignoring the limit. A per-process admission queue loads one request at a time.
Worker memory planning now uses twice the original estimate, calibrated against
the reported ~0.97 GiB estimate versus ~1.7 GiB measured per worker. This leaves
headroom for renderer scratch buffers and V8 heap growth; the old estimate must
not be interpreted as a reliable peak-RSS limit.

Updated services on the same machine/user share memory reservations across
ports and data directories. A short-lived exclusive loopback TCP listener
(a stable per-user/host port in 27000–28999) serializes lease metadata changes;
the OS releases this mutex on process death. Lease files live beneath
LOCALAPPDATA (or the temporary directory), keyed by user/host. Admission budgets
half the current available RAM, subtracts live reservations, and reduces worker
count or waits with `queued-memory` progress. Waiting can be cancelled. Leases
are released after workers stop; dead-process leases are reclaimed, without
expiring a live long-running QA. An occupied coordinator port fails clearly
after ten seconds; it never silently disables coordination. Services running
older code do not participate: update/restart every concurrent service.
This is conservative admission planning, not an OS-enforced RSS cap. Service
parents, other applications and unupdated services can still consume memory.

Use `--qa-workers 1` for serial worker execution, `--qa-workers N` for a requested
upper bound, and `--qa-memory-mib N` for a memory-budget ceiling. CPU/memory caps
still apply to explicit worker counts. The same CLI works across supported PCs;
there is no fixed 24-core assumption. Worker errors fail QA; they never waive
validation. Aborts terminate active workers and remove temporary snapshots.
Results retain serial ordering, custom neutral poses and deterministic physics.
Repeated checks cache detached numeric results using a SHA-256 key including
model, request, public directory and external-asset timestamps, bounded to
24 entries / 32 MiB. Asset changes during a run reject that result.

`POST /api/modeling/jobs` accepts a transaction and returns 202 plus `Location`.
`GET /api/modeling/jobs/{id}` returns progress and the terminal transaction result;
`DELETE` cancels queued work or QA. Once `committing` begins, cancellation returns
409. HTTP disconnect after acceptance does not cancel a job. Writes share the
same ordered queue as synchronous transactions, and perform CAS again before
atomic replacement. Job admission allows three active/queued jobs, retains up
to 32 terminal records and expires older terminal records during submission.
An optional `Idempotency-Key` reuses a job on this service instance and rejects
the same key with a different body. Job state is in memory: after restart or an
unknown acceptance outcome, inspect the stored revision before resubmission.
The UI polls progress with retry backoff and exposes cancellation. Existing
synchronous transaction routes remain supported; older services use that path
with ordinary uncompressed JSON requests.

## Offset format and checkpoints

Dense saves/exports (at least 4096 offsets) use
`{format:"standrig-packed",version:1,rig:...}`. New readers also accept old plain
RigDocument JSON. The DTO replaces each eligible `offsets` field with
`packedOffsets:{version:1,encoding,vertexCount,order,indices?,data}`. Scalars are
little-endian x/y pairs in base64; dense keys omit indices, while sparse or
reordered keys retain integer vertex indices. The mesh's ordered-ID fingerprint,
vertex count, indices, finite numbers and exact byte lengths are validated.
Field order is preserved on decode so logical JSON revisions survive round trips.
Duplicate/unknown vertex offsets and unknown per-offset metadata stay in their
original representation. A reserved legacy `packedOffsets` property disables
packing rather than discarding user data. Decoding is bounded to 8 million
packed offsets; larger legacy documents remain unmodified by the packer.

Default `lossless` chooses i16 at 1/32px only when every scalar is already exactly
representable, otherwise exact Float32 or Float64. No rounding is introduced by
default. The `packRigDocument` utility also offers explicit lossy `f32` / `i16`
modes. i16 uses nearest rounding, with at most 1/64px error per scalar, and falls
back to Float64 on range overflow. Float32 overflow also falls back. Lossy modes
require fresh numeric/visual qualification before adoption; the UI does not
silently opt into them. Legacy clients can keep requesting ordinary `/api/rig`
JSON; `packed=1` is an explicit opt-in. Preview transfer defaults to ordinary
JSON plus HTTP compression: base64 Float64 data can compress worse than decimal
JSON, despite a smaller uncompressed file. Qualify both wire sizes before
choosing a representation. New packed files require an updated reader. A
complete streaming/binary container remains future work.

The embedded-image `.srig` download retains the `standrig-bundle` v1 envelope,
including name, export time and optional tracking profile; its `rig` field may
contain the packed DTO. Preview, core bundle import and the updated Connect
reader accept this nested form. Update direct-file scripts and restart old
services before sharing packed saved files. Original artwork coordinates are
not rounded automatically; an explicit Float32/Int16 conversion still needs QA,
especially on small eye triangles.

## Windows playback cadence

Demo, motion and expression transitions use monotonic deadlines instead of
repeating 33ms intervals. Each callback schedules against elapsed time, skips
missed frames without catch-up bursts, and retains stop/unref behavior. This
avoids accumulating Windows coarse-timer rounding while keeping the 30Hz target.
The 15s SSE heartbeat is unchanged. Synthetic coarse-clock tests cover drift,
late work and cancellation. On this Windows PC a three-second local sample
changed from 64 interval callbacks (~21.24Hz) to 90 PlaybackSession SSE frames
(~29.96Hz). This measures service cadence, not browser rendering FPS or large
model throughput. Evidence is saved in the local performance follow-up report.

Import/restore prepares content-addressed PNG references in memory for both
dry-run and commit. New image files are persisted only after validation, QA and
CAS gates pass, before atomically replacing the model. The asset manifest merges
existing entries. PNG bytes and local-path confinement are checked; immutable
image objects are never overwritten. Owned HTTP imports avoid a redundant model
clone, while ordinary application callers retain the cloning boundary. An
unchanged on-disk stamp avoids reparsing/rehashing the current model at commit;
an external change triggers a full revision comparison.

New checkpoints store PNGs once by SHA-256 and gzip the model separately,
choosing the smaller compressed result of plain and packed lossless JSON.
Identical compressed model bodies also share one SHA-256 object; separate
checkpoint metadata retains their individual IDs and timestamps.
Metadata is published atomically only after objects and model are present;
restores verify hashes and decompression limits. Old self-contained checkpoints
remain readable and are not automatically pruned. New history defaults to ten
checkpoints and a 256 MiB shared-storage budget, configurable with
`--checkpoint-limit N` / `--checkpoint-mib N`. The newest complete checkpoint is
always retained even if it alone exceeds the budget. Garbage collection removes
only PNG objects unreferenced by retained new checkpoints, after metadata is
retired. Restore preparation is read-only; missing former external textures are
recovered from checkpoint bytes at the commit boundary.
