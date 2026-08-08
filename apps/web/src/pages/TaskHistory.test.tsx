import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';

beforeEach(() => {
  history.pushState({}, '', '/repositories/repo-1/history');
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => { history.pushState({}, '', '/'); vi.unstubAllGlobals(); });

test('lists conversations, blocks deleting active ones, and deletes finished ones', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/repositories/repo-1') return new Response(JSON.stringify({ id: 'repo-1', name: 'Planner', path: '/src/planner', defaultBranch: 'main' }));
    if (url === '/api/repositories/repo-1/tasks') return new Response(JSON.stringify([
      { id: 'task-active', repositoryId: 'repo-1', state: 'running', initialPrompt: 'Still working', createdAt: '2026-08-07T12:00:00Z' },
      { id: 'task-done', repositoryId: 'repo-1', state: 'completed', initialPrompt: 'Finished conversation', createdAt: '2026-08-06T12:00:00Z' },
    ]));
    if (url === '/api/tasks/task-done' && init?.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Manage history' })).toBeVisible();
  const activeRow = await screen.findByTestId('history-row-task-active');
  expect(within(activeRow).getByTestId('delete-task-active')).toBeDisabled();

  const doneRow = screen.getByTestId('history-row-task-done');
  await userEvent.click(within(doneRow).getByTestId('delete-task-done'));
  expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-done', expect.objectContaining({ method: 'DELETE' }));
  expect(screen.queryByTestId('history-row-task-done')).not.toBeInTheDocument();
});

test('surfaces a load error instead of a false empty state', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/repositories/repo-1') return new Response(JSON.stringify({ id: 'repo-1', name: 'Planner', path: '/src/planner', defaultBranch: 'main' }));
    if (url === '/api/repositories/repo-1/tasks') return new Response('Database unavailable', { status: 500 });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);

  expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable');
  expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument();
});
