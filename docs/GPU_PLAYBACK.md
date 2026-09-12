# Web GPU playback (experimental)

StandRig owns browser rendering. OBS-specific output and integration belong in Connect; this feature adds no OBS dependency.

## Try it

In the preview, choose **描画 → GPU（試験版）**. Choose **標準** to return to Canvas. The choice affects this browser view, not the model or service playback state. The player link carries the selected renderer to the new view. Reloading defaults to Canvas unless the URL contains `?renderer=webgl`.

- Preview: `http://127.0.0.1:5180/?renderer=webgl`
- Player: `http://127.0.0.1:5180/player?renderer=webgl`

The preview status reports GPU availability. If WebGL2 is unavailable or its context is lost, geometry falls back to Canvas. Context restoration recreates GPU resources. Model reload/disposal releases GPU resources.

For embedding:

```ts
const player = new StandRigPlayer(canvas, rig);
player.setRenderer('webgl'); // 'canvas' remains the default
await player.load();
player.play();
console.log(player.rendererStatus);
```

For direct rendering, use `RigRuntime.render(canvas, values, { webglWarp: true })`. The older `webglMesh` option continues to restrict the selected parts to alpha-contour topology. `webglMeshPartIds` can further restrict either path for diagnosis.

## Current scope

The GPU path draws evaluated ArtMesh vertices, local Warp and shared Warp grids, and applies final Glue offsets in Canvas order. Skinning remains in the existing evaluator. Mesh-free unwarped images use a quad. ArtPath, clipping layers and blend-mode composition still use Canvas; they are not silently omitted. This is a hybrid renderer, not a complete GPU scene compositor or GPU physics engine.

Streaming buffers are reused, and no explicit per-part `gl.finish()` is issued. Mipmaps remain disabled because the investigated filter changed detail and coverage without passing visual acceptance.

## Quality and verification

GPU mode is explicitly experimental. Canvas and GPU pixels differ; some differences are Canvas internal triangle seams, but that does not certify every GPU difference. Do not infer final quality or low-end performance from the successful build or geometry tests.

Before enabling GPU by default, verify known-reference fixtures for shared edges, opacity, masks and blend modes; source/UV/vertex parity; maximum poses and expressions; physics and motion; transparent output at multiple resolutions; and context recovery. Keep visible premultiplied-color and alpha metrics alongside visual comparisons, rather than treating raw Canvas pixel equality as the sole acceptance test.

The next renderer stage is to compose parts and masks in one WebGL context while retaining the existing evaluation contract. Worker/OffscreenCanvas isolation can follow after visual correctness. Native video transfer and OBS-specific delivery remain outside this package.
