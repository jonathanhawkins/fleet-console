/** The robot's joints, in wire order: every telemetry batch and every scan walks them in this sequence. */
export const JOINTS = [
  "hip_L",
  "hip_R",
  "knee_L",
  "knee_R",
  "ankle_L",
  "ankle_R",
] as const;
export type Joint = (typeof JOINTS)[number];

/** 10 Hz batches (CLAUDE.md non-negotiable #4). */
export const BATCH_INTERVAL_MS = 100;

/** Anti-phase left/right legs; knees and ankles lag the hips. */
export const JOINT_PHASE: Record<Joint, number> = {
  hip_L: 0,
  hip_R: Math.PI,
  knee_L: 0.6,
  knee_R: Math.PI + 0.6,
  ankle_L: 1.2,
  ankle_R: Math.PI + 1.2,
};

export const BASE_TORQUE: Record<Joint, number> = {
  hip_L: 17,
  hip_R: 17,
  knee_L: 13,
  knee_R: 13,
  ankle_L: 8,
  ankle_R: 8,
};

export const GAIT_AMP: Record<Joint, number> = {
  hip_L: 5.5,
  hip_R: 5.5,
  knee_L: 4.5,
  knee_R: 4.5,
  ankle_L: 2.8,
  ankle_R: 2.8,
};
