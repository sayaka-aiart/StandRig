# Expressions and visemes

StandRig stores an optional `facialPresets` catalog inside the rig and portable `.srig`. Existing rigs need no migration and keep their previous behavior. These are parameter presets: registering a pose does not create missing mouth meshes, keyforms or Blend Shapes. Author those deformations through modeling operations first.

The browser's **表情・母音** panel previews saved entries. Open **表情・母音を登録／編集**, choose the parameters and capture their current slider values. Stop the facial preview before capturing, so an applied expression is not baked into another preset. Choose a saved expression to edit its settings, or use **現在の姿勢を使用** to recapture its values. Imported `.exp3.json` values are displayed as deltas/factors/absolute values according to their Blend field. Saving requires a revision-checked modeling transaction with neutral numeric QA and a rollback checkpoint. A catalog change reloads the model and resets transient playback, including the loaded motion. Export the model after registration to carry the catalog with it.

## Persistent catalog

```json
{
  "version": 1,
  "expressions": [{
    "id": "smile",
    "name": "Smile",
    "document": {
      "Type": "Live2D Expression",
      "FadeInTime": 0.2,
      "FadeOutTime": 0.2,
      "Parameters": [{"Id": "ParamMouthSmile", "Value": 0.5, "Blend": "Add"}]
    }
  }],
  "visemes": {
    "mode": "pose",
    "fadeInTime": 0.08,
    "fadeOutTime": 0.08,
    "presets": [
      {"id": "A", "values": {"ParamMouthOpen": 1, "ParamMouthForm": 0}},
      {"id": "I", "values": {"ParamMouthOpen": 0.3, "ParamMouthForm": 0.8}},
      {"id": "Silence", "values": {"ParamMouthOpen": 0, "ParamMouthForm": 0}}
    ]
  }
}
```

The numbers above illustrate the format, not universal vowel shapes. Register the actual shapes appropriate for the model. IDs are `A`, `I`, `U`, `E`, `O`, `Silence`; incomplete banks are allowed, but unregistered IDs cannot be played. All presets in a bank must name the same channels so transitions and silence are unambiguous. `pose` values are absolute model parameter values. `blend-shape` uses authored zero-default parameters with range [0,1]; every preset lists all the bank's channels, with 1/0 or intermediate weights. `Silence` must contain all zeros in that mode. Names such as `ParamA` are a modeling convention, not mandatory Cubism-wide standard IDs.

At most 128 expressions, 256 parameter operations per expression and 64 channels per viseme are accepted. Fade durations are seconds in [0,60]. IDs/names are nonempty strings up to 160 characters. Unknown fields, duplicate IDs/channels, nonfinite values and unknown parameter references are rejected. Overwrite and viseme values must be in the model range; Add values are deltas and Multiply values are factors, so their numbers need not be in the parameter range. Final composed output is clamped to the model's declared range.

Author the entire catalog with an operation such as:

```json
{"id":"register-faces","name":"Register facial presets","target":{},"action":{"type":"facial-presets-set","presets":{"version":1,"expressions":[]}}}
```

Place it inside `/api/modeling/transaction` with `expectedRevision`, explicit QA and `commit:false` first. `presets:null` removes the catalog. The operation replaces the whole catalog; read the existing catalog first to preserve other entries. HTTP and MCP share the generated strict action schema. `validateRig` also validates imported catalogs.

## Live2D expression interchange

The expression payload follows the public [Cubism exp3 format](https://github.com/Live2D/CubismSpecs/blob/master/FileFormats/exp3.json.md): `Type`, optional `Version:3`, optional `FadeInTime`/`FadeOutTime`, and `Parameters` with `Id`, `Value`, optional `Blend`. Omitted Blend means Add. Catalog ID/name are kept outside the exp3 envelope because that file format has no name field. The browser imports and exports `.exp3.json`; core exports `parseExpression`, `importExpression`, `exportExpression` for other hosts.

The [half-eye example](../examples/sample.half-eyes.exp3.json) can be imported using the browser registration dialog. It multiplies both eye openings by 0.5 while retaining blink input.

`importExpression(document, rig, parameterMap)` uses explicit mappings first, preserves exact known IDs otherwise, and only auto-maps Cubism `ParamMouthOpenY` to legacy StandRig `ParamMouthOpen` when the former is absent. Other unknown IDs fail. Multiple source IDs mapping to the same target fail. Export maps the legacy mouth-open ID back to the Cubism standard name when there is no separately declared `ParamMouthOpenY`; a mapping can override this. No rig IDs or keyforms are renamed. A destination Cubism model still needs the corresponding authored parameter IDs and ranges.

When capturing from sliders, Add stores `current − parameter.default`, Multiply stores `current / parameter.default`, and Overwrite stores current. Capturing Multiply with a zero default is refused; choose another blend or import an explicit factor. Multiplication of eye opening preserves blinking; overwriting it fixes the opening. See [Cubism expression semantics](https://docs.live2d.com/en/cubism-sdk-manual/expression/).

The data shape and operation meanings support future interoperability. This is an independent evaluator, **not a claim of exact Cubism SDK fade/composition parity**. Supported fades are linear. The user selects one expression; outgoing entries fade out using their own FadeOutTime while the selected entry fades in. Re-selecting retargets from the current weight. Transitional Multiply contributions compose multiplicatively, Add contributions add, then Overwrite contributions blend with the result. Overwrite weights above 1 during overlapping fades are normalized. No unsupported feature is silently converted to another blend mode.

## Transient HTTP / MCP

GET `/api/playback/facial` returns `{ok,presets,playback}`. POST accepts exactly one command:

| Command | Effect |
| --- | --- |
| `{"action":"expression","id":"smile","strength":1}` | Select an expression and fade others out |
| `{"action":"viseme","id":"A","strength":1}` | Select a registered vowel or Silence |
| `{"action":"visemes","weights":{"A":0.6,"I":0.4}}` | Mix registered vowel targets |
| `{"action":"clear","layer":"expression"}` | Fade out expressions; preserve vowels |
| `{"action":"clear","layer":"viseme"}` | Fade out vowels; preserve expressions |
| `{"action":"clear","immediate":true}` | Clear both layers immediately |

Strength and each weight are finite [0,1]. Omitted strength means 1. If the sum of supplied viseme weights exceeds 1, weights are normalized; a sum below 1 leaves the remaining contribution to the live base. Empty or all-zero weights release the vowel layer. Crossfade weights are normalized during evaluation too. Clearing with fades returns to the **current** underlying pose, rather than restoring a stale captured pose.

MCP tools: `standrig_facial_catalog`, `standrig_facial`. Their docs resource is `standrig://docs/facial`. Persist via `standrig_modeling_transaction`, not the transient API. No command writes the rig. Commands target the currently loaded model; discover its catalog again after a model/session change. Invalid commands preserve the prior selection.

Playback snapshots include `baseValues` (uncomposed motion/demo/manual/tracker values), `values` (facial-composed output), and `facial` (selected expression ID, current expression/viseme weights, whether a fade is underway). Order is live base → range-bounded expressions → registered viseme channels → final parameter-range clamp → renderer physics. Extreme expression accumulator overflow is saturated before returning bounded model values. Vowels take precedence over expressions on the channels the bank explicitly owns; keep an independent smile/style channel outside the vowel bank when speech must retain that style. Tracking and motion continue updating the base and do not cancel facial layers. Explicit clear/reset/model reload releases them. Facial fade events are published at about 30Hz even while ordinary playback is paused; this does not start a motion or physics loop.

## Embedded runtime

```ts
player.facialCommand({action:'expression',id:'smile'});
player.facialCommand({action:'viseme',id:'A'});
player.play(); // render loop advances fades; does not load any audio analyzer
player.facialCommand({action:'clear',layer:'viseme'});
console.log(player.facialState, player.baseParameters, player.parameters);
```

`FacialController(rig)` exposes `command(request, monotonicMilliseconds)`, `evaluate(baseValues, monotonicMilliseconds)`, `snapshot`, `catalog`, `reset` for native or server hosts. Evaluate against fresh base values each frame, never against its previous output. `StandRigPlayer` does this automatically. If embedded playback is paused, a command renders once; call render/play again to advance time or use your own host loop with the controller. This behavior does not resume a paused motion automatically.

## Scope

No microphone/audio analysis, audio-delay compensation, automatic viseme modeling, hotkey/Stream Deck configuration, `.motionsync3.json` reader/writer, motion3 converter, Cubism SDK or compiled-model conversion is included. These commands prepare the input boundary for later audio analysis. Live2D [Motion-sync](https://docs.live2d.com/en/cubism-editor-manual/motion-sync/) supports basic mouth mappings and vowel Blend Shapes; StandRig's bank follows that separation but uses its own versioned catalog.

The catalog travels in `.srig`, but current Connect releases need a runtime/UI update to expose these registered presets. This change implements StandRig's browser, service, MCP and embedded runtime only. It does not imply that older external players already support the new catalog.
