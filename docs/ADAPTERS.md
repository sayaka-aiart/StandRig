# External input and output

## Embedding playback directly

Build the workspace packages first. The packages are not published to npm. Develop inside this repository's npm workspaces (as apps/preview does), or bring both core and runtime into your own workspace and resolve runtime's core dependency locally. `npm install @standrig/runtime` from the public registry is not a supported installation path. In that browser project with a bundler:

```ts
import { StandRigPlayer } from '@standrig/runtime';
import type { RigDocument } from '@standrig/core';

const player = new StandRigPlayer(canvas, rig as RigDocument);
await player.load();
player.play();
player.setParameters({ ParamAngleZ: 15, ParamMouthOpen: 0.7 });
// ... when removing the view:
player.dispose();
```

Give the canvas a nonzero CSS width and height. Embedded texture data URLs work directly; relative asset URLs must resolve in the host page. Export a self-contained bundle to move a model between applications; pass `bundle.rig` to the player. The browser-only player needs neither MCP nor the local service. It does not infer motions for which the model has no bindings.

## External tracking process

The tracker owns camera access, inference, smoothing, axis orientation and mapping to model parameters. Read parameter definitions first. Send already-mapped finite values in range:

```http
POST /api/playback/parameters
Content-Type: application/json

{"source":"my_tracker_session_1","sequence":1,"values":{"ParamAngleZ":15,"ParamMouthOpen":0.7}}
```

`source`: 1–64 ASCII letters, digits, `_` or `-`. `sequence`: monotonically increasing nonnegative safe integer per source/session. On reconnect either continue the sequence or use a new source ID. Up to 64 sources are retained until a model reload. Unknown/out-of-range/nonfinite values reject the entire frame without partially applying it. Parameters omitted from a frame keep their current values. Last accepted input wins per parameter; disconnect does not automatically reset values.

GET `/api/playback` returns the current state. POST `/api/playback/control` with `{"command":"play"}`, `pause` or `reset` controls the player. POST `/api/playback/reload` reloads the working model. State does not persist to disk. GET `/api/playback/events` emits `event: playback` SSE records plus keepalives; slow connections are closed and can reconnect to the latest state. State broadcasts are a local interoperability transport, not a hard real-time guarantee.

Run `node examples/tracker-input.mjs` after loading Sample Bot for a synthetic input demonstration of about 5 seconds plus request latency. This is not webcam tracking. The example resets parameters and pauses playback at the end.

Built-in motion demos use the same transient state transport. Start with `{command:"demo-start",mode:"showcase-active"}` or `mode:"mouse-expression"` on `/api/playback/control`; mouse mode accepts `{command:"demo-pointer",x:0.5,y:-0.5}`. `demo-stop` restores the starting pose and playback state. A valid external parameter frame automatically stops the demo before applying the frame, so tracking input takes over without competing with an ongoing demo timer. See [API.md](API.md) for the complete control contract.

## OBS connection

The independent transparent page is `http://127.0.0.1:5180/player`. An external OBS setup can use that URL as a Browser Source and set the desired output dimensions. The service must remain running. This package does not install an OBS plugin, change scenes, start streaming or control recording.

The page uses a transparent HTML background and transparent canvas rendering. Normal browser screenshots may composite transparency over white; actual transparency/capture in the user's OBS configuration is a separate check. OBS integration has not been device-tested for this release.

## Future Live2D bridge

`BridgeAdapter` reserves an adapter ID, capability discovery and disconnect. No bridge is loaded or advertised as implemented. Add a separate package when a concrete target exists:

- Cubism Editor command bridge: expose editor operations with its own authorization and version checks.
- Cubism playback adapter: implement playback against the applicable runtime SDK.
- Format conversion: independently specify which meshes, bindings and physics can be converted.

Keep SDK credentials, proprietary runtime binaries, tracker model files and the implementation's licensing inside the corresponding external adapter. Do not add these dependencies to the numerical modeling core.
