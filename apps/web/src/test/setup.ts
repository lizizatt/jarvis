import '@testing-library/jest-dom/vitest';

HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
	fillStyle: '#000000',
	globalCompositeOperation: 'source-over',
	fillRect: vi.fn(),
	clearRect: vi.fn(),
	beginPath: vi.fn(),
	arc: vi.fn(),
	fill: vi.fn(),
	createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
	createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
	getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }))
})) as unknown as typeof HTMLCanvasElement.prototype.getContext;

HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,') as unknown as typeof HTMLCanvasElement.prototype.toDataURL;

Object.defineProperty(window, 'matchMedia', {
	writable: true,
	value: vi.fn().mockImplementation((query: string) => ({
		matches: query === '(prefers-reduced-motion: reduce)' ? false : false,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn()
	}))
});

globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;
