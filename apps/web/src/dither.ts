// Ordered-dither (Bayer 4x4) sparkline texture with static single-hue paint,
// no animation, canvas contexts, or extra dependencies.
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
].map((row) => row.map((v) => (v + 0.5) / 16));

function resample(values: number[], cols: number): number[] {
  const out = new Array<number>(cols);
  const last = Math.max(values.length - 1, 1);
  for (let c = 0; c < cols; c++) {
    const t = (c / Math.max(cols - 1, 1)) * last;
    const i = Math.floor(t);
    const f = t - i;
    const a = values[i] ?? 0;
    const b = values[Math.min(i + 1, values.length - 1)] ?? a;
    out[c] = a + (b - a) * f;
  }
  return out;
}

export interface DitherPaintOptions {
  /** Backing px per dither cell; higher reads more chunky/pixelated. */
  cell?: number;
  /** Value that maps to the top of the chart. */
  max?: number;
}

/** Paints a static ordered-dither fill under the series, capped with a bright edge line. */
export function paintDitheredSeries(canvas: HTMLCanvasElement, values: number[], rgb: readonly [number, number, number], options: DitherPaintOptions = {}): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const cell = options.cell ?? 2;
  const max = options.max ?? 100;
  const width = canvas.clientWidth || 1;
  const height = canvas.clientHeight || 1;
  const cols = Math.max(4, Math.round(width / cell));
  const rows = Math.max(4, Math.round(height / cell));
  canvas.width = cols;
  canvas.height = rows;
  ctx.clearRect(0, 0, cols, rows);
  if (values.length < 2) return;
  const series = resample(values, cols);
  const [r, g, b] = rgb;
  const color = (alpha: number) => `rgba(${r},${g},${b},${alpha})`;
  for (let x = 0; x < cols; x++) {
    const ratio = Math.max(0, Math.min(1, series[x] / max));
    const top = Math.round((1 - ratio) * (rows - 1));
    const depth = rows - top;
    for (let y = top; y < rows; y++) {
      const density = (y - top) / Math.max(depth, 1);
      const lit = density > BAYER[y & 3][x & 3] - 0.12;
      ctx.fillStyle = color(lit ? 0.28 + density * 0.55 : 0.08);
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.fillStyle = color(0.95);
    ctx.fillRect(x, top, 1, 1);
  }
}
