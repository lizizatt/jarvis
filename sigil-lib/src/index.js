// index.js — public entry point for consumers importing "sigil-lib".
export {
  defaultConfig,
  gamePreset,
  generateSigilTree,
  renderSigilToCanvas,
  createSigilCanvas,
  flattenSigilTree,
} from './sigil.js';
export { makeRng, hashSeed, randomSeed } from './rng.js';
export { renderSigilAtlas } from './atlas.js';
