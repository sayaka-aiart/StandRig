import { resolvePhysicsFrame, type PhysicsValue } from '@standrig/core/evaluator';
import type { ParameterValues, RigDocument } from '@standrig/core/types';

/** Bounded catch-up for a live renderer. Geometry is evaluated only once. */
export function prepareLivePhysicsStep(
  rig: RigDocument,
  values: ParameterValues,
  previous: ParameterValues | undefined,
  state: Map<string, PhysicsValue>,
  elapsed: number,
  time: number
) {
  // Long background/suspended intervals must not create unbounded work.
  const duration = Math.min(0.25, Math.max(0.0001, Number.isFinite(elapsed) ? elapsed : 1 / 60));
  const steps = Math.max(1, Math.ceil(duration / (1 / 60)));
  const dt = duration / steps;
  const end = Number.isFinite(time) ? time : 0;
  for (let i = 1; i < steps; i++) {
    const fraction = i / steps;
    const input: ParameterValues = {};
    for (const [id, value] of Object.entries(values)) {
      const from = previous?.[id] ?? value;
      input[id] = from + (value - from) * fraction;
    }
    resolvePhysicsFrame(rig, input, state, dt, end - duration + dt * i);
  }
  // resolveRigFrame performs the last physics step and all geometry work.
  return { dt, time: end, duration, steps };
}
