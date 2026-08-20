import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PreviewPanel } from './PreviewPanel';

function stubFetch(files: Array<{ path: string; kind: 'readme' | 'html' }>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/preview-files')) return new Response(JSON.stringify(files));
    throw new Error(`Unexpected request: ${url}`);
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

test('auto-selects a root README.md when one is available', async () => {
  stubFetch([{ path: 'README.md', kind: 'readme' }, { path: 'docs/guide.html', kind: 'html' }]);
  render(<PreviewPanel repositoryId="repo-1" repositoryName="Scratch" />);
  const frame = await screen.findByTestId('preview-frame');
  expect(frame).toHaveAttribute('src', '/previews/repo-1/repo/README.md');
  expect(frame).toHaveAttribute('sandbox', '');
});

test('falls back to the Jarvis landing page when nothing is selected', async () => {
  stubFetch([]);
  render(<PreviewPanel repositoryId="repo-1" repositoryName="Scratch" previewUrl="/previews/repo-1" />);
  const frame = await screen.findByTestId('preview-frame');
  expect(frame).toHaveAttribute('src', '/previews/repo-1');
});

test('shows an explicit empty state with no candidates and no landing page', async () => {
  stubFetch([]);
  render(<PreviewPanel repositoryId="repo-1" repositoryName="Scratch" />);
  expect(await screen.findByText('No preview available')).toBeVisible();
});

test('searches and selects a nested HTML file, overriding the auto-selected README', async () => {
  stubFetch([{ path: 'README.md', kind: 'readme' }, { path: 'docs/guide.html', kind: 'html' }]);
  render(<PreviewPanel repositoryId="repo-1" repositoryName="Scratch" />);
  await screen.findByTestId('preview-frame');

  const search = screen.getByTestId('preview-search');
  await userEvent.clear(search);
  await userEvent.type(search, 'guide');
  const results = await screen.findByTestId('preview-results');
  await userEvent.click(within(results).getByText('docs/guide.html'));

  const frame = await screen.findByTestId('preview-frame');
  expect(frame).toHaveAttribute('src', '/previews/repo-1/repo/docs/guide.html');
});
