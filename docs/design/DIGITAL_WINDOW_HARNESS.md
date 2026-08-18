# Digital Window Harness

This is the repeatable visual workflow for the WebGL digital window. The reference set lives in [look-and-feel-library](look-and-feel-library), and generated captures stay under ignored `test-results/digital-window/`.

## Workflow

1. Build the web app and capture the current state:

   ```bash
   npm run build --workspace @jarvis/web
   npm run digital-window:harness -- --phase before --iteration horizon-ring-01
   ```

2. Change the owning renderer in [virtualWindowRenderer.ts](../../apps/web/src/virtualWindowRenderer.ts). Keep behavior-specific checks close to the renderer or in [horizon-debug.spec.ts](../../apps/web/e2e/horizon-debug.spec.ts).

3. Capture the result with the same iteration name:

   ```bash
   npm run digital-window:harness -- --phase after --iteration horizon-ring-01
   ```

   This captures desktop and mobile crops with Playwright and writes a manifest plus a review prompt beside them.

   The harness uses `DIGITAL_WINDOW_DEVICE_SCALE=0.75` by default. The shader's highest-quality path is expensive at the transformed desktop canvas size, and full device scale can stall Chromium before the renderer becomes ready. Override it only when investigating resolution-specific behavior. Renderer readiness is bounded to 30 seconds and logs each viewport phase; use `DIGITAL_WINDOW_RENDERER_TIMEOUT_MS` to adjust that limit for a deliberate stress run. Captures encode the WebGL canvas directly by default, avoiding the much slower full-page screenshot path; set `DIGITAL_WINDOW_CAPTURE=viewport` when the surrounding glass and page chrome are specifically under review.

4. Give the generated `review-prompt.md`, the before/after screenshots, the changed source, and every image in the look-and-feel library to a visual-review subagent. The subagent must inspect the images, verify source-backed timing claims, and return `SATISFIED` or `ITERATE` with one highest-value change.

5. For `ITERATE`, make one focused change, rerun the relevant browser check, capture another `after` set under a new iteration name, and repeat the review. Do not present the work as finished until the reviewer returns `SATISFIED`.

6. Once satisfied, present the before/after captures and the reviewer result for human feedback. Feedback starts another named iteration using the same before, edit, browser-check, after, and review cycle.

## First iteration: horizon ring

The first pass targets the ring in `haloRune`:

- outer and inner rails establish distance
- regularly spaced short and long ticks establish scale
- a narrow center channel carries the orbital marker
- the earth marker completes one longitude orbit every 600 wall-clock seconds by default

The Earth phase is derived from `Date.now()` and reduced modulo 600 seconds before it reaches WebGL, so a page reload does not reset the marker. The default acceleration is `1x`; use `?earthOrbitAcceleration=12` for a faster twelve-times demonstration. The shader uses `orbitTime * 0.0104719755`, which is $2\pi / 600$. A still capture cannot prove the full period, so the subagent must inspect the phase helper or use a browser time probe.

## Review standard

The Final Fantasy references are a mood and craft library, not a request to copy any one image. Look for ceremonial geometry, layered line weight, luminous cyan/blue/gold accents, purposeful asymmetry, and readable scale. The reviewer should reject noisy density, generic concentric rings, clipped mobile layouts, or a globe that reads as a random bright dot.

Generated captures are disposable. Commit source, the harness, documentation, and the seven reference JPEGs; do not commit `test-results/` or browser output.
