# Validation — 0.2.0

Date: 2026-09-09. Local environment: Windows, Node.js 24.14.0. Source dependencies installed with TLS verification enabled, using the OS certificate store in this environment.

## Automated checks

- All workspace TypeScript builds and Vite production preview/player build passed.
- Existing isolated modeling smoke suite: 16 checks passed (empty model, excluded routes, import, model inspection/validation, numeric QA, PNG rendering, dry-run no-write, stale/failed-QA rejection, commit, revisions, external assets, self-contained bundle and path escape rejection).
- Additional Node test suite: 13 tests passed. Covered package boundaries; invalid MCP origins; atomic numeric input validation; real stdio MCP SDK client/server round trip including edit/commit/stale rejection/checkpoint restore/export and six resources; SSE and nonpersistent playback values; Host/Origin rejection; layered PSD preservation; flattened/single/empty-extra-layer rejection; PNG/invalid-header/PSB rejection. Review regressions cover custom-pose failure images, rejection of misspelled QA poses/regions and duplicate sample labels, and distinct playback session IDs after restart.
- npm audit reported 0 known vulnerabilities for both runtime-only and complete installed dependency sets at verification time. This is a dependency advisory result, not a full security audit.

## Actual browser checks

The initial extraction checks below were recorded before this documentation review. PSD parsing was not changed in the review; its automated fixtures were rerun. The new browser checks are listed separately afterward.

The service used a new temporary data directory, not the owner's working character.

- Opened the built UI in the in-app browser.
- Selected a generated single-layer PSD through the real file chooser. Import was rejected with the parts-separated-PSD explanation; the empty model remained active.
- Selected a generated two-layer PSD. UI showed 3 parts / 2 assets; both colored regions were visibly rendered. Numeric QA passed with no failures.
- Loaded the geometric sample and opened the independent player page. Actual renderer output showed the sample bot.
- Used a real stdio MCP client to set `ParamAngleZ:25` and `ParamMouthOpen:0.8`, after numeric QA. The already-open player visibly changed head rotation and mouth opening. The player showed no browser console error during this check.

The PSD parser tests use a small pixel-only canvas adapter; the actual browser file chooser/render checks above are separate evidence. Sample Bot demonstrates parameter bindings, not character modeling quality, realistic head yaw/pitch or an animation-ready avatar.

## Publication review checks (2026-09-09)

- Followed the revised sample workflow in the built browser UI using an isolated synthetic data directory. Sample import and numeric QA succeeded; the Angle Z slider reached 25.
- Ran `examples/mcp-demo.mjs` against the service: context, QA, parameter input and play succeeded. The independent player visibly showed the rotated head and open mouth.
- Kept preview and player tabs open across service restarts. With modelVersion equal to zero both before and after the final restart, changed the isolated fixture's name and body width while the service was stopped. Both tabs picked up the replacement model automatically, with no browser reload. The player visibly showed the narrower body. Session IDs differed.
- Initially saved a geometric sample screenshot for the README; it has since been replaced by the authorized character PSD import screenshot described below. Diagnostic restart screenshots and state records remain in gitignored `reports/`.
- Reviewed README, AI contract/guide, MCP/API/PSD/adapter documentation, release instructions, generated schemas, examples, package entry points and CI against the implementation. This is a publication-readiness review of those paths, not a formal audit of every numerical algorithm.

## Limits

The character PSD import and static view below were tested; production character deformation, maximum-pose visual freeze, webcam mapping, OBS capture, Cubism SDK/Editor bridge remain outside the local visual checks. Linux/Windows build and test execution subsequently passed in GitHub CI for the published write-boundary and registry commits. The transparent player is prepared as an external output; successful OBS capture is not inferred from a browser screenshot or SSE connection.

The source release must be extracted into a fresh directory and validated before publication. A local verification record is kept beside the source ZIP under `releases/`; personal workspace data and diagnostic screenshots are excluded. The authorized README screenshot is included under the artwork notice in `docs/images/NOTICE.md`; the editable PSD/model and its textures are excluded.

## Character screenshot update (2026-09-09)

The user authorized using the PSD associated with the normal modeling environment for the README image. The source PSD was selected through the public distribution's real browser file chooser and imported into a separate gitignored data directory. Import produced 140 parts / 118 assets, matching the PSD's layer structure. Neutral/full numeric QA passed (240px, physics off); the actual browser view showed the complete character. No modeling/deformation transaction was performed, and the normal environment's active rig was not edited.

`docs/images/character-preview.jpg` shows this static import. It is not a claim that the PSD is automatically rigged, nor that the existing production rig's movements have been reproduced. The screenshot is a display example; the bundled runnable sample remains the geometric Sample Bot.

## Motion demo update (2026-09-09)

Ported Showcase Fast & Wide and Mouse + Expressions from the original application. Numeric parity with the original source passed for both modes over 40 seconds at three pointer positions. Added tests cover model range clamping, automatic expression timing, transient state, restoration, valid/invalid manual takeover, model reload/shutdown cleanup and disabled/unrigged/custom-only models. Real stdio MCP tests exercise demo start, pointer input and stop without changing the saved rig.

In the built browser UI, Sample Bot showed changing head tilt during Showcase and opposite tilt with actual pointer positions on either side of the preview. The independent player displayed the same driven pose. The Stop button returned the UI to its starting state; no browser console warnings/errors were reported during that check. Sample Bot does not bind every facial expression; expression timing was verified numerically. Full production-character appearance, maximum-pose freeze and OBS capture remain outside this check.

## Write-boundary review — 2026-09-10

Windows / Node 24.14.0: workspace build, 16 smoke checks and 18 Node tests passed. New regressions verify default rejection of every inventoried legacy write method without filesystem changes; missing revision/QA and unknown action keys; import and dry-run isolation; concurrent same-revision commits (one success, one 409); failed-QA no-write; checkpoint restore and empty restore; per-service journal isolation; SHA-256 full-document revisions; and all 33 strict action variants, required fields and nested unknown-key rejection. The real stdio MCP test also inspects the advertised 33 strict action schemas. Schema generation freshness is checked by npm test.

Actual built-browser checks used an isolated data directory: sample import succeeded, numeric QA passed, Showcase displayed the bot; a generated two-layer PSD imported through the real file chooser and transaction service, rendered both colored layers, passed QA and stopped the previous demo. No browser console errors were observed. These fixtures do not establish character modeling quality or Model Freeze.

Legacy asset/golden/generation persistence stays disabled by default, including their legacy dry-run POST variants. Explicit compatibility opt-in remains outside transaction guarantees. One service process must own each data directory. Reference-manifest checks and visual acceptance remain operator duties.

## Discriminated action registry — 2026-09-10

The 33 action definitions now live in one typed registry; named TypeScript aliases and Zod schemas are generated, and the envelope uses a type-discriminated union. OpenAPI and MCP expose oneOf branches. All workspace builds, 16 smoke checks and 19 Node tests passed. Tests cover all strict variants and advertised registry keys, direct action.columns error paths, unknown discriminators and real stdio MCP rejection of four malformed payloads before any HTTP transaction request. Generation freshness checks cover both runtime schemas and TypeScript declarations. No renderer, artwork or operation behavior changed in this follow-up; the prior browser check remains the visual evidence.


## AI Brush and extended Blend Shapes — 2026-09-10

Windows / Node 24.14.0: all workspace builds, 16 smoke checks and 33 Node tests passed. New regressions cover negative weights, transform composition, Warp pins/shared fields, ArtPath style/points, fractional Glue stitches, six Brush effects, fixed boundaries and protected points, deterministic displacement caps, triangle inversion rejection, additive shape/keyform output, invalid owner references, atomic multi-target failure, duplicate selectors and disabled pins. Strict action and document Blend Shape schemas are generated from core types. MCP now advertises 35 action variants and seven documentation resources.

The real stdio MCP test creates a Part shape and ArtMesh Brush shape in a QA-gated transaction, checks dry-run isolation, persists and exports both shapes, then restores the original revision. It samples neutral, half and full parameter values. Unit tests cover the other extended shape channels; they do not constitute a visual check of every channel.

An isolated geometric Sample Bot fixture passed numeric QA at weights 0, 0.5 and 1 before browser inspection. In the built independent player, weight 0 showed the starting body; weight 1 visibly combined ArtMesh bend with Part rotation and scale. Saved screenshots and QA records are under gitignored reports/deform-visual/. Fine mesh triangle-edge raster lines were visible in the sample at both poses; this check establishes parameter-driven geometry, not finished rendering quality or character Model Freeze. The normal PSD/model was not edited.

In the initial Brush implementation, Warp keyform output and irregular Warp Pin contour-follow were rejected. Warp keyform support was subsequently added below. There is no Brush mouse UI, posed-screen inverse sculpting or shape-delete action. Existing negative-target ArtMesh shapes require appearance review because their reversed weight behavior was corrected. Production-character appearance, combined extremes and adapter compatibility remain separate acceptance work.


## Warp Brush keyform output — 2026-09-10

Both Warp pins and shared-grid control points now accept the Brush keyform destination. Windows / Node 24.14.0: workspace build, 16 smoke checks and 38 Node tests passed. Regressions verify existing/default key preservation, interpolated insertion, repeated edits, negative keys, locked points, invalid/ambiguous/nonadditive channels, atomic multi-owner rejection, shared-field normalization and safe rejection of grid resize with keys. Pin normalization now retains custom interpolation curves; a numerical regression checks the curve's sampled value.

The integration test imports a synthetic Warp fixture through HTTP, dry-runs both destinations, commits through a real stdio MCP client with neutral/intermediate/key QA, verifies persisted pin and shared-point bindings, then restores the original revision through HTTP. Generated schema checks include the shared-field point bindings.

In a separate isolated Sample Bot fixture, numeric QA passed at parameter values 0, 15 and 30 before images. The built browser player visibly changed the body at 30 using both Warp destinations; the 0 pose retained its starting shape. QA and screenshots are saved under gitignored reports/warp-keyform-visual/. This is synthetic runtime evidence, not production character pose acceptance; fine raster triangle-edge lines remain visible as in the preceding fixture.
