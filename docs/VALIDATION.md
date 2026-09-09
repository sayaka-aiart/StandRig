# Validation — 0.2.0

Date: 2026-09-09. Local environment: Windows, Node.js 24.14.0. Source dependencies installed with TLS verification enabled, using the OS certificate store in this environment.

## Automated checks

- All workspace TypeScript builds and Vite production preview/player build passed.
- Existing isolated modeling smoke suite: 16 checks passed (empty model, excluded routes, import, model inspection/validation, numeric QA, PNG rendering, dry-run no-write, stale/failed-QA rejection, commit, revisions, external assets, self-contained bundle and path escape rejection).
- Additional Node test suite: 10 tests passed. Covered package boundaries; invalid MCP origins; atomic numeric input validation; real stdio MCP SDK client/server round trip including edit/commit/stale rejection/checkpoint restore/export and six resources; SSE and nonpersistent playback values; Host/Origin rejection; layered PSD preservation; flattened/single/empty-extra-layer rejection; PNG/invalid-header/PSB rejection. Review regressions cover custom-pose failure images, rejection of misspelled QA poses/regions and duplicate sample labels, and distinct playback session IDs after restart.
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

The character PSD import and static view below were tested; production character deformation, maximum-pose visual freeze, webcam mapping, OBS capture, Cubism SDK/Editor bridge and Linux execution remain untested in this distribution. GitHub CI configuration is included but has not run remotely. The transparent player is prepared as an external output; successful OBS capture is not inferred from a browser screenshot or SSE connection.

The source release must be extracted into a fresh directory and validated before publication. A local verification record is kept beside the source ZIP under `releases/`; personal workspace data and diagnostic screenshots are excluded. The authorized README screenshot is included under the artwork notice in `docs/images/NOTICE.md`; the editable PSD/model and its textures are excluded.

## Character screenshot update (2026-09-09)

The user authorized using the PSD associated with the normal modeling environment for the README image. The source PSD was selected through the public distribution's real browser file chooser and imported into a separate gitignored data directory. Import produced 140 parts / 118 assets, matching the PSD's layer structure. Neutral/full numeric QA passed (240px, physics off); the actual browser view showed the complete character. No modeling/deformation transaction was performed, and the normal environment's active rig was not edited.

`docs/images/character-preview.jpg` shows this static import. It is not a claim that the PSD is automatically rigged, nor that the existing production rig's movements have been reproduced. The screenshot is a display example; the bundled runnable sample remains the geometric Sample Bot.
