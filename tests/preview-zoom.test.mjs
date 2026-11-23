import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RigRuntime } from '@standrig/runtime/renderer';

test('preview zoom holds the stage point under an off-center cursor even after panning', () => {
  globalThis.window = { devicePixelRatio: 2 };
  globalThis.DOMPoint = class {
    constructor(x, y) {
      this.x = x;
      this.y = y;
    }
  };
  const canvas = {
    getBoundingClientRect: () => ({ left: 75, top: 105, width: 703, height: 547 }),
    dataset: {}
  };
  const cursorX = 290;
  const cursorY = 226;
  // The second stage exercises the renderer's minimum-scale floor.
  for (const width of [1600, 800000]) {
    const runtime = new RigRuntime({ stage: { width, height: width * 2 }, parts: [] });
    const current = { zoom: 1.75, panX: 52, panY: -60 };
    const original = runtime.clientPointToStage(canvas, cursorX, cursorY, current);
    for (const zoom of [0.5, 1, 2.25, 5]) {
      const pan = runtime.panForZoom(canvas, zoom, cursorX, cursorY, current);
      const anchored = runtime.clientPointToStage(canvas, cursorX, cursorY, { zoom, ...pan });
      assert.ok(Math.abs(original.x - anchored.x) < 1e-7, `X anchor shifted at ${zoom}× for stage width ${width}`);
      assert.ok(Math.abs(original.y - anchored.y) < 1e-7, `Y anchor shifted at ${zoom}× for stage width ${width}`);
    }
  }
});
