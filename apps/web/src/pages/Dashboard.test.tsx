import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';

beforeEach(() => { vi.stubGlobal('confirm', vi.fn(() => true)); });
afterEach(() => { vi.unstubAllGlobals(); });

test('shows repository state and immediately marks a stopped task as stopping', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/repositories') return Promise.resolve(new Response(JSON.stringify([{ id: 'repo-1', name: 'Flight controls', path: '/src/flight', activeTask: { id: 'task-1', state: 'running', latestAction: 'Running unit tests', createdAt: new Date().toISOString() } }])));
    if (url === '/api/repositories/repo-1/status') return Promise.resolve(new Response(JSON.stringify({ branch: 'feature/routing', dirty: true, ahead: 2, behind: 1 })));
    if (url === '/api/tasks/task-1/stop' && init?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ id: 'task-1', state: 'stopped', createdAt: new Date().toISOString() })));
    return Promise.resolve(new Response('{}'));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(await screen.findByText('Flight controls')).toBeVisible();
  expect(screen.getByText('feature/routing')).toBeVisible();
  expect(screen.getByText('Modified')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Stop task in Flight controls' }));
  expect(screen.getByText('Stopping')).toBeVisible();
  expect(fetchMock).toHaveBeenLastCalledWith('/api/tasks/task-1/stop', expect.objectContaining({ method: 'POST' }));
});

test('keeps repository registration on the server', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([])));
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(await screen.findByText('No checkouts configured')).toBeVisible();
  expect(screen.getByText('Register repositories from the Jarvis server.')).toBeVisible();
  expect(screen.queryByRole('button', { name: /register/i })).not.toBeInTheDocument();
});
