import type {
  ParameterDefinition,
  ParameterValues,
  RigPendulumOutput,
  RigPendulumPhysics,
  RigPendulumRange,
  RigPendulumSetting,
  RigVector2
} from "./types.js";

/**
 * Pendulum physics.
 *
 * Each setting is a strand of particles. Its inputs, normalized from their parameter range, move the
 * strand's root (x/y) and tilt its gravity (angle); the strand swings toward gravity; each output
 * reads one segment's angle (or offset) and writes it to a parameter, overwriting it at weight 100
 * or blending below. Settings run in order on shared parameter caches, so a setting reads the outputs
 * of the settings before it. With `fps` the simulation steps at a fixed rate and frames interpolate
 * between the last two steps.
 */

const AIR_RESISTANCE = 5;
const MAXIMUM_WEIGHT = 100;
const MOVEMENT_THRESHOLD = 0.001;
const MAXIMUM_DELTA_TIME = 5;

interface Particle {
  position: RigVector2;
  lastPosition: RigVector2;
  lastGravity: RigVector2;
  velocity: RigVector2;
}

export interface PendulumState {
  signature: string;
  strands: Particle[][];
  currentOutputs: number[][];
  previousOutputs: number[][];
  /** Parameter values the settings read and write during a step. */
  caches: Map<string, number>;
  /** The caches as the previous step left them, blended toward each frame's incoming values. */
  inputCaches: Map<string, number>;
  remainTime: number;
}

type ParameterRanges = ReadonlyMap<string, Pick<ParameterDefinition, "min" | "max" | "default">>;

export function pendulumSignature(physics: RigPendulumPhysics): string {
  return physics.settings.map((setting) => `${setting.id}:${setting.particles.length}:${setting.outputs.length}`).join("|");
}

/** Parameters the pendulum reads or writes. */
export function pendulumParameters(physics: RigPendulumPhysics): Set<string> {
  const parameters = new Set<string>();
  for (const setting of physics.settings) {
    if (setting.enabled === false) continue;
    for (const input of setting.inputs) parameters.add(input.parameter);
    for (const output of setting.outputs) parameters.add(output.parameter);
  }
  return parameters;
}

/** Enabled settings that overwrite `parameter` every frame (a valid output at full weight), in order. */
export function pendulumSettingsOverwriting(physics: RigPendulumPhysics, parameter: string): RigPendulumSetting[] {
  return physics.settings.filter(
    (setting) => setting.enabled !== false && setting.outputs.some((output) => output.parameter === parameter && output.weight >= MAXIMUM_WEIGHT && validOutput(setting, output))
  );
}

/**
 * How strongly one setting's settled output follows one of its inputs near the input's default: output
 * change per unit of input, measured at rest with everything else at its default. Negative where the
 * output mirrors the input; 0 where it does not settle anywhere else (a pure translation input).
 */
export function pendulumSettledGain(physics: RigPendulumPhysics, parameters: ParameterRanges, setting: RigPendulumSetting, input: string, output: string): number {
  const range = parameters.get(input);
  if (!range) return 0;
  const low = Math.min(range.min, range.max), high = Math.max(range.min, range.max);
  const step = (high - low) * 0.05;
  const from = Math.max(low, range.default - step), to = Math.min(high, range.default + step);
  if (!(to > from)) return 0;
  const single: RigPendulumPhysics = { ...physics, settings: [setting] };
  const at = (value: number) => evaluatePendulumPhysics(single, parameters, { [input]: value }, 0, undefined).outputs[output] ?? 0;
  return (at(to) - at(from)) / (to - from);
}

/**
 * Advances the pendulum by `dt` seconds from the incoming (pre-physics) values and returns the final
 * values of the parameters it outputs to. A missing or stale `state` is (re)initialized at rest for
 * these values first, so a fresh evaluation shows the settled pose. The given state is not modified:
 * the advanced state is a new object, so a caller can keep the previous one to roll back.
 */
export function evaluatePendulumPhysics(
  physics: RigPendulumPhysics,
  parameters: ParameterRanges,
  values: ParameterValues,
  dt: number,
  state: PendulumState | undefined
): { state: PendulumState; outputs: ParameterValues } {
  const signature = pendulumSignature(physics);
  const current = state && state.signature === signature ? clonePendulumState(state) : stabilize(physics, parameters, values, signature);
  const fixedDt = physics.fps && physics.fps > 0 ? 1 / physics.fps : dt;
  const valueOf = (parameter: string) => values[parameter] ?? parameters.get(parameter)?.default ?? 0;

  if (dt > 0 && fixedDt > 0) {
    current.remainTime += dt;
    if (current.remainTime > MAXIMUM_DELTA_TIME) current.remainTime = 0;
    while (current.remainTime >= fixedDt) {
      current.previousOutputs = current.currentOutputs.map((outputs) => [...outputs]);
      // Incoming values reach the caches gradually across the steps of one frame.
      const inputWeight = fixedDt / current.remainTime;
      for (const [parameter, cached] of current.inputCaches) {
        const blended = cached * (1 - inputWeight) + valueOf(parameter) * inputWeight;
        current.caches.set(parameter, blended);
        current.inputCaches.set(parameter, blended);
      }
      physics.settings.forEach((setting, index) => {
        if (setting.enabled !== false) stepSetting(physics, setting, current.strands[index], current.currentOutputs[index], parameters, current.caches, fixedDt);
      });
      current.remainTime -= fixedDt;
    }
  }

  // Interpolate between the last two steps and apply the outputs to the incoming values.
  const alpha = fixedDt > 0 ? current.remainTime / fixedDt : 1;
  const outputs: ParameterValues = {};
  physics.settings.forEach((setting, settingIndex) => {
    if (setting.enabled === false) return;
    setting.outputs.forEach((output, outputIndex) => {
      const range = parameters.get(output.parameter);
      if (!range || !validOutput(setting, output)) return;
      const value = current.previousOutputs[settingIndex][outputIndex] * (1 - alpha) + current.currentOutputs[settingIndex][outputIndex] * alpha;
      outputs[output.parameter] = applyOutput(outputs[output.parameter] ?? valueOf(output.parameter), range, value, output);
    });
  });
  return { state: current, outputs };
}

function clonePendulumState(state: PendulumState): PendulumState {
  return {
    signature: state.signature,
    strands: state.strands.map((strand) => strand.map((particle) => ({
      position: { ...particle.position },
      lastPosition: { ...particle.lastPosition },
      lastGravity: { ...particle.lastGravity },
      velocity: { ...particle.velocity }
    }))),
    currentOutputs: state.currentOutputs.map((outputs) => [...outputs]),
    previousOutputs: state.previousOutputs.map((outputs) => [...outputs]),
    caches: new Map(state.caches),
    inputCaches: new Map(state.inputCaches),
    remainTime: state.remainTime
  };
}

/** A strand hanging at rest for these values, with the outputs that rest pose produces. */
function stabilize(physics: RigPendulumPhysics, parameters: ParameterRanges, values: ParameterValues, signature: string): PendulumState {
  const involved = pendulumParameters(physics);
  const caches = new Map<string, number>();
  for (const parameter of involved) caches.set(parameter, values[parameter] ?? parameters.get(parameter)?.default ?? 0);
  const strands: Particle[][] = [];
  const outputs: number[][] = [];
  for (const setting of physics.settings) {
    const strand = restStrand(setting);
    const settingOutputs = setting.outputs.map(() => 0);
    strands.push(strand);
    outputs.push(settingOutputs);
    if (setting.enabled === false || strand.length < 2) continue;
    const { translation, angle } = settingInputs(setting, parameters, caches);
    const gravity = gravityDirection(angle);
    const wind = physics.wind ?? { x: 0, y: 0 };
    const threshold = MOVEMENT_THRESHOLD * setting.normalization.position.maximum;
    strand[0].position = translation;
    for (let index = 1; index < strand.length; index += 1) {
      const particle = strand[index], spec = setting.particles[index];
      const force = normalized({ x: gravity.x * spec.acceleration + wind.x, y: gravity.y * spec.acceleration + wind.y });
      particle.position = { x: strand[index - 1].position.x + force.x * spec.radius, y: strand[index - 1].position.y + force.y * spec.radius };
      if (Math.abs(particle.position.x) < threshold) particle.position.x = 0;
      particle.lastPosition = { ...particle.position };
      particle.velocity = { x: 0, y: 0 };
      particle.lastGravity = gravity;
    }
    writeOutputs(physics, setting, strand, settingOutputs, parameters, caches);
  }
  return {
    signature,
    strands,
    currentOutputs: outputs,
    previousOutputs: outputs.map((entry) => [...entry]),
    caches,
    inputCaches: new Map(caches),
    remainTime: 0
  };
}

function restStrand(setting: RigPendulumSetting): Particle[] {
  const strand: Particle[] = [];
  let y = 0;
  setting.particles.forEach((particle, index) => {
    if (index > 0) y += particle.radius;
    const position = { x: 0, y };
    strand.push({ position, lastPosition: { ...position }, lastGravity: { x: 0, y: 1 }, velocity: { x: 0, y: 0 } });
  });
  return strand;
}

function stepSetting(
  physics: RigPendulumPhysics,
  setting: RigPendulumSetting,
  strand: Particle[],
  outputs: number[],
  parameters: ParameterRanges,
  caches: Map<string, number>,
  dt: number
): void {
  if (strand.length < 2) return;
  const { translation, angle } = settingInputs(setting, parameters, caches);
  const gravity = gravityDirection(angle);
  const wind = physics.wind ?? { x: 0, y: 0 };
  const threshold = MOVEMENT_THRESHOLD * setting.normalization.position.maximum;
  strand[0].position = translation;
  for (let index = 1; index < strand.length; index += 1) {
    const particle = strand[index], previous = strand[index - 1], spec = setting.particles[index];
    const force = { x: gravity.x * spec.acceleration + wind.x, y: gravity.y * spec.acceleration + wind.y };
    particle.lastPosition = { ...particle.position };
    const delay = spec.delay * dt * 30;
    // The segment turns with the change of gravity, damped by air resistance.
    const turn = angleBetween(particle.lastGravity, gravity) / AIR_RESISTANCE;
    const direction = rotateSequential({ x: particle.position.x - previous.position.x, y: particle.position.y - previous.position.y }, turn);
    let position = { x: previous.position.x + direction.x, y: previous.position.y + direction.y };
    position = {
      x: position.x + particle.velocity.x * delay + force.x * delay * delay,
      y: position.y + particle.velocity.y * delay + force.y * delay * delay
    };
    const segment = normalized({ x: position.x - previous.position.x, y: position.y - previous.position.y });
    particle.position = { x: previous.position.x + segment.x * spec.radius, y: previous.position.y + segment.y * spec.radius };
    if (Math.abs(particle.position.x) < threshold) particle.position.x = 0;
    if (delay !== 0) {
      particle.velocity = {
        x: ((particle.position.x - particle.lastPosition.x) / delay) * spec.mobility,
        y: ((particle.position.y - particle.lastPosition.y) / delay) * spec.mobility
      };
    }
    particle.lastGravity = gravity;
  }
  writeOutputs(physics, setting, strand, outputs, parameters, caches);
}

function writeOutputs(
  physics: RigPendulumPhysics,
  setting: RigPendulumSetting,
  strand: Particle[],
  outputs: number[],
  parameters: ParameterRanges,
  caches: Map<string, number>
): void {
  const reference = physics.gravity ?? { x: 0, y: -1 };
  setting.outputs.forEach((output, index) => {
    if (!validOutput(setting, output)) return;
    const particle = output.vertexIndex;
    const segment = { x: strand[particle].position.x - strand[particle - 1].position.x, y: strand[particle].position.y - strand[particle - 1].position.y };
    let value: number;
    if (output.type === "angle") {
      const parent = particle >= 2
        ? { x: strand[particle - 1].position.x - strand[particle - 2].position.x, y: strand[particle - 1].position.y - strand[particle - 2].position.y }
        : { x: -reference.x, y: -reference.y };
      value = angleBetween(parent, segment);
    } else {
      value = output.type === "x" ? segment.x : segment.y;
    }
    if (output.reflect) value = -value;
    outputs[index] = value;
    const range = parameters.get(output.parameter);
    if (range) caches.set(output.parameter, applyOutput(caches.get(output.parameter) ?? range.default, range, value, output));
  });
}

function validOutput(setting: RigPendulumSetting, output: RigPendulumOutput): boolean {
  return Number.isInteger(output.vertexIndex) && output.vertexIndex >= 1 && output.vertexIndex < setting.particles.length;
}

/** Scales, clamps to the parameter range and blends by weight into `current`. */
function applyOutput(current: number, range: Pick<ParameterDefinition, "min" | "max">, raw: number, output: RigPendulumOutput): number {
  const scaled = raw * output.scale;
  const clamped = Math.min(Math.max(range.min, range.max), Math.max(Math.min(range.min, range.max), scaled));
  const weight = output.weight / MAXIMUM_WEIGHT;
  return weight >= 1 ? clamped : current * (1 - weight) + clamped * weight;
}

function settingInputs(setting: RigPendulumSetting, parameters: ParameterRanges, caches: Map<string, number>): { translation: RigVector2; angle: number } {
  let x = 0, y = 0, angle = 0;
  for (const input of setting.inputs) {
    const range = parameters.get(input.parameter);
    if (!range) continue;
    const weight = input.weight / MAXIMUM_WEIGHT;
    const value = caches.get(input.parameter) ?? range.default;
    const normalization = input.type === "angle" ? setting.normalization.angle : setting.normalization.position;
    const normalizedValue = normalizeParameter(value, range.min, range.max, normalization, input.reflect === true) * weight;
    if (input.type === "x") x += normalizedValue;
    else if (input.type === "y") y += normalizedValue;
    else angle += normalizedValue;
  }
  // The root translation turns against the input angle.
  const translation = rotateSequential({ x, y }, degreesToRadians(-angle));
  return { translation, angle };
}

/**
 * Maps a parameter value onto a normalization range: the middle of the parameter's range lands on
 * the normalization default, each half scales linearly onto its side. Unreflected inputs are negated.
 */
export function normalizeParameter(value: number, minimum: number, maximum: number, range: RigPendulumRange, reflect: boolean): number {
  const low = Math.min(minimum, maximum), high = Math.max(minimum, maximum);
  const clamped = Math.min(high, Math.max(low, value));
  const middle = low + (high - low) / 2;
  const normalizedLow = Math.min(range.minimum, range.maximum), normalizedHigh = Math.max(range.minimum, range.maximum);
  const offset = clamped - middle;
  let result = range.default;
  if (offset > 0 && high !== middle) result = offset * ((normalizedHigh - range.default) / (high - middle)) + range.default;
  else if (offset < 0 && low !== middle) result = offset * ((normalizedLow - range.default) / (low - middle)) + range.default;
  return reflect ? result : -result;
}

function gravityDirection(angleDegrees: number): RigVector2 {
  const radians = degreesToRadians(angleDegrees);
  return normalized({ x: Math.sin(radians), y: Math.cos(radians) });
}

/**
 * Rotation that computes the new y from the already rotated x (not a pure rotation). Pendulum settings
 * are tuned with this behavior, so it is kept as is.
 */
function rotateSequential(vector: RigVector2, radians: number): RigVector2 {
  const x = vector.x * Math.cos(radians) - vector.y * Math.sin(radians);
  const y = x * Math.sin(radians) + vector.y * Math.cos(radians);
  return { x, y };
}

/** Signed angle from `from` to `to`, in (-PI, PI]. */
function angleBetween(from: RigVector2, to: RigVector2): number {
  let radians = Math.atan2(to.y, to.x) - Math.atan2(from.y, from.x);
  while (radians < -Math.PI) radians += Math.PI * 2;
  while (radians > Math.PI) radians -= Math.PI * 2;
  return radians;
}

function normalized(vector: RigVector2): RigVector2 {
  const length = Math.hypot(vector.x, vector.y);
  return length > 0 ? { x: vector.x / length, y: vector.y / length } : { x: 0, y: 0 };
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Structural problems of a pendulum definition (empty when it is usable). */
export function pendulumPhysicsIssues(physics: RigPendulumPhysics | undefined, knownParameters: ReadonlySet<string>): string[] {
  if (physics === undefined) return [];
  if (!physics || typeof physics !== "object" || !Array.isArray(physics.settings)) return ["pendulum.settings must be an array"];
  const issues: string[] = [];
  if (physics.fps !== undefined && !(Number.isFinite(physics.fps) && physics.fps >= 0)) issues.push("fps must be a non-negative number");
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  const types = new Set(["x", "y", "angle"]);
  const ids = new Set<string>();
  physics.settings.forEach((setting, index) => {
    const at = `setting ${setting?.id ?? index}`;
    if (!setting || typeof setting.id !== "string" || !setting.id) { issues.push(`${at}: id is required`); return; }
    if (ids.has(setting.id)) issues.push(`${at}: duplicate id`);
    ids.add(setting.id);
    if (!Array.isArray(setting.particles) || setting.particles.length < 2) issues.push(`${at}: needs at least two particles`);
    for (const particle of setting.particles ?? []) {
      if (![particle?.mobility, particle?.delay, particle?.acceleration, particle?.radius].every(finite)) { issues.push(`${at}: particle values must be finite`); break; }
    }
    for (const input of setting.inputs ?? []) {
      if (!knownParameters.has(input.parameter)) issues.push(`${at}: unknown input parameter ${input.parameter}`);
      if (!types.has(input.type) || !finite(input.weight)) issues.push(`${at}: invalid input on ${input.parameter}`);
    }
    for (const output of setting.outputs ?? []) {
      if (!knownParameters.has(output.parameter)) issues.push(`${at}: unknown output parameter ${output.parameter}`);
      if (!types.has(output.type) || !finite(output.weight) || !finite(output.scale) || !validOutput(setting, output)) issues.push(`${at}: invalid output on ${output.parameter}`);
    }
    const ranges = [setting.normalization?.position, setting.normalization?.angle];
    if (!ranges.every((range) => range && finite(range.minimum) && finite(range.default) && finite(range.maximum))) issues.push(`${at}: normalization needs finite position and angle ranges`);
  });
  return issues;
}
