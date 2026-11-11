import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebGLFrameRenderer } from '../packages/runtime/dist/webglFrame.js';

/** A WebGL2 stand-in that records the calls the frame renderer makes. */
function recordingContext() {
  const calls = [], events = {}, uploads = {};
  let lost = false;
  const gl = new Proxy({}, { get(_, key) {
    if (key === 'isContextLost') return () => lost;
    if (key === 'getUniformLocation') return (_program, name) => ({ name });
    if (key === 'getShaderParameter' || key === 'getProgramParameter') return () => true;
    if (key === 'bufferSubData') return (target, offset, data, start, length) => { uploads[target] = [...data.slice(start, start + length)]; };
    if (String(key).startsWith('create')) return () => ({ kind: String(key) });
    if (String(key).toUpperCase() === key) return key;
    return (...args) => { calls.push([key, ...args]); };
  }});
  const canvas = { width: 0, height: 0, getContext: () => gl, addEventListener: (name, fn) => { events[name] = fn; } };
  return { canvas, calls, events, uploads, lose() { lost = true; }, restore() { lost = false; } };
}

const square = (x, y, size, extra = {}) => ({
  image: extra.image ?? {},
  vertices: [{ x, y, u: 0, v: 0 }, { x: x + size, y, u: 1, v: 0 }, { x, y: y + size, u: 0, v: 1 }, { x: x + size, y: y + size, u: 1, v: 1 }],
  triangles: [0, 1, 2, 1, 3, 2],
  opacity: 1,
  mode: 'normal',
  ...extra
});

/** The blend state and pass uniform at each draw. */
function draws(calls) {
  const result = [];
  let blend, pass, invert;
  for (const [name, ...args] of calls) {
    if (name === 'blendFuncSeparate') blend = args.join(',');
    if (name === 'uniform1i' && args[0]?.name === 'u_pass') pass = args[1];
    if (name === 'uniform1i' && args[0]?.name === 'u_invert') invert = args[1];
    if (name === 'drawElements') result.push({ kind: 'mesh', blend, pass, count: args[1], offset: args[3] });
    if (name === 'drawArrays') result.push({ kind: 'composite', blend, invert });
  }
  return result;
}

test('WebGL frame renderer reproduces Canvas blend operations with one draw per mesh', () => {
  const { canvas, calls, uploads } = recordingContext();
  const renderer = new WebGLFrameRenderer(canvas);
  calls.length = 0;
  assert.equal(renderer.render(100, 80, [
    { kind: 'mesh', mesh: square(0, 0, 10) },
    { kind: 'mesh', mesh: square(10, 0, 10, { mode: 'screen' }) },
    { kind: 'mesh', mesh: square(20, 0, 10, { mode: 'additive' }) },
    { kind: 'mesh', mesh: square(30, 0, 10, { mode: 'multiply', colors: { multiply: [1, 0.5, 0.5], screen: [0, 0, 0.2] } }) }
  ]), true);
  assert.deepEqual([canvas.width, canvas.height], [100, 80]);
  assert.deepEqual(draws(calls), [
    { kind: 'mesh', blend: 'ONE,ONE_MINUS_SRC_ALPHA,ONE,ONE_MINUS_SRC_ALPHA', pass: 0, count: 6, offset: 0 },
    { kind: 'mesh', blend: 'ONE,ONE_MINUS_SRC_COLOR,ONE,ONE_MINUS_SRC_ALPHA', pass: 0, count: 6, offset: 24 },
    { kind: 'mesh', blend: 'ONE,ONE,ONE,ONE', pass: 0, count: 6, offset: 48 },
    // Multiply: scale the destination by (s + 1 - sa), keeping alpha, then add s * (1 - da).
    { kind: 'mesh', blend: 'ZERO,SRC_COLOR,ZERO,ONE', pass: 1, count: 6, offset: 72 },
    { kind: 'mesh', blend: 'ONE_MINUS_DST_ALPHA,ONE,ONE_MINUS_DST_ALPHA,ONE', pass: 0, count: 6, offset: 72 }
  ]);
  // Indices are rebased so all meshes share one upload.
  assert.deepEqual(uploads.ELEMENT_ARRAY_BUFFER.slice(6, 12), [4, 5, 6, 5, 7, 6]);
  assert.deepEqual(uploads.ARRAY_BUFFER.slice(16, 20), [10, 0, 0, 0]);
  const colors = calls.filter(([name, location]) => (name === 'uniform3f' && ['u_multiply', 'u_screen'].includes(location?.name)) || (name === 'uniform1i' && location?.name === 'u_colored'));
  assert.deepEqual(colors.map(([, location, ...values]) => [location.name, ...values]), [
    ['u_colored', 0], ['u_colored', 0], ['u_colored', 0], ['u_colored', 1], ['u_multiply', 1, 0.5, 0.5], ['u_screen', 0, 0, 0.2]
  ]);
});

test('WebGL frame clips draw masks and content on layers inside a scissor box', () => {
  const { canvas, calls } = recordingContext();
  const renderer = new WebGLFrameRenderer(canvas);
  calls.length = 0;
  renderer.render(100, 80, [
    { kind: 'clip', invert: false, masks: [square(10, 10, 20)], content: [square(20, 20, 30, { mode: 'multiply' })] },
    { kind: 'clip', invert: true, masks: [square(10, 10, 20)], content: [square(20, 20, 30)] },
    // A normal clip whose masks miss the content draws nothing.
    { kind: 'clip', invert: false, masks: [square(70, 60, 5)], content: [square(0, 0, 5)] }
  ]);
  const scissors = calls.filter(([name]) => name === 'scissor').map(([, ...box]) => box);
  // Mask box [8,8]-[32,32] meets the content box [18,18]-[52,52]; GL rows count from the bottom.
  assert.deepEqual(scissors, [[18, 80 - 32, 14, 14], [18, 80 - 52, 34, 34]]);
  const sequence = draws(calls);
  assert.deepEqual(sequence.map(({ kind, pass, invert }) => kind === 'mesh' ? `mesh${pass}` : `composite:${invert}`), [
    'mesh0', 'mesh1', 'mesh0', 'composite:0',
    'mesh0', 'mesh0', 'composite:1'
  ]);
  assert.equal(sequence[3].blend, 'ONE,ONE_MINUS_SRC_ALPHA,ONE,ONE_MINUS_SRC_ALPHA');
  const framebuffers = calls.filter(([name]) => name === 'bindFramebuffer').map(([, , target]) => target === null ? 'frame' : 'layer');
  assert.deepEqual(framebuffers, [
    'frame',
    'layer', 'layer', 'frame', // the two layers are created on first use
    'layer', 'layer', 'frame', // first clip: masks, content, then laid over the frame
    'layer', 'layer', 'frame'  // inverted clip
  ]);
  assert.equal(calls.filter(([name]) => name === 'texStorage2D').length, 2, 'two layers, created once');
});

test('WebGL frame renderer reports context loss and recovers its resources', () => {
  const context = recordingContext();
  const renderer = new WebGLFrameRenderer(context.canvas);
  const steps = [{ kind: 'mesh', mesh: square(0, 0, 10) }];
  context.lose();
  context.events.webglcontextlost({ preventDefault() {} });
  assert.equal(renderer.status, 'context-lost');
  assert.equal(renderer.render(10, 10, steps), false);
  context.restore();
  context.events.webglcontextrestored();
  assert.equal(renderer.status, 'ready');
  context.calls.length = 0;
  assert.equal(renderer.render(10, 10, steps), true);
  assert.equal(context.calls.filter(([name]) => name === 'texImage2D').length, 1, 'textures are uploaded again');
  renderer.dispose();
  assert.equal(renderer.render(10, 10, steps), false);
});
