import type { ParameterValues } from "@standrig/core/types";

export const MOTION_PREVIEW_MODES = ["showcase-active", "mouse-expression"] as const;
export type MotionPreviewMode = typeof MOTION_PREVIEW_MODES[number];
export const MOTION_PREVIEW_LABELS: Record<MotionPreviewMode, string> = {
  "showcase-active": "Showcase — Fast & Wide",
  "mouse-expression": "Mouse + Expressions"
};
/** One pass of the Showcase choreography, in seconds. */
export const SHOWCASE_CYCLE_SECONDS = 18;
export const SHOWCASE_ACTIVE_SPEED = 1.3;
export const SHOWCASE_ACTIVE_CYCLE_SECONDS = SHOWCASE_CYCLE_SECONDS / SHOWCASE_ACTIVE_SPEED;

export interface MotionPreviewPointer { x: number; y: number; }

export function motionPreviewValues(base: ParameterValues, mode: MotionPreviewMode, timeSeconds: number, pointer: MotionPreviewPointer = { x: 0, y: 0 }): ParameterValues {
  const time = Math.max(0, Number.isFinite(timeSeconds) ? timeSeconds : 0);
  const breath = (Math.sin((time * Math.PI * 2) / 3.6) + 1) / 2;
  const values: ParameterValues = { ...base, ParamBreath: breath };

  if (mode === "mouse-expression") {
    applyMouseFollow(values, pointer);

    const expression = mouseExpression(time);
    values.ParamEyeLOpen = Math.max(0, (base.ParamEyeLOpen ?? 1) * (1 - expression.leftClose));
    values.ParamEyeROpen = Math.max(0, (base.ParamEyeROpen ?? 1) * (1 - expression.rightClose));
    values.ParamMouthOpen = Math.max(base.ParamMouthOpen ?? 0, expression.mouthOpen);
    return values;
  }
  if (mode === "showcase-active") {
    const activeTime = time * SHOWCASE_ACTIVE_SPEED;
    values.ParamBreath = (Math.sin((activeTime * Math.PI * 2) / 3.6) + 1) / 2;
    applyShowcase(values, base, activeTime);
    for (const parameter of ["ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ"]) {
      const limit = parameter === "ParamBodyAngleZ" ? 10 : 30;
      const value = values[parameter];
      // Expand smaller swings smoothly while retaining the authored extrema.
      // Physics keeps real elapsed time and responds naturally to the faster inputs.
      values[parameter] = value * 1.2 / (1 + 0.2 * Math.abs(value) / limit);
    }
    return values;
  }

  return values;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}

/**
 * Showcase choreography.
 *
 * Physics Test only sweeps the head and body angles, so nothing in it exercises the eyes, the mouth
 * or the gaze. This walks a fixed cycle through each group in turn while keeping a slow carrier
 * motion underneath, so hair and cloth physics never settle and every stage overlaps the next
 * instead of snapping between poses.
 *
 * The carriers and stage gains are sized so every channel reaches most of its range: the body
 * angles peak around -27..26 and -29..28 of a +-30 parameter. They stop short of the limit on
 * purpose - riding the clamp flattens the top of each swing into a hold, which reads as a stall.
 */
function applyShowcase(values: ParameterValues, base: ParameterValues, time: number): void {
  const phase = time % SHOWCASE_CYCLE_SECONDS;

  // Carrier: always present, so the pose is never perfectly still and the hair keeps swinging.
  let angleX = Math.sin(time * 0.55) * 6;
  let angleY = Math.sin(time * 0.43 + 1.1) * 4;
  let angleZ = Math.sin(time * 0.37) * 3;
  let bodyX = Math.sin(time * 0.48) * 8;
  let bodyY = Math.sin(time * 0.39 + 0.6) * 7;
  let bodyZ = Math.sin(time * 0.33) * 2;
  let gazeX = 0;
  let gazeY = 0;

  // 0-4s: look left and right, with the gaze leading the head slightly.
  const turn = stageWeight(phase, 0, 4);
  if (turn > 0) {
    const swing = Math.sin(((phase - 0) / 4) * Math.PI * 2);
    angleX += swing * 30 * turn;
    angleZ += swing * -7 * turn;
    gazeX += swing * turn;
    bodyX += swing * 22 * turn;
  }

  // 4-7.5s: nod up and down.
  const nod = stageWeight(phase, 4, 3.5);
  if (nod > 0) {
    const swing = Math.sin(((phase - 4) / 3.5) * Math.PI * 2);
    angleY += swing * 28 * nod;
    gazeY += swing * 0.8 * nod;
    bodyY += swing * 24 * nod;
  }

  // 7.5-10.5s: head tilt, which is the axis the rules keep deliberately small.
  const tilt = stageWeight(phase, 7.5, 3);
  if (tilt > 0) {
    const swing = Math.sin(((phase - 7.5) / 3) * Math.PI * 2);
    angleZ += swing * 30 * tilt;
    bodyZ += swing * 9 * tilt;
    gazeX += swing * 0.4 * tilt;
  }

  // 10.5-14s: talking. Mouth open plus form/smile so the phoneme shapes are exercised too.
  const talk = stageWeight(phase, 10.5, 3.5);
  if (talk > 0) {
    const local = phase - 10.5;
    values.ParamMouthOpen = clamp(talkShape(local), 0, 1) * talk;
    values.ParamMouthForm = Math.sin(local * 3.1) * 0.8 * talk;
    values.ParamMouthSmile = Math.sin(local * 1.4 + 0.8) * 0.6 * talk;
    angleY += Math.sin(local * 5.2) * 4 * talk;
    angleZ += Math.sin(local * 3.7) * 4 * talk;
  }

  // 14-18s: expression pass. Smile, cheek, a wink, then a wide-eyed beat.
  const express = stageWeight(phase, 14, 4);
  if (express > 0) {
    const local = phase - 14;
    values.ParamMouthSmile = Math.max(values.ParamMouthSmile ?? 0, bump(local, 0.2, 2.4) * express);
    values.ParamMouthOpen = Math.max(values.ParamMouthOpen ?? 0, bump(local, 2.4, 1.2) * 0.7 * express);
    values.ParamCheek = bump(local, 0.4, 3) * express;
    values.ParamEyeLSmile = bump(local, 0.3, 2.2) * express;
    values.ParamEyeRSmile = bump(local, 0.3, 2.2) * express;
    gazeY -= 0.3 * express;
    angleZ += Math.sin(local * 1.6) * 6 * express;
  }

  // Blinks run across the whole cycle, with a wink inside the expression pass.
  const blink = Math.max(pulse(phase, 2.2, 0.18), pulse(phase, 6.4, 0.18), pulse(phase, 12.8, 0.16), pulse(phase, 16.6, 0.2));
  const wink = pulse(phase, 15.2, 0.5);
  const openL = base.ParamEyeLOpen ?? 1;
  const openR = base.ParamEyeROpen ?? 1;
  values.ParamEyeLOpen = Math.max(0, openL * (1 - Math.max(blink, wink)));
  values.ParamEyeROpen = Math.max(0, openR * (1 - blink));

  values.ParamAngleX = clamp(angleX, -30, 30);
  values.ParamAngleY = clamp(angleY, -30, 30);
  values.ParamAngleZ = clamp(angleZ, -30, 30);
  values.ParamBodyAngleX = clamp(bodyX, -30, 30);
  values.ParamBodyAngleY = clamp(bodyY, -30, 30);
  values.ParamBodyAngleZ = clamp(bodyZ, -10, 10);
  values.ParamEyeBallX = clamp(gazeX, -1, 1);
  values.ParamEyeBallY = clamp(gazeY, -1, 1);
}

/** Raised-cosine window, so a stage fades in and out instead of snapping on. */
function stageWeight(phase: number, start: number, duration: number): number {
  const edge = Math.min(0.6, duration / 4);
  if (phase <= start - edge || phase >= start + duration + edge) return 0;
  if (phase < start) return (phase - (start - edge)) / edge;
  if (phase > start + duration) return 1 - (phase - (start + duration)) / edge;
  return 1;
}

/** Mouth opening for the talking stage: syllable-rate bursts with varied depth. */
function talkShape(local: number): number {
  const syllable = Math.max(0, Math.sin(local * Math.PI * 3.4));
  const emphasis = 0.55 + Math.sin(local * 0.9) * 0.35;
  return syllable * emphasis;
}

/** Smooth 0..1..0 over [start, start + duration]. */
function bump(local: number, start: number, duration: number): number {
  if (local < start || local > start + duration) return 0;
  return Math.sin(((local - start) / duration) * Math.PI);
}

function applyMouseFollow(values: ParameterValues, pointer: MotionPreviewPointer): void {
  const x = clamp(pointer.x, -1, 1);
  const y = clamp(pointer.y, -1, 1);
  values.ParamAngleX = x * 30;
  // The current head rig looks down at positive pitch, matching screen Y.
  values.ParamAngleY = y * 30;
  values.ParamAngleZ = x * -6;
  values.ParamEyeBallX = x;
  values.ParamEyeBallY = y;
  values.ParamBodyAngleX = x * 16;
  // Keep the physical body-pitch direction, but make the visible vertical
  // compression strong enough to read during mouse follow.
  values.ParamBodyAngleY = y * 28;
}

function mouseExpression(time: number): { leftClose: number; rightClose: number; mouthOpen: number } {
  const phase = time % 9.6;
  const blink = pulse(phase, 0.08, 0.16);
  const leftWink = pulse(phase, 2.5, 0.3);
  const rightWink = pulse(phase, 5.3, 0.3);
  return {
    leftClose: Math.max(blink, leftWink),
    rightClose: Math.max(blink, rightWink),
    mouthOpen: Math.max(talkBurst(phase, 1, 0.8), talkBurst(phase, 7, 0.7))
  };
}

function pulse(phase: number, start: number, duration: number): number {
  if (phase < start || phase > start + duration) return 0;
  return Math.sin(((phase - start) / duration) * Math.PI);
}

function talkBurst(phase: number, start: number, duration: number): number {
  if (phase < start || phase > start + duration) return 0;
  const chatter = Math.max(0, Math.sin((phase - start) * Math.PI * 4));
  return 0.18 + chatter * 0.55;
}
