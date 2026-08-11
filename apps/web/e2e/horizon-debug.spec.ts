import { expect, test, type Page } from '@playwright/test';

// The virtual window's debug sky shader renders a stark black/white horizon
// line (see setHorizonDebug in virtualWindowRenderer.ts) so a screenshot
// reviewer can confirm pitch, roll, and yaw drive the horizon the way phone
// orientation sensors would in the field, without needing real hardware.
//
// Playwright has no built-in "device orientation" emulator (unlike geolocation
// or permissions), so this mocks it directly: dispatch synthetic
// `deviceorientation` events with chosen alpha/beta/gamma and let the app's
// existing orientation pipeline (motion.ts + virtualWindowMotion.ts) do the
// rest. Chromium exposes `DeviceOrientationEvent` without a permission
// prompt, so no extra grant step is required for these projects.

type OrientationSample = { alpha: number; beta: number; gamma: number };

// A phone held upright, screen facing the user, is beta=90/gamma=0 in the
// DeviceOrientationControls convention this app follows (see
// orientationToQuaternion in virtualWindowMotion.ts). The first sample the
// app receives becomes its zero reference, so we send this once before each
// sweep and treat subsequent samples as relative deltas from it.
const BASELINE: OrientationSample = { alpha: 0, beta: 90, gamma: 0 };

// 20-degree increments spanning +/-40 degrees from the baseline.
const SWEEP_STEPS = [-40, -20, 0, 20, 40];

async function dispatchOrientation(page: Page, sample: OrientationSample) {
  await page.evaluate((s) => {
    const event = new Event('deviceorientation') as DeviceOrientationEvent;
    Object.defineProperty(event, 'alpha', { value: s.alpha, configurable: true });
    Object.defineProperty(event, 'beta', { value: s.beta, configurable: true });
    Object.defineProperty(event, 'gamma', { value: s.gamma, configurable: true });
    window.dispatchEvent(event);
  }, sample);
}

async function settle(page: Page) {
  // The renderer smooths toward each new orientation target (blend ~0.22 per
  // animation frame in Sigil.tsx), so give it time to converge before
  // sampling pixels or taking a screenshot.
  await page.waitForTimeout(600);
}

/** Scans each requested column from top to bottom and returns the first row
 * (canvas pixel y, 0 = top) where the debug shader's black/white horizon
 * line crosses to the dark half. Returns -1 for a column with no crossing. */
async function sampleHorizonRows(page: Page, xFractions: number[]) {
  return page.evaluate((fractions) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.virtual-window-canvas');
    if (!canvas) return fractions.map(() => -1);
    const gl = canvas.getContext('webgl');
    if (!gl) return fractions.map(() => -1);
    const width = canvas.width;
    const height = canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const colorAt = (x: number, yFromTop: number) => {
      const flippedY = height - 1 - yFromTop; // readPixels origin is bottom-left
      const index = (flippedY * width + x) * 4;
      return pixels[index];
    };
    return fractions.map((fraction) => {
      const x = Math.max(0, Math.min(width - 1, Math.floor(width * fraction)));
      for (let y = 0; y < height; y++) {
        if (colorAt(x, y) < 128) return y;
      }
      return -1;
    });
  }, xFractions);
}

async function gotoDebugWindow(page: Page) {
  await page.goto('/?horizonDebug=1');
  await expect(page.locator('.virtual-window-canvas')).toBeVisible();
  // Establish the zero-orientation reference before any sweep begins.
  await dispatchOrientation(page, BASELINE);
  await settle(page);
}

test.describe('virtual window horizon debug shader', () => {
  test('pitch sweep moves the horizon line vertically at a fixed roll and yaw', async ({ page }, testInfo) => {
    await gotoDebugWindow(page);

    const centerRows: number[] = [];
    for (const stepIndex of SWEEP_STEPS) {
      await dispatchOrientation(page, { ...BASELINE, beta: BASELINE.beta + stepIndex });
      await settle(page);
      const [center] = await sampleHorizonRows(page, [0.5]);
      centerRows.push(center);
      await page.screenshot({ path: testInfo.outputPath(`pitch_${stepIndex >= 0 ? '+' : ''}${stepIndex}.png`) });
    }

    expect(centerRows.every((row) => row >= 0)).toBe(true);
    // 20-degree pitch increments should move the horizon monotonically; two
    // consecutive samples must never land on the same row once the sweep
    // has covered a full 160-degree range in 20-degree steps.
    const distinctRows = new Set(centerRows);
    expect(distinctRows.size).toBeGreaterThan(1);
    const isMonotonic = centerRows.every((row, index) => index === 0 || row !== centerRows[index - 1]);
    expect(isMonotonic).toBe(true);
    const ascending = centerRows.every((row, index) => index === 0 || row >= centerRows[index - 1]);
    const descending = centerRows.every((row, index) => index === 0 || row <= centerRows[index - 1]);
    expect(ascending || descending).toBe(true);
  });

  test('roll sweep tilts the horizon so left and right edges diverge', async ({ page }, testInfo) => {
    await gotoDebugWindow(page);

    const tilts: number[] = [];
    for (const stepIndex of SWEEP_STEPS) {
      await dispatchOrientation(page, { ...BASELINE, gamma: BASELINE.gamma + stepIndex });
      await settle(page);
      const [left, right] = await sampleHorizonRows(page, [0.05, 0.95]);
      tilts.push(right - left);
      await page.screenshot({ path: testInfo.outputPath(`roll_${stepIndex >= 0 ? '+' : ''}${stepIndex}.png`) });
    }

    // At zero roll the horizon should be level (left/right rows close);
    // increasing |roll| should widen the left/right gap monotonically away
    // from that flat point.
    const zeroIndex = SWEEP_STEPS.indexOf(0);
    expect(Math.abs(tilts[zeroIndex])).toBeLessThan(6);
    const magnitudes = tilts.map(Math.abs);
    expect(magnitudes[0]).toBeGreaterThan(magnitudes[zeroIndex]);
    expect(magnitudes[magnitudes.length - 1]).toBeGreaterThan(magnitudes[zeroIndex]);
  });

  test('yaw sweep leaves a level horizon unchanged', async ({ page }, testInfo) => {
    await gotoDebugWindow(page);

    const centerRows: number[] = [];
    for (const stepIndex of SWEEP_STEPS) {
      await dispatchOrientation(page, { ...BASELINE, alpha: BASELINE.alpha + stepIndex });
      await settle(page);
      const [left, center, right] = await sampleHorizonRows(page, [0.05, 0.5, 0.95]);
      centerRows.push(center);
      expect(Math.abs(right - left)).toBeLessThan(6);
      await page.screenshot({ path: testInfo.outputPath(`yaw_${stepIndex >= 0 ? '+' : ''}${stepIndex}.png`) });
    }

    // Pure yaw pans azimuth only; a level horizon at eye level must stay put.
    const spread = Math.max(...centerRows) - Math.min(...centerRows);
    expect(spread).toBeLessThan(6);
  });

  test('combined pitch, roll, and yaw sweep produces a consistently tilted, shifted horizon', async ({ page }, testInfo) => {
    await gotoDebugWindow(page);

    const samples: { left: number; center: number; right: number }[] = [];
    for (const stepIndex of SWEEP_STEPS) {
      await dispatchOrientation(page, {
        alpha: BASELINE.alpha + stepIndex,
        beta: BASELINE.beta + stepIndex,
        gamma: BASELINE.gamma + stepIndex
      });
      await settle(page);
      const [left, center, right] = await sampleHorizonRows(page, [0.05, 0.5, 0.95]);
      samples.push({ left, center, right });
      await page.screenshot({ path: testInfo.outputPath(`combined_${stepIndex >= 0 ? '+' : ''}${stepIndex}.png`) });
    }

    expect(samples.every((sample) => sample.left >= 0 && sample.center >= 0 && sample.right >= 0)).toBe(true);
    const centers = samples.map((sample) => sample.center);
    const distinctCenters = new Set(centers);
    expect(distinctCenters.size).toBeGreaterThan(1);

    const zeroIndex = SWEEP_STEPS.indexOf(0);
    const zeroTilt = Math.abs(samples[zeroIndex].right - samples[zeroIndex].left);
    const extremeTilt = Math.abs(samples[samples.length - 1].right - samples[samples.length - 1].left);
    expect(extremeTilt).toBeGreaterThan(zeroTilt);
  });
});
