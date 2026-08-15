// sigil.js — procedural Final Fantasy spell-sigil generator.
//
// Produces white stroked line-art on a transparent canvas, built from a
// recursive tree of primitive shapes (circle / triangle / square). The output
// is a plain HTMLCanvasElement so callers can wrap it however they like, e.g.
// `new THREE.CanvasTexture(createSigilCanvas(cfg))` for a billboard sprite.

import { makeRng } from './rng.js';

/** The primitive shapes a node can take. */
const SHAPES = ['circle', 'triangle', 'square'];

/**
 * Placement variants describing how a child sits relative to its parent:
 *  - 'inscribed'  : centered on the parent, scaled to fit inside it.
 *  - 'edge'       : pushed out toward the parent's rim, shrunk.
 *  - 'midpoint'   : placed around the half-radius ring, shrunk.
 */
const PLACEMENTS = ['inscribed', 'edge', 'midpoint'];

/** Default generation + render configuration. */
export const defaultConfig = {
  size: 512,           // output canvas edge length, in pixels (square)
  outerRadius: 0.9,    // root circle radius as a fraction of half the canvas
  maxDepth: 5,         // hard cap on tree depth (root = depth 0)
  strokeWidth: 2,      // line width in pixels
  color: '#ffffff',    // stroke color
  background: null,    // null/transparent, or a CSS color for an opaque fill
  firstLayerCount: 3,  // exact number of nodes spawned in the first layer
  stopChance: 0.35,    // 0..1 chance a node stops propagating to deeper layers
  branchiness: 0.7,    // 0..1 chance-decay knob for how many children deeper nodes spawn
  ringPeriod: 8,       // seconds per revolution of the outer ring (+ = clockwise)
  seed: 'materia',     // string or number; drives the deterministic RNG
};

/**
 * Locked-in generation parameters for the sailing-game mega-laser sigils.
 * Spread these over a random `seed` (and `size`) when minting billboards.
 */
export const gamePreset = {
  maxDepth: 5,
  firstLayerCount: 6,
  outerRadius: 0.9,
  stopChance: 0.5,
  ringPeriod: 8.0,
};

/** Pick a random element from an array using the provided RNG. */
function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** Linear interpolation between `a` and `b` by a random amount in [0,1). */
function randRange(a, b, rng) {
  return a + (b - a) * rng();
}

/**
 * Build the sigil tree.
 * Each node is `{ shape, radius, transform: {x, y, rotation}, children }`,
 * expressed in its parent's local coordinate frame (origin = parent center).
 *
 * @param {typeof defaultConfig} config
 * @param {() => number} rng
 * @returns {object} root node
 */
export function generateSigilTree(config, rng) {
  const rootRadius = (config.size / 2) * config.outerRadius;
  // Root carries the outer ring's angular velocity (rad/s). Rotating the root
  // frame orbits the whole first-layer ring about the center. Positive =
  // clockwise in canvas coords (y-down). A period of 0 disables spin.
  const rootSpin = config.ringPeriod ? (2 * Math.PI) / config.ringPeriod : 0;
  const root = {
    shape: 'circle',
    radius: rootRadius,
    transform: { x: 0, y: 0, rotation: 0 },
    spin: rootSpin,
    children: [],
  };
  growChildren(root, 1, config, rng);
  return root;
}

/**
 * Recursively populate a node's children until maxDepth or the branch-decay
 * probability runs out.
 */
function growChildren(parent, depth, config, rng) {
  if (depth >= config.maxDepth) return;

  let count;
  if (depth === 1) {
    // First layer always spawns an exact, configurable number of nodes.
    count = Math.max(0, Math.round(config.firstLayerCount));
  } else {
    // Deeper layers: the parent may stop propagating change entirely.
    if (rng() < config.stopChance) return;
    // Otherwise spawn up to 4 children, each progressively less likely.
    const decay = Math.pow(config.branchiness, depth);
    count = 0;
    for (let i = 0; i < 4; i++) if (rng() < decay) count++;
    if (count === 0) return;
  }

  for (let i = 0; i < count; i++) {
    const shape = pick(SHAPES, rng);
    const placement = pick(PLACEMENTS, rng);
    const child = makeChild(parent, shape, placement, rng);
    if (!child) continue;

    parent.children.push(child);
    growChildren(child, depth + 1, config, rng);
  }
}

/**
 * Compute a child node's radius + transform for a given placement variant,
 * all relative to the parent's center and radius.
 */
function makeChild(parent, shape, placement, rng) {
  const r = parent.radius;
  let radius;
  let dist;

  switch (placement) {
    case 'inscribed':
      // Centered, scaled to sit inside the parent.
      radius = r * randRange(0.45, 0.82, rng);
      dist = 0;
      break;
    case 'edge':
      // Pushed out to the rim, shrunk.
      radius = r * randRange(0.15, 0.35, rng);
      dist = r * randRange(0.72, 1.0, rng);
      break;
    case 'midpoint':
    default:
      // Around the half-radius ring, moderately shrunk.
      radius = r * randRange(0.22, 0.45, rng);
      dist = r * randRange(0.4, 0.58, rng);
      break;
  }

  // Skip degenerate children that would render sub-pixel.
  if (radius < 1.5) return null;

  const angle = rng() * Math.PI * 2;
  // Each layer inverts the parent's spin and scales it by a seeded [0, 2),
  // so motion alternates direction and varies speed deeper into the tree.
  const spin = -parent.spin * (rng() * 2.0);
  return {
    shape,
    radius,
    transform: {
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      rotation: rng() * Math.PI * 2,
    },
    spin,
    children: [],
  };
}

/**
 * Flatten a sigil tree into a flat list of world-space primitives.
 * Each entry is `{ shape, x, y, radius, rotation }` expressed in the root's
 * coordinate frame (origin = sigil center), ignoring per-node spin so callers
 * get a stable base pose suitable for driving their own animation. Radius
 * and position share whatever units the tree was generated in (e.g. with
 * `size: 2`, coordinates land in roughly [-1, 1], convenient for shaders).
 * @param {object} root Root node from generateSigilTree.
 * @returns {Array<{shape: string, x: number, y: number, radius: number, rotation: number}>}
 */
export function flattenSigilTree(root) {
  const out = [];
  function walk(node, parentX, parentY, parentRotation) {
    const cos = Math.cos(parentRotation);
    const sin = Math.sin(parentRotation);
    const worldX = parentX + (node.transform.x * cos - node.transform.y * sin);
    const worldY = parentY + (node.transform.x * sin + node.transform.y * cos);
    const worldRotation = parentRotation + node.transform.rotation;
    out.push({ shape: node.shape, x: worldX, y: worldY, radius: node.radius, rotation: worldRotation });
    for (const child of node.children) walk(child, worldX, worldY, worldRotation);
  }
  walk(root, 0, 0, 0);
  return out;
}

/**
 * Stroke a single primitive shape at the current origin with the given radius.
 * `radius` is treated as the circumradius for the polygons.
 */
function strokeShape(ctx, shape, radius) {
  ctx.beginPath();
  if (shape === 'circle') {
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
  } else {
    const sides = shape === 'triangle' ? 3 : 4;
    // Triangle points up; square sits as a diamond-free axis-aligned box.
    const offset = shape === 'triangle' ? -Math.PI / 2 : -Math.PI / 4;
    for (let i = 0; i < sides; i++) {
      const a = offset + (i / sides) * Math.PI * 2;
      const px = Math.cos(a) * radius;
      const py = Math.sin(a) * radius;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }
  ctx.stroke();
}

/**
 * Recursively render a node and its children in the parent's frame.
 * @param {number} time Elapsed seconds; drives each node's spin.
 */
function renderNode(ctx, node, time) {
  ctx.save();
  ctx.translate(node.transform.x, node.transform.y);
  ctx.rotate(node.transform.rotation + node.spin * time);
  strokeShape(ctx, node.shape, node.radius);
  for (const child of node.children) renderNode(ctx, child, time);
  ctx.restore();
}

/**
 * Render a sigil tree onto a canvas.
 * @param {object} tree Root node from generateSigilTree.
 * @param {typeof defaultConfig} config
 * @param {number} [time] Elapsed seconds for animation (0 = static pose).
 * @param {HTMLCanvasElement} [target] Reuse an existing canvas (e.g. to
 *   re-render every frame without allocating). A fresh canvas is made if omitted.
 * @returns {HTMLCanvasElement}
 */
export function renderSigilToCanvas(tree, config, time = 0, target = null) {
  const canvas = target || document.createElement('canvas');
  canvas.width = config.size;
  canvas.height = config.size;
  const ctx = canvas.getContext('2d');
  // Reset any transform left over from a previous frame when reusing a canvas.
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  if (config.background) {
    ctx.fillStyle = config.background;
    ctx.fillRect(0, 0, config.size, config.size);
  } else {
    ctx.clearRect(0, 0, config.size, config.size); // transparent
  }

  // Center the coordinate system; sigils are built around the origin.
  ctx.translate(config.size / 2, config.size / 2);
  ctx.strokeStyle = config.color;
  ctx.lineWidth = config.strokeWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  renderNode(ctx, tree, time);
  return canvas;
}

/**
 * Convenience: generate + render a sigil in one call.
 * @param {Partial<typeof defaultConfig>} [overrides]
 * @param {number} [time] Elapsed seconds for animation (0 = static pose).
 * @returns {HTMLCanvasElement}
 */
export function createSigilCanvas(overrides = {}, time = 0) {
  const config = { ...defaultConfig, ...overrides };
  const rng = makeRng(config.seed);
  const tree = generateSigilTree(config, rng);
  return renderSigilToCanvas(tree, config, time);
}
