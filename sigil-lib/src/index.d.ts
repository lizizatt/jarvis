export interface SigilTreeConfig {
  size?: number;
  seed?: string | number;
  maxDepth?: number;
  firstLayerCount?: number;
  stopChance?: number;
  strokeWidth?: number;
  ringPeriod?: number;
  [key: string]: unknown;
}

export const defaultConfig: SigilTreeConfig;
export const gamePreset: SigilTreeConfig;

export function generateSigilTree(config: SigilTreeConfig, rng: () => number): unknown;
export function flattenSigilTree(tree: unknown): unknown[];
export function renderSigilToCanvas(tree: unknown, config: SigilTreeConfig, time?: number): HTMLCanvasElement;
export function createSigilCanvas(config?: SigilTreeConfig): HTMLCanvasElement;

export function makeRng(seed: string | number): () => number;
export function hashSeed(seed: string | number): number;
export function randomSeed(): string;

export interface SigilAtlasOptions {
  count?: number;
  cellSize?: number;
  seedPrefix?: string;
  treeConfig?: Partial<SigilTreeConfig>;
}

export interface SigilAtlas {
  canvas: HTMLCanvasElement;
  count: number;
  cellSize: number;
}

export function renderSigilAtlas(options?: SigilAtlasOptions): SigilAtlas;
