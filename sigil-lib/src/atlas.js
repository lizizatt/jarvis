// atlas.js — bakes a strip of procedurally generated sigil base-shapes into
// a single canvas so GPU shaders (e.g. the virtual-window renderer) can
// sample a variety of tree-generated silhouettes without running canvas
// generation per-frame or per-instance.
//
// Each cell renders one `generateSigilTree` pose (time = 0, static) as white
// stroked line-art on transparent black, matching `renderSigilToCanvas`'s
// output convention. Cells are laid out left-to-right in a single row so a
// shader can index cell `i` of `count` via `u = (i + fract(localU)) / count`.

import { defaultConfig, generateSigilTree, renderSigilToCanvas } from './sigil.js';
import { makeRng } from './rng.js';

/**
 * Render `count` distinct procedural sigil base-shapes into one atlas canvas.
 * @param {object} [options]
 * @param {number} [options.count] Number of variants to bake (atlas columns).
 * @param {number} [options.cellSize] Pixel edge length of each square cell.
 * @param {string} [options.seedPrefix] Prefix combined with the column index
 *   to derive each variant's deterministic seed.
 * @param {Partial<typeof defaultConfig>} [options.treeConfig] Overrides
 *   merged with `defaultConfig` for every baked variant (e.g. maxDepth,
 *   firstLayerCount, stopChance, strokeWidth).
 * @returns {{ canvas: HTMLCanvasElement, count: number, cellSize: number }}
 */
export function renderSigilAtlas(options = {}) {
  const count = Math.max(1, Math.round(options.count ?? 8));
  const cellSize = Math.max(16, Math.round(options.cellSize ?? 256));
  const seedPrefix = options.seedPrefix ?? 'atlas';
  const treeConfig = options.treeConfig ?? {};

  const canvas = document.createElement('canvas');
  canvas.width = cellSize * count;
  canvas.height = cellSize;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < count; i++) {
    const config = {
      ...defaultConfig,
      ...treeConfig,
      size: cellSize,
      seed: `${seedPrefix}-${i}`,
      ringPeriod: 0,
    };
    const rng = makeRng(config.seed);
    const tree = generateSigilTree(config, rng);
    const cell = renderSigilToCanvas(tree, config, 0);
    ctx.drawImage(cell, i * cellSize, 0);
  }

  return { canvas, count, cellSize };
}
