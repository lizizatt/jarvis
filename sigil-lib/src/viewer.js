// viewer.js — harness wiring for the sigil generator.
// Regenerate sigils on demand, tweak generation live, and animate over time.

import { generateSigilTree, renderSigilToCanvas, defaultConfig } from './sigil.js';
import { makeRng, randomSeed } from './rng.js';

const display = document.getElementById('display');
const ctx = display.getContext('2d');

const seedInput = document.getElementById('seed');
const depthInput = document.getElementById('depth');
const radiusInput = document.getElementById('radius');
const firstLayerInput = document.getElementById('firstLayer');
const stopInput = document.getElementById('stop');
const periodInput = document.getElementById('period');
const depthVal = document.getElementById('depthVal');
const radiusVal = document.getElementById('radiusVal');
const firstLayerVal = document.getElementById('firstLayerVal');
const stopVal = document.getElementById('stopVal');
const periodVal = document.getElementById('periodVal');
const regenBtn = document.getElementById('regen');
const redrawBtn = document.getElementById('redraw');
const playBtn = document.getElementById('play');
const downloadLink = document.getElementById('download');

// Cached generation state: the tree is rebuilt only when a control changes,
// then re-rendered every animation frame at the current elapsed time.
let tree = null;
let config = null;
let lastSigil = null; // most recent rendered canvas (for PNG export)

// Animation clock. `elapsed` accumulates only while playing, so pausing
// freezes the pose and resuming continues smoothly.
let playing = true;
let elapsed = 0;
let lastNow = performance.now();

/** Read the current control values into a sigil config. */
function currentConfig() {
  return {
    ...defaultConfig,
    size: display.width,
    seed: seedInput.value || 'materia',
    maxDepth: Number(depthInput.value),
    outerRadius: Number(radiusInput.value),
    firstLayerCount: Number(firstLayerInput.value),
    stopChance: Number(stopInput.value),
    ringPeriod: Number(periodInput.value),
  };
}

/** Rebuild the tree from the current controls (after any control change). */
function rebuild() {
  depthVal.textContent = depthInput.value;
  radiusVal.textContent = Number(radiusInput.value).toFixed(2);
  firstLayerVal.textContent = firstLayerInput.value;
  stopVal.textContent = Number(stopInput.value).toFixed(2);
  periodVal.textContent = Number(periodInput.value).toFixed(1);

  config = currentConfig();
  tree = generateSigilTree(config, makeRng(config.seed));
}

/** Render the cached tree at the current elapsed time onto the display. */
function render() {
  lastSigil = renderSigilToCanvas(tree, config, elapsed);
  ctx.clearRect(0, 0, display.width, display.height);
  ctx.drawImage(lastSigil, 0, 0, display.width, display.height);
}

/** Animation loop: advance the clock while playing and re-render. */
function frame(now) {
  const dt = (now - lastNow) / 1000;
  lastNow = now;
  if (playing) {
    elapsed += dt;
    render();
  }
  requestAnimationFrame(frame);
}

// Regenerate: pick a brand-new seed, then rebuild.
regenBtn.addEventListener('click', () => {
  seedInput.value = randomSeed();
  rebuild();
  render();
});

// Redraw: keep the seed, rebuild with the current controls.
redrawBtn.addEventListener('click', () => {
  rebuild();
  render();
});

// Play / Pause toggle.
playBtn.addEventListener('click', () => {
  playing = !playing;
  playBtn.textContent = playing ? 'Pause' : 'Play';
});

// Live updates for typing a seed and dragging sliders.
for (const el of [seedInput, depthInput, radiusInput, firstLayerInput, stopInput, periodInput]) {
  el.addEventListener('input', () => {
    rebuild();
    render();
  });
}

// Refresh the PNG export href just before the user downloads it (the live
// canvas changes every frame, so capture it lazily on click).
downloadLink.addEventListener('mousedown', () => {
  if (lastSigil) downloadLink.href = lastSigil.toDataURL('image/png');
});

// Initial build + start the animation loop.
rebuild();
render();
requestAnimationFrame(frame);
