# Draw order, colors, clips, keyform grids and pendulum physics

These rig fields are optional. A rig that does not use them evaluates and renders exactly as before: no migration is needed, and existing `.srig` files open unchanged. Validation reports malformed values with the codes listed below. The canvas preview, the WebGL path and the server screenshot renderer all apply them.

## Keyed draw order

`parts[].drawOrderBinding` makes a part's draw order follow parameters. Its keyforms form a grid over one to eight parameters, and the sampled value replaces `drawOrder` while sorting.

```json
{
  "drawOrderBinding": {
    "parameters": ["ParamHandSwap"],
    "keyforms": [
      { "inputs": { "ParamHandSwap": 0 }, "value": 400 },
      { "inputs": { "ParamHandSwap": 1 }, "value": 600 }
    ],
    "rounding": "truncate"
  }
}
```

- Values interpolate linearly. With `"rounding": "truncate"` the sample is truncated to an integer (`trunc(value + 0.001)`) before sorting, so a blend that lands next to an integer ties with it and keeps its part order. `"none"` (the default) sorts by the exact value.
- Equal draw orders keep their order in `parts`.
- Validation: `invalid-draw-order-binding`.

## Draw order groups

`drawOrderGroup: true` on a group part sorts its image descendants among themselves, and the group as a whole takes one slot among its siblings, positioned by its own draw order. This keeps, for example, a back leg's pieces together behind the front leg while each leg's pieces still reorder inside it. Groups without the flag do not affect sorting. Validation: `invalid-draw-order-group` (warning).

## Multiply and screen colors

`parts[].blendColors` tints a part's texture before `tint` is applied:

```text
rgb = rgb × multiply
rgb = rgb + screen − rgb × screen
```

```json
{
  "blendColors": {
    "multiply": [1, 0.85, 0.85],
    "screen": [0, 0, 0],
    "parameters": ["ParamCheek"],
    "keyforms": [
      { "inputs": { "ParamCheek": 0 }, "multiply": [1, 1, 1] },
      { "inputs": { "ParamCheek": 1 }, "multiply": [1, 0.7, 0.7] }
    ]
  }
}
```

Channels are linear RGB in 0..1. Without keyforms the static colors apply. With keyforms (one to eight parameters), a keyform that omits a color uses the static value. Validation: `invalid-blend-colors`.

## Clips

- `clip.invert: true` shows the content only where its masks do **not** cover it. Without it, the content shows only inside the masks as before. Validation: `invalid-clip-invert`. The `part-clip` operation and the mask leak check (`joinQa`) handle inverted clips.
- `clip.maskPartIds` accepts up to 32 parts (was 8).
- A mask part that is itself clipped is now a warning (`clip-mask-nested`) instead of an error. While it masks, its own clip is not applied; rendering already worked this way.

## Keyform grids over more parameters

`multiBindings` on parts, ArtMeshes, deformers and Warp pins accept two to eight parameters (`MAX_GRID_PARAMETERS`), so an opacity can depend on, for example, eye-open, smile and a toggle at once. The value is interpolated axis by axis in parameter order. Two-parameter grids give bit-identical results to before.

## Pendulum physics

`physics.pendulum` adds strands of particles that swing under gravity and write their angles back to parameters. It runs after `physics.chains`, and its results are returned as parameter offsets, so QA and rendering see the final values.

```json
{
  "physics": {
    "enabled": true,
    "chains": [],
    "pendulum": {
      "fps": 60,
      "settings": [{
        "id": "hair-front",
        "inputs": [
          { "parameter": "ParamAngleX", "type": "x", "weight": 60 },
          { "parameter": "ParamAngleZ", "type": "angle", "weight": 60 }
        ],
        "outputs": [
          { "parameter": "ParamHairFront", "vertexIndex": 1, "type": "angle", "scale": 1.5, "weight": 100 }
        ],
        "particles": [
          { "mobility": 1, "delay": 1, "acceleration": 1, "radius": 0 },
          { "mobility": 0.95, "delay": 0.9, "acceleration": 1.5, "radius": 15 }
        ],
        "normalization": {
          "position": { "minimum": -10, "default": 0, "maximum": 10 },
          "angle": { "minimum": -10, "default": 0, "maximum": 10 }
        }
      }]
    }
  }
}
```

- **Inputs** move the strand's root (`x`, `y`) or tilt its gravity (`angle`). Each input's parameter range is mapped linearly onto the setting's normalization range, with the parameter default at the normalization default; `weight` (0..100) is its share. An input is negated unless `reflect` is true.
- **Particles**: particle 0 is the root. `radius` is the distance from the previous particle, `mobility` (0..1) the share of velocity kept between steps, `delay` how far a particle moves per step (larger reacts faster), and `acceleration` scales gravity.
- **Outputs** read the segment from particle `vertexIndex − 1` to `vertexIndex`: its angle in radians (`angle`) or its offset (`x`, `y`), times `scale`, negated when `reflect` is true. Weight 100 overwrites the parameter; less blends with the incoming value. Results are clamped to the parameter range.
- Settings run in order, and each reads the outputs earlier settings wrote in the same step, so strands can be chained.
- With `fps`, the simulation steps at that fixed rate and frames interpolate between the last two steps. Omitted or 0 steps once per frame.
- The first evaluation starts at rest under the current inputs, so a screenshot shows the settled pose.
- The strands live in the caller's physics state map under `PENDULUM_STATE_KEY`. Each evaluation stores a new strand state and leaves the previous one untouched, so a host may copy the map between frames and roll back to it.
- `gravity` (default `{x:0, y:-1}`) and `wind` (default `{x:0, y:0}`) are optional.
- Validation: `invalid-pendulum-physics`.

## Default tracking with pendulums

`createDefaultTracking` adapts the defaults it creates to the rig. Tracking settings already saved in a rig are not changed.

- When an enabled pendulum overwrites a default target (for example `ParamAngleX`) at weight 100, writing the target directly would be undone every frame. The mapping writes that pendulum's input instead: the largest-weight input that no pendulum writes, that no earlier default has taken, and that the output follows when settled. The tracked value is scaled into the input's range, and the mapping is inverted only where the pendulum mirrors the input.
- A rig that authors `ParamMouthOpenY` but not `ParamMouthOpen` gets the mouth default on `ParamMouthOpenY`.

Rigs without pendulum physics get the same defaults as before.
