# StandRig

[日本語](README.md) | [English](README.en.md)

**A 2D modeling core that AI can edit, with an embeddable playback runtime.**

Import a PSD with separate artwork layers, edit meshes, deformers and keyforms through an MCP-compatible AI client, and drive the model with numeric parameters. A browser UI is included for PSD import and visual checks. This is an early developer release, **0.2.0**.

![StandRig displaying a character imported from a parts-separated PSD](docs/images/character-preview.jpg)

This is an actual screenshot of an imported character PSD. The character's PSD and model are not included. The “Try sample” button loads a geometric model. The screenshot uses test port 5196; the default service port is 5180. See the [screenshot artwork notice](docs/images/NOTICE.md).

## Features and scope

**This repository contains StandRig itself. Connect and Cubism API Bridge are separate applications, installed only when needed.**

### StandRig: modeling and browser playback

| Feature | Included in StandRig |
| --- | --- |
| Artwork import | Image layers, positions, hierarchy and other supported properties from a parts-separated PSD |
| Modeling | Edit, dry-run, run numeric QA, commit and restore through MCP / HTTP APIs. AI operation requires a separate MCP-compatible client |
| AI deformation | Six deterministic Brush effects and Blend Shapes beyond ArtMesh ([API and limits](docs/DEFORM.md)) |
| Playback | Transparent player page, sliders and numeric parameter input, motion JSON playback and an embeddable browser runtime |
| Export | Model JSON and model JSON with embedded images; use embedded images for Connect |
| External input | APIs accepting numeric values produced by other tools; no camera tracking included |
| OBS player page | A page usable as a Browser Source in a separately running OBS installation; no OBS control or Spout2 sender included |

**Importing a PSD does not automatically create a finished rig or its movements.** Ask your AI client to create the required settings, then inspect the actual result. Automatic part separation, AI models and image generation services are not provided.

#

### StandRig Connect: camera tracking and native streaming (separate app)

| Feature | Provided by Connect |
| --- | --- |
| Camera tracking | Head, eyelids, gaze and mouth tracking, adjustment and calibration. Body motion is inferred from the face |
| Standalone Windows playback | Load embedded-image model JSON and render without running StandRig or a browser |
| Motion and idle | StandRig motion playback, breathing, sway and smooth random micro-movement |
| External parameter API | Local HTTP discovery, temporary overrides and clear; call Connect directly without running StandRig |
| Model slots | Save a model copy and tracking settings inside the app |
| OBS output | Output window for Game Capture / Window Capture and optional Spout2 sending. OBS is a separate installation |

### Cubism API Bridge: Cubism Editor integration (separate app)

| Feature | Available through the Bridge connection |
| --- | --- |
| Requirements | A separately running Cubism API Bridge, a compatible Cubism Editor and connection permission |
| Reads from StandRig | Retrieve Cubism Editor model, parameter, part, deformer and physics information |
| Temporary operations from StandRig | Set and clear transient Cubism parameter values |
| Independent Bridge API | The Bridge also exposes its own HTTP / Python API; its scope differs from StandRig's adapter |

StandRig's Bridge adapter does not provide persistent editing, automatic synchronization or model conversion. StandRig itself does not create, convert or play cmo3/moc3 files. See [Bridge scope and setup](docs/CUBISM-BRIDGE.md).

## Quick start

You need **Node.js 22.x starting at 22.12, or Node.js 24 or later**, and a browser. The locally tested environment is Windows with Node.js 24. Initial dependency installation requires an internet connection. Viewing the sample and using the sliders do not require an AI subscription or MCP connection.

The browser UI currently uses Japanese labels. The steps below include the exact labels and their English meanings. Some linked guides are also in Japanese.

### 1. Get the files

Clone this repository with GitHub Desktop, or choose **Code → Download ZIP** and extract it. You can also use a source ZIP if one is published under Releases.

Open the folder containing `README.md`, `package.json` and `start-modeling-tools.cmd`. Extract the ZIP before running anything inside it.

### 2. Start the service

**Windows:** With a supported Node.js version already installed, double-click `start-modeling-tools.cmd`. It installs npm dependencies on first use, builds the project and starts the service. Keep the command window open while using StandRig. This launcher does not install Node.js.

**From a terminal:** Change to the repository folder and run:

```sh
npm ci
npm run build
npm start
```

When you see `StandRig local service: http://127.0.0.1:5180`, open **http://127.0.0.1:5180/** in your browser. The browser does not open automatically.

### 3. Try the sample

1. Click **「サンプルを試す」 (Try sample)**. The current model is saved to a checkpoint before it is replaced.
2. Click **「再生画面を開く」 (Open player)**.
3. Scroll down in the original page and move sliders such as **Angle Z** (`ParamAngleZ`, head tilt) and **Mouth** (`ParamMouthOpen`, mouth opening). Check that the player page reflects the changes.

The sample is a geometric model. Parameters without bindings will not produce movement. **「再生」 (Play)** advances time and physics, and plays the loaded motion when present. It does not start camera tracking.

### 4. Try a motion demo

Choose a mode under **「動作デモ」 (Motion demo)** above the preview, then click **「デモを開始」 (Start demo)**.

- **Showcase — Fast & Wide:** Automatically exercises head, body, gaze and expressions.
- **Mouse + Expressions:** Head, body and gaze follow your pointer within the preview, with automatic blinks, winks and mouth opening. Moving the pointer outside the preview returns it to the center.

Both modes appear in the preview and the player page. **「デモを停止」 (Stop demo)** restores the starting pose and playback state. Sliders, external parameter input, Play/Pause/Reset and model changes also end the demo. The saved model is unchanged. Demos run in the service, so closing a browser tab alone does not stop them.

Only parts with authored bindings move. The sample demonstrates basic movements such as head tilt and mouth opening, not every expression. A demo does not automatically rig an imported PSD or replace maximum-pose quality checks.

## Import your PSD

1. Click **「PSDを選択」 (Select PSD)**, choose one file, then click **「PSDを読み込む」 (Import PSD)**.
2. Check the positions, stacking order, colors and visibility against your intended artwork.
3. Connect your AI client and describe the parts you want to move and their intended ranges.

Input is **PSD only**, with at least two image layers containing artwork. Direct PNG import, flattened or single-layer PSDs, PSB files and automatic part separation are unsupported. Layer count alone cannot establish whether artwork is separated appropriately. Not all Photoshop features are reproduced. See the [PSD input guide](docs/PSD.md).

## Connect an AI client

Use a separate AI client that supports stdio MCP. AI subscriptions, fees and tool execution settings are managed by that client. Keep the StandRig service running.

For clients that accept the `mcpServers` format, add the following configuration. Replace `args` with the **absolute path** to your copy of StandRig.

```json
{
  "mcpServers": {
    "standrig": {
      "command": "node",
      "args": ["C:/path/to/StandRig/packages/mcp/src/cli.mjs"],
      "env": { "STANDRIG_URL": "http://127.0.0.1:5180" }
    }
  }
}
```

Configuration locations and formats vary by client. See the [MCP setup guide](docs/MCP.md) for connection checks.

Example first prompt:

> Read StandRig's MCP resources standrig://docs/contract and standrig://docs/guide. Use standrig_context to inspect the current model and explain its parts and configured movements. Do not modify the model yet.

Example modeling request:

> Start by setting up eye opening and closing for this PSD. Inspect the existing part IDs and structure. Follow the modeling contract to prepare the required reference images and manifest before editing, then proceed through dry-run, numeric QA, commit and actual visual inspection. If you cannot prepare the references with your available tools, explain what materials are needed.

MCP alone cannot paint new reference images or save arbitrary files. Use the AI client's file and image tools, or materials supplied by the operator. Passing numeric QA does not establish visual completion. See the [AI operating guide](AI_OPERATING_GUIDE.md) and [modeling contract](AGENTS.md).

## Play a motion file

Load the sample model, choose `examples/sample.standrig-motion.json` using **「モーションJSONを選択」**, then click **「モーション再生」**. The UI supports pause, stop, seek, speed, loop and JSON export. AI clients use `standrig_motion`.

Only native StandRig motion JSON is supported today. Live2D `.motion3.json` import is **not implemented**. A separate importer interface allows a future converter to use the same playback engine. See [motion format and API](docs/MOTION.md).

## Save, restore and share models

- Imports and committed edits are saved on the server. Slider values and playback state are transient and do not edit the model.
- The default data directory is **`workspace/`**: the model is stored in `workspace/public/rig.json`, recovery checkpoints in `workspace/checkpoints/`, and exported bundles in `workspace/exports/`.
- The service creates a checkpoint after validation passes and immediately before saving PSD/sample imports, HTTP/MCP edits and restores. List checkpoints with `standrig_checkpoint`, then call `standrig_restore` with the checkpoint ID and current revision.
- **「モデルJSONを書き出す」 (Export model JSON)** exports JSON alone. To include images, use `standrig_export` with the **bundle** format. See the [API guide's bundle reimport instructions](docs/API.md#bundleの再読み込み).
- Back up the original PSD and reference images separately. `workspace/` is excluded from Git and distribution ZIPs, so pushing the repository does not back up your model data.

To use a separate data directory for another model:

```sh
npm start -- --data-dir "C:/Models/My Character"
```

Do not run multiple services against the same data directory. Stop the service with **Ctrl+C** in its command window. Use the launcher or `npm start` to restart it. After updating the source, rerun `npm ci` and `npm run build`.

### Export a model with embedded images

Click **「画像込みモデルJSONを書き出す」 (Export model JSON with embedded images)** to combine the saved model and part images into one file for Connect or another environment. This does not include the original PSD or external application tracking settings. The ordinary JSON export can retain external image references; use the embedded-image export when moving the model to another app.

### Import a model JSON

Under the import panel, choose a model JSON and press the model import button. Plain rig.json, image-embedded model JSON and StandRig bundles are supported. External image references must resolve in this StandRig instance; use an image-embedded export when moving between machines. The transaction validates the model and assets, then checkpoints the current model before replacing it. Tracking settings from bundles are not imported.

## External application integrations

The following setup is optional and requires separate applications.

### StandRig Connect: tracking and streaming

[**StandRig Connect**](https://github.com/sayaka-aiart/standrig-connect) is a separate Windows app that animates StandRig models with a camera and sends output to OBS. It is available as a **0.1.0 development preview source release**. Build it from source using the instructions and face inference setup in the [Connect README](https://github.com/sayaka-aiart/standrig-connect/blob/main/README.en.md).

- Head, eyelid, gaze and mouth tracking, adjustment and neutral calibration.
- Local slots containing a model copy and tracking settings.
- StandRig motion playback and breathing, sway and smooth random idle presets.
- OBS Game Capture / Window Capture and optional Spout2 output.

After modeling and checking the movement in StandRig, click **「画像込みモデルJSONを書き出す」 (Export model JSON with embedded images)** and open that JSON in Connect's Model tab. This single file includes the artwork, so StandRig, a browser and the original PSD are not needed during Connect playback. Use the embedded-image export, rather than the ordinary JSON export that omits image data.

Processing continues while Connect's control window is minimized or in the system tray. Keep the output window visible for OBS Game Capture / Window Capture. Spout2 allows it to be hidden, but requires a Spout-enabled build and a separately installed OBS receiver plugin. Body motion is inferred from the face, not full-body tracking.

Connect exposes its external parameter API at `http://127.0.0.1:22036`: discover parameter IDs and ranges, temporarily override values, and clear selected or all overrides. AI scripts and other tools can call it directly without running StandRig. Credentials are stored in `%LOCALAPPDATA%\StandRigConnect\api-session.json`; Connect's API tab shows the location. Never share or commit this file.

Overrides affect only supplied parameters and expire after one second by default (configurable from 100 to 10000ms), restoring ordinary input. Renew before expiry for continuous control. Retrieve a new model session ID after switching models. Stream Deck integration can use scripts or actions supporting HTTP calls; a dedicated plugin and expression-switching API are not implemented.

Connect is optional; StandRig's browser playback and external numeric input remain available.

### Connect to Cubism API Bridge

The separate [Cubism API Bridge](https://github.com/sayaka-aiart/cubism-api-bridge) lets StandRig MCP read Cubism Editor information and set transient poses/expressions. The Bridge runs as a separate process; no Cubism SDK is added to the StandRig core.

1. Build the Bridge and permit its connection in Cubism, following its README.
2. Start HTTP from the Bridge directory:

```powershell
npm run http -- --port 22035 --session-file "$env:LOCALAPPDATA\StandRigCubismBridge\http-session.json"
```

3. In another terminal, start the built StandRig from its own directory:

```powershell
npm start -- --bridge-session-file "$env:LOCALAPPDATA\StandRigCubismBridge\http-session.json"
```

Use the UI's **Cubism Bridge** button to check status, or MCP tools `standrig_bridge_status`, `standrig_bridge_read`, and `standrig_bridge_pose`. Credentials stay in the service; never share or commit the session file. Restart StandRig after restarting the Bridge to reload its new credentials.

The connection requires an idle Bridge with API 1.1.0. Persistent Cubism editing through StandRig, automatic synchronization, model conversion and motion import are not implemented. See the [connection guide and API examples](docs/CUBISM-BRIDGE.md).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `node` / `npm` not found | Install a supported Node.js version, then reopen your terminal or AI client |
| PowerShell blocks `npm.ps1` | Use `npm.cmd ci` and other `.cmd` commands, or use the Windows launcher |
| Page does not open / `fetch failed` | Check that the service is running and the URL and port match |
| `EADDRINUSE` | Check for an already-running service. To use another port, run `npm start -- --port 5182` and update both browser and MCP URLs to port 5182 |
| MCP cannot find `node` | Set `command` to the absolute path of the Node executable |
| Protocol error immediately after MCP connection | Use `node` with `cli.mjs` as shown above, rather than `npm run mcp` |
| PSD is visible but does not move | Check the parameter bindings; PSD import alone does not create a finished rig |
| `empty-image` | Import a PSD or load the sample; an empty model fails QA |
| `revision mismatch` | Fetch the latest context, review your intended changes and retry the dry-run |

## Development

```text
packages/core/       Model types, modeling, evaluation and QA
packages/runtime/    Browser playback and external input contracts
packages/mcp/        Stdio MCP server for AI tools
apps/service/        Local API, persistence, recovery and playback state
apps/preview/        PSD import, pose inspection and transparent player
examples/            Synthetic sample model and integration examples
```

`core` and `runtime` can be used without MCP. The packages are not published to npm; develop with the npm workspaces in this source tree. See the [architecture](docs/ARCHITECTURE.md), [adapters and embedding](docs/ADAPTERS.md), [API guide](docs/API.md) and [operation reference](docs/OPERATIONS.md).

```sh
npm run build
npm test
```

For UI development, keep the service running on port 5180, run `npm run dev` in another terminal, and open http://127.0.0.1:5181/. Normal startup uses a standalone Node.js service, independent of Vite.

Use `npm run verify` to check the distribution's file hashes. Source edits will cause mismatches, so this is separate from normal development tests. See [release instructions](docs/RELEASING.md) for packaging and verification, and [validation notes](docs/VALIDATION.md) for tested behavior and remaining limits.

Legacy write APIs are disabled by default. Import, editing and restore use the transaction service, SHA-256 revisions and shared strict HTTP/MCP schemas. See the [API reference](docs/API.md) for migration.

## License

Original code, documentation text and synthetic samples are licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) and the [third-party notices](THIRD_PARTY_NOTICES.md). This repository's license does not apply to imported PSDs, character artwork, or the character shown in the screenshot. See the [screenshot artwork notice](docs/images/NOTICE.md).
