import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { PlaybackSession } from '../apps/service/dist/playback.js';

const sample = JSON.parse(await readFile(new URL('../examples/sample.standrig.json', import.meta.url), 'utf8'));

/** A ServerResponse stand-in whose writes complete only when release() is called (a slow output). */
function slowOutput() {
  const pending = [], frames = [];
  const out = new Writable({
    highWaterMark: 64,
    write(chunk, _encoding, callback) { frames.push(String(chunk)); pending.push(callback); }
  });
  out.writeHead = () => out;
  out.release = () => { while (pending.length) pending.shift()(); };
  out.frames = frames;
  return out;
}
const lastSnapshot = out => JSON.parse(out.frames.at(-1).split('data: ')[1]);

test('a backed-up output skips frames instead of being dropped and then receives the latest state', async () => {
  const session = new PlaybackSession(structuredClone(sample));
  const out = slowOutput();
  try {
    session.subscribe(out);
    assert.equal(out.frames.length, 1, 'the initial snapshot is written');
    for (let i = 1; i <= 5; i++) session.input({ source: 'tracker', sequence: i, values: { ParamAngleZ: i } });
    assert.equal(out.destroyed, false, 'a slow output stays connected');
    assert.equal(session.snapshot().connectedOutputs, 1);
    assert.equal(out.frames.length, 1, 'frames are skipped while the output is backed up');
    out.release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(out.frames.length, 2, 'one catch-up frame after drain, not the whole backlog');
    assert.equal(lastSnapshot(out).values.ParamAngleZ, 5, 'the catch-up frame carries the latest state');
    out.release();
    session.input({ source: 'tracker', sequence: 6, values: { ParamAngleZ: 6 } });
    assert.equal(lastSnapshot(out).values.ParamAngleZ, 6, 'normal delivery resumes after the drain');
  } finally {
    session.close();
    out.destroy();   // emits 'close', which clears the subscription heartbeat
  }
});

test('a closed output is forgotten', async () => {
  const session = new PlaybackSession(structuredClone(sample));
  const out = slowOutput();
  try {
    session.subscribe(out);
    out.destroy();
    await new Promise(resolve => setImmediate(resolve));
    session.input({ source: 'tracker', sequence: 1, values: { ParamAngleZ: 3 } });
    assert.equal(session.snapshot().connectedOutputs, 0);
  } finally {
    session.close();
  }
});
