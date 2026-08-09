# Virtual Window Background Plan

## Vision Capture

Build a **background-only renderer** for `apps/web` that keeps all existing UI layout and interaction unchanged.

Target experience:

- Render a full-screen “digital window” scene behind current panes/cards.
- Scene base is a high-resolution star panorama from Earth perspective.
- Overlay animated sigils in transparent, bloomy red.
- On devices with motion sensors (for example iPhone), parallax/rotation responds to device orientation.
- On unsupported or denied sensors, fall back to a subtle autonomous motion loop.

Non-goals:

- No changes to existing page structure, navigation, or panel behavior.
- No disruption to current readability/contrast contracts.

## Current Frontend Baseline

Observed in `apps/web`:

- Existing ambient background is `AmbientSigil` (`src/components/Sigil.tsx`) and CSS positioning in `src/styles.css`.
- Pages place ambient visual elements at low z-order (`.page > :not(.ambient-sigil)` remains foreground).
- Dashboard test coverage already checks sigil presence (`src/pages/Dashboard.test.tsx`).

This makes a background renderer feasible as a drop-in replacement layer with stable UI contracts.

## Feasibility Study (Brief)

### 1) Motion/Accelerometer Input

Feasibility: **High with guarded fallback**.

- Browser API path: `DeviceOrientationEvent` (`alpha`, `beta`, `gamma`).
- iOS Safari requires:
  - HTTPS context.
  - User gesture + `DeviceOrientationEvent.requestPermission()`.
- Desktop and restricted browsers may provide no sensor data.

Plan impact:

- Add a permission gate state machine.
- Keep rendering active without sensors (time-based drift).
- Respect reduced-motion preferences.

### 2) Rendering Strategy

Feasibility: **High**.

- Option A (recommended first): CSS 3D transforms + layered `<div>/<canvas>` backgrounds.
- Option B (phase 2): WebGL (three.js) for richer depth and bloom.

Given “UI unchanged,” Option A minimizes risk and integration cost.

### 3) Star Panorama Asset

Feasibility: **Medium**, mainly asset sourcing.

- Need a 4K equirectangular star panorama with usage rights compatible with repository policy.
- Must avoid unclear copyright/licensing.

Plan impact:

- Use a public-domain or clearly permissive asset (for example NASA/ESO sources with explicit terms).
- Store attribution and license note under `docs/design/` or asset metadata.

### 4) Sigil Overlay from `../scratch/`

Feasibility: **Medium** pending transfer method.

- Task requests using a copy of sigil library from `../scratch/`.
- Work must remain inside this repository checkout.

Plan impact:

- Import the sigil code by copying approved files into `apps/web/src/components/background/`.
- Record provenance and any required license headers.
- Adapt rendering output to transparent red + bloom blend.

### 5) Performance and Battery

Feasibility: **Medium-High** with constraints.

- Continuous animation + sensor updates can impact mobile battery.
- Existing UI already uses blur/backdrop effects; background must not increase jank.

Plan impact:

- Clamp frame rate dynamically (for example 30 FPS on mobile).
- Pause or reduce effects on hidden tabs.
- Limit blur radius and number of animated sigil layers.

## Proposed Implementation Phases

1. **Phase 0: Design Spike**
   - Build isolated `VirtualWindowBackground` component behind existing pages.
   - Time-based parallax only.
2. **Phase 1: Motion Input**
   - Add permission UX affordance and orientation-driven transforms.
3. **Phase 2: Sigil Integration**
   - Integrate copied sigil library output and red bloom compositing.
4. **Phase 3: Asset + Tuning**
   - Add licensed 4K star pano and optimize performance/readability.
5. **Phase 4: Validation**
   - Mobile Safari/Chrome checks, reduced-motion behavior, and visual contrast pass.

## Risks

- iOS permission friction may reduce adoption of motion mode.
- Unclear panorama licensing can block merge.
- Over-strong bloom may reduce text legibility.
- Motion sickness risk if rotation is too sensitive.

## Acceptance Criteria (Planning Draft)

- Existing UI layout and interaction snapshots remain unchanged.
- Background renders on all supported browsers with graceful fallback.
- Motion reacts to orientation where permitted.
- Sigils render as transparent red with restrained bloom.
- Performance remains smooth on modern phones (no obvious scrolling/input lag).
- All new assets have explicit usage rights documented.

## Initial Validation Plan

For docs-only planning change: inspect diff for accuracy and scope.

For upcoming implementation work in `apps/web`:

- `npm test --workspace @jarvis/web`
- Then full gate before handoff:
  - `npm run lint`
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
