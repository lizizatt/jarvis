export const FROST_BLUR_EVENT = 'jarvis:frost-blur-change';
const FROST_BLUR_KEY = 'jarvis.frostBlur.px';
export const FROST_BLUR_DEFAULT = 8;
export const FROST_BLUR_MAX = 20;

export function getFrostBlur(): number {
  if (typeof window === 'undefined') return FROST_BLUR_DEFAULT;
  try {
    const raw = window.localStorage.getItem(FROST_BLUR_KEY);
    if (raw === null) return FROST_BLUR_DEFAULT;
    const stored = Number(raw);
    if (Number.isFinite(stored) && stored >= 0 && stored <= FROST_BLUR_MAX) return stored;
  } catch {
    // Ignore storage failures.
  }
  return FROST_BLUR_DEFAULT;
}

function applyFrostBlur(px: number) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--panel-blur', `${px}px`);
}

export function setFrostBlur(px: number) {
  applyFrostBlur(px);
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FROST_BLUR_KEY, String(px));
  } catch {
    // Ignore storage failures (private mode / blocked storage).
  }
  window.dispatchEvent(new CustomEvent(FROST_BLUR_EVENT, { detail: px }));
}

// Sync the CSS variable as soon as this module loads, so cards look right on
// every route even before the settings menu (which owns the slider) mounts.
applyFrostBlur(getFrostBlur());
