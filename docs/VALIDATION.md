# Validation — 0.2.0

Date: 2026-09-09. Local environment: Windows, Node.js 24.14.0. Source dependencies installed with TLS verification enabled, using the OS certificate store in this environment.

## Automated checks

- All workspace TypeScript builds and Vite production preview/player build passed.
- Existing isolated modeling smoke suite: 16 checks passed (empty model, excluded routes, import, model inspection/validation, numeric QA, PNG rendering, dry-run no-write, stale/failed-QA rejection, commit, revisions, external assets, self-contained bundle and path escape rejection).
- Additional Node test suite: 7 tests passed. Covered package boundaries; invalid MCP origins; atomic numeric input validation; real stdio MCP SDK client/server round trip including edit/commit/stale rejection/checkpoint restore/export/resources; SSE and nonpersistent playback values; Host/Origin rejection; multipart PSD preservation; flattened/single/empty-extra-layer rejection; PNG/invalid-header/PSB rejection.
- npm audit reported 0 known vulnerabilities for both runtime-only and complete installed dependency sets at verification time. This is a dependency advisory result, not a full security audit.

## Actual browser checks

The service used a new temporary data directory, not the owner's working character.

- Opened the built UI in the in-app browser.
- Selected a generated single-layer PSD through the real file chooser. Import was rejected with the parts-separated-PSD explanation; the empty model remained active.
- Selected a generated two-layer PSD. UI showed 3 parts / 2 assets; both colored regions were visibly rendered. Numeric QA passed with no failures.
- Loaded the geometric sample and opened the independent player page. Actual renderer output showed the sample bot.
- Used a real stdio MCP client to set `ParamAngleZ:25` and `ParamMouthOpen:0.8`, after numeric QA. The already-open player visibly changed head rotation and mouth opening. The player showed no browser console error during this check.

The PSD parser tests use a small pixel-only canvas adapter; the actual browser file chooser/render checks above are separate evidence. Sample Bot demonstrates parameter bindings, not character modeling quality, realistic head yaw/pitch or an animation-ready avatar.

## Limits

No production character model, maximum-pose visual freeze, webcam mapping, OBS capture, Cubism SDK/Editor bridge or Linux execution was tested. GitHub CI configuration is included but has not run remotely. The transparent player is prepared as an external output; successful OBS capture is not inferred from a browser screenshot or SSE connection.

The source release must be extracted into a fresh directory and validated before publication. A local verification record is kept beside the source ZIP under `releases/`; personal workspace data and test screenshots are excluded from the public source archive.
