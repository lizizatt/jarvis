import '@testing-library/jest-dom/vitest';

HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
	fillStyle: '#000000',
	fillRect: vi.fn(),
	getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }))
})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
