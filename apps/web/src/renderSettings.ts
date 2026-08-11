export const SIGIL_FRAME_RATE_EVENT = 'jarvis:sigil-frame-rate-change';
const SIGIL_FRAME_RATE_KEY = 'jarvis.sigilFrameRate.fps';
export const SIGIL_FRAME_RATE_DEFAULT = 24;
export const SIGIL_FRAME_RATE_OPTIONS = [6, 12, 24, 30, 60] as const;

export function getSigilFrameRate(): number {
  if (typeof window === 'undefined') return SIGIL_FRAME_RATE_DEFAULT;
  try {
    const stored = Number(window.localStorage.getItem(SIGIL_FRAME_RATE_KEY));
    if (Number.isFinite(stored) && stored > 0) return stored;
  } catch {
    // Ignore storage failures.
  }
  return SIGIL_FRAME_RATE_DEFAULT;
}

export function setSigilFrameRate(fps: number) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIGIL_FRAME_RATE_KEY, String(fps));
  } catch {
    // Ignore storage failures (private mode / blocked storage).
  }
  window.dispatchEvent(new CustomEvent(SIGIL_FRAME_RATE_EVENT, { detail: fps }));
}
