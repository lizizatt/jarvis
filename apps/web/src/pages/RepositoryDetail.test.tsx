import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';

class SocketMock {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = SocketMock.CONNECTING;
  addEventListener = vi.fn();
  send = vi.fn();
}

beforeEach(() => {
  history.pushState({}, '', '/repositories/repo-1');
  vi.stubGlobal('WebSocket', SocketMock);
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => { history.pushState({}, '', '/'); vi.unstubAllGlobals(); });

test('renders structured ordered activity with raw output and optimistic stop', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/repositories/repo-1') return new Response(JSON.stringify({ repository: { id: 'repo-1', name: 'Planner', path: '/src/planner', defaultBranch: 'main' } }));
    if (url === '/api/repositories/repo-1/tasks') return new Response(JSON.stringify({ tasks: [{ id: 'task-1', repositoryId: 'repo-1', state: 'running', initialPrompt: 'Fix route selection', createdAt: '2026-08-07T12:00:00Z', startedAt: '2026-08-07T12:00:01Z' }] }));
    if (url.startsWith('/api/tasks/task-1/events')) return new Response(JSON.stringify({ events: [
      { id: 'e1', taskId: 'task-1', sequence: 1, createdAt: '2026-08-07T12:00:02Z', type: 'tool', phase: 'started', toolName: 'read_file', summary: 'Inspecting planner' },
      { id: 'e2', taskId: 'task-1', sequence: 2, createdAt: '2026-08-07T12:00:03Z', type: 'output', stream: 'stdout', text: 'raw compiler output' }
    ] }));
    if (url === '/api/tasks/task-1/stop' && init?.method === 'POST') return new Response(JSON.stringify({ id: 'task-1', repositoryId: 'repo-1', state: 'stopped', createdAt: '2026-08-07T12:00:00Z' }));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Planner' })).toBeVisible();
  const timeline = await screen.findByTestId('task-timeline');
  expect(within(timeline).getByText('Inspecting planner')).toBeVisible();
  expect(within(timeline).getByText('Raw stdout')).toBeVisible();
  await userEvent.click(screen.getByTestId('stop-task'));
  expect(within(screen.getByTestId('task-task-1')).getByTestId('task-status')).toHaveTextContent('stopped');
  expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1/stop', expect.objectContaining({ method: 'POST' }));
});
