export const MOTION_LPF_TAU_EVENT = 'jarvis:motion-lpf-tau-change';
const MOTION_LPF_TAU_KEY = 'jarvis.motionLpfTauMs';
export const MOTION_LPF_TAU_DEFAULT = 80;
export const MOTION_LPF_TAU_MIN = 0;
export const MOTION_LPF_TAU_MAX = 5000;

export function clampMotionLpfTauMs(value: number) {
  if (!Number.isFinite(value)) return MOTION_LPF_TAU_DEFAULT;
  return Math.round(Math.max(MOTION_LPF_TAU_MIN, Math.min(MOTION_LPF_TAU_MAX, value)));
}

export function getMotionLpfTauMs(): number {
  if (typeof window === 'undefined') return MOTION_LPF_TAU_DEFAULT;
  try {
    const raw = window.localStorage.getItem(MOTION_LPF_TAU_KEY);
    if (raw !== null) {
      const stored = Number(raw);
      if (Number.isFinite(stored)) return clampMotionLpfTauMs(stored);
    }
  } catch {
    // Ignore storage failures.
  }
  return MOTION_LPF_TAU_DEFAULT;
}

export function setMotionLpfTauMs(value: number) {
  const tauMs = clampMotionLpfTauMs(value);
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MOTION_LPF_TAU_KEY, String(tauMs));
  } catch {
    // Ignore storage failures (private mode / blocked storage).
  }
  window.dispatchEvent(new CustomEvent(MOTION_LPF_TAU_EVENT, { detail: tauMs }));
}
