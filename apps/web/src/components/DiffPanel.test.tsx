import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiffPanel } from './DiffPanel';

function stubFetch(handlers: { diff?: string; statusFiles?: Array<{ status: string; path: string }> }) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/pull-request')) return new Response(JSON.stringify({ available: false }));
    if (url.includes('/status-files')) return new Response(JSON.stringify(handlers.statusFiles ?? []));
    if (url.includes('/diff')) return new Response(handlers.diff ?? '');
    throw new Error(`Unexpected request: ${url}`);
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

test('shows the worktree diff by default', async () => {
  stubFetch({ diff: 'diff --git a/file.ts b/file.ts\n+added line\n' });
  render(<DiffPanel repositoryId="repo-1" />);
  const diff = await screen.findByTestId('repository-diff');
  expect(within(diff).getByText('+added line')).toBeVisible();
});

test('lists untracked and modified files on the Files tab, including files a diff would omit', async () => {
  stubFetch({ diff: '', statusFiles: [{ status: '??', path: 'untracked.txt' }, { status: ' M', path: 'tracked.txt' }] });
  render(<DiffPanel repositoryId="repo-1" />);
  await screen.findByTestId('repository-diff');
  await userEvent.click(screen.getByRole('button', { name: 'Files' }));
  const files = await screen.findByTestId('repository-status-files');
  expect(within(files).getByText('untracked.txt')).toBeVisible();
  expect(within(files).getByText('Untracked')).toBeVisible();
  expect(within(files).getByText('tracked.txt')).toBeVisible();
  expect(within(files).getByText('Modified')).toBeVisible();
});

test('shows an explicit empty state when the Files tab has no changes', async () => {
  stubFetch({ diff: '', statusFiles: [] });
  render(<DiffPanel repositoryId="repo-1" />);
  await userEvent.click(screen.getByRole('button', { name: 'Files' }));
  const files = await screen.findByTestId('repository-status-files');
  expect(within(files).getByText('No changes in this view.')).toBeVisible();
});
