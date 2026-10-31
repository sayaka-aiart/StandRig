export interface FrameTimer { stop(): void; unref(): void }
interface Clock {
  now(): number;
  schedule(callback: () => void, delay: number): { cancel(): void; unref(): void };
}
const clock: Clock = {
  now: () => performance.now(),
  schedule(callback, delay) {
    const timer = setTimeout(callback, delay);
    return { cancel: () => clearTimeout(timer), unref: () => { timer.unref(); } };
  }
};

/** Deadline-based cadence avoids accumulating coarse timer rounding on Windows. */
export function startFrameTimer(callback: () => void, fps = 30, timing: Clock = clock): FrameTimer {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 1000) throw Error('Invalid frame rate');
  const interval = 1000 / fps;
  let deadline = timing.now() + interval, stopped = false, unreferenced = false;
  let pending: ReturnType<Clock['schedule']>;
  function schedule() {
    pending = timing.schedule(tick, Math.max(1, deadline - timing.now()));
    if (unreferenced) pending.unref();
  }
  function tick() {
    if (stopped) return;
    // Some timers can fire early. Keep the original deadline in that case.
    if (timing.now() < deadline) { schedule(); return; }
    try { callback(); }
    finally {
      if (!stopped) {
        const now = timing.now();
        deadline += Math.max(1, Math.floor((now - deadline) / interval) + 1) * interval;
        schedule();
      }
    }
  }
  schedule();
  return {
    stop() { stopped = true; pending.cancel(); },
    unref() { unreferenced = true; pending.unref(); }
  };
}
