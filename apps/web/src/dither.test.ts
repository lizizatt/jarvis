import { paintDitheredSeries } from './dither';

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: height, configurable: true });
  return canvas;
}

test('sizes the backing canvas from its cell size and clears it when data is too short', () => {
  const canvas = makeCanvas(60, 20);
  paintDitheredSeries(canvas, [50], [239, 189, 73], { cell: 2 });
  expect(canvas.width).toBe(30);
  expect(canvas.height).toBe(10);
});

test('paints a column per resampled value without throwing', () => {
  const canvas = makeCanvas(60, 20);
  expect(() => paintDitheredSeries(canvas, [0, 50, 100, 20], [239, 189, 73], { cell: 2 })).not.toThrow();
});
