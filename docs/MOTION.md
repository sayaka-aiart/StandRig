# Motion files and playback

Native motion v1 is implemented. Live2D `.motion3.json` import is not implemented or bundled. No Cubism SDK is required. This is separate from the planned rig [runtime compatibility policy](RUNTIME_COMPATIBILITY.md); adding motion v1 does not implement that policy.

## Native format

```json
{
  "format": "standrig-motion",
  "version": 1,
  "name": "Head tilt",
  "duration": 2,
  "tracks": [{"parameter": "ParamAngleZ", "keys": [
    {"time": 0, "value": 0},
    {"time": 1, "value": 20},
    {"time": 2, "value": 0}
  ]}]
}
```

Times are seconds. Values are absolute, model-space numeric parameter values. A track only changes its named parameter; a parameter needs authored model bindings to produce visible movement. Read current parameter IDs/ranges before authoring a clip. See [sample](../examples/sample.standrig-motion.json).

Each key optionally describes its outgoing segment: `{"kind":"linear"}` (default), `{"kind":"hold"}`, `{"kind":"inverse-hold"}`, or `{"kind":"bezier","control1":{"time":0.3,"value":0},"control2":{"time":0.7,"value":20}}`. Bezier controls use absolute time/value coordinates; control times must be monotone and inside the segment. Time is inverted before evaluating the cubic value. Hold keeps the starting value until the next key; inverse-hold jumps immediately after the starting key. Exactly at a key, that key's value wins. Outside a track's key range, endpoints are held. The last key cannot have an outgoing segment.

Unknown fields, unknown formats/versions, nonfinite numbers, duplicate tracks and nonincreasing key times are rejected. Duration is >0 and <=3600 seconds; 1..256 tracks, 1..4096 keys per track, <=50000 keys total. Names and parameter IDs are at most 160 characters. Key times must be in [0,duration]. Keys and Bezier control values must fit the loaded model's parameter ranges (conservative control-hull validation, no silent clamping). HTTP accepts at most 1 MiB including the request envelope; the UI also checks file size. JSON structure and numeric bounds are shared by HTTP/MCP; model-dependent and cross-field checks run in core before replacing the current clip.

## HTTP and MCP

POST `/api/playback/motion` or call `standrig_motion` with exactly one of:

| Request | Effect |
| --- | --- |
| `{"action":"load","clip":{...}}` | Validate and replace the native clip; no autoplay |
| `{"action":"play"}` | Start/resume; replay from zero after the end |
| `{"action":"pause"}` | Hold the current pose and pause renderer/physics |
| `{"action":"stop"}` | Restore owned parameters to their pre-motion values; retain clip |
| `{"action":"clear"}` | Stop and unload |
| `{"action":"seek","time":1}` | Sample the requested time, preserving running/paused state except a nonlooping seek to the end stops the transport |
| `{"action":"configure","speed":1.3,"loop":true}` | Update either or both options; speed is 0.1..4 |

Responses contain `playback.motion`: loaded, name, duration, time, running, active, ended, speed, loop and parameterIds. `active` means the clip still owns its channels, including while paused or holding its end pose. Natural nonlooping completion holds the final pose and stops the motion clock; `playback.playing` may stay true so physics continues. Stop releases ownership and resets time. Loop wraps at duration. Loading resets speed to 1 and loop to false.

GET `/api/playback/motion` returns `{ok,clip,playback}`; clip is null when unloaded. The browser can download this native document. `standrig_playback_state` exposes compact motion status without all keys. AI clients load file contents using their own file tools and send parsed JSON, not a server-side path. `/api/playback/events` carries the sampled values and status to the preview and independent `/player` output. Output connection counts are not rendering acknowledgments.

Only one clip plays at a time. Demo and motion are mutually exclusive. Valid motion load/play/pause/seek/stop/clear ends the demo; configuration alone leaves it running. Starting a demo releases motion ownership. Invalid commands do not stop an active demo or replace a valid clip. A valid external parameter patch touching any owned channel stops the whole clip, restores owned starting values, then applies the patch. Disjoint patches coexist. Manual sliders use this same rule. Paused and ended clips keep ownership until stopped or overridden.

Generic play/pause also control a loaded motion. Reset restores model defaults and stops the clip but retains it. Model reload/import/edit unloads it, as do service restart and clear. Motion state never edits or persists into the rig, checkpoint or bundle. Save the JSON separately. Load/seek/stop/clear/reset increment `physicsEpoch`; both browser outputs reset their physics state. Seeking samples parameter curves and resets physics, **not** a deterministic reconstruction of the preceding physics simulation. Closing a browser tab does not stop service playback.

## Embedded player

```ts
import { StandRigPlayer } from '@standrig/runtime';
const player = new StandRigPlayer(canvas, rig);
await player.load();
player.loadMotion(clip); // validates before changing playback
player.configureMotion({speed: 1.3, loop: true});
player.play();
player.pause();
player.seekMotion(1);
console.log(player.motionState);
player.stopMotion();
player.clearMotion();
```

`MotionController` provides the same transport using an injected monotonic millisecond clock for hosts without a browser. `parseMotion`, `sampleMotion`, `importMotionWith` and the motion types are exported from `@standrig/runtime`; `validateMotionParameters` is available from `@standrig/core/motion`. Sampling expects a validated clip. Resetting an embedded player releases motion ownership; its render loop may continue advancing physics.

## Future Live2D adapter boundary

`MotionImporter.convert(source, {parameterMap})` returns `{clip, issues}`. `importMotionWith` clones its inputs, rejects any reported issue, validates the canonical clip and validates its IDs/ranges against the current model. Install adapters as trusted application code; uploaded JSON never selects executable code. Explicit source-to-model parameter mapping belongs in the adapter. Missing mappings, duplicate destinations and unsupported or lossy features must produce issues or rejection. There is no implicit matching or best-effort discard contract.

The [official motion3 specification](https://github.com/Live2D/CubismSpecs/blob/master/FileFormats/motion3.json.md) includes parameter/model/part-opacity curves, four segment kinds, fades and timed user data. Native segment types leave room for a future parameter-curve converter. Model opacity, part opacity, EyeBlink/LipSync effects, fade timing and user-data events currently have no equivalent here and must be rejected by a future adapter until explicitly supported. A converter must also account for loop metadata and any curve not representable under the monotone-time/range rules. This interface is not a claim of Cubism-equivalent evaluation.

No timeline editor, audio synchronization, multi-clip blending, motion3 exporter or model-format converter is included.
