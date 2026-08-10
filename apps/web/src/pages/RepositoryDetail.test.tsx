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
  expect(screen.getByTestId('repository-detail').querySelector('.ambient-sigil')).toHaveAttribute('aria-hidden', 'true');
  const timeline = await screen.findByTestId('task-timeline');
  expect(within(timeline).getByText('Inspecting planner')).toBeVisible();
  expect(within(timeline).getByText('Activity output')).toBeVisible();
  await userEvent.click(screen.getByTestId('stop-task'));
  expect(within(screen.getByTestId('task-task-1')).getByTestId('task-status')).toHaveTextContent('stopped');
  expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1/stop', expect.objectContaining({ method: 'POST' }));
});

test('selects and displays the model for a new conversation', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/repositories/repo-1') return new Response(JSON.stringify({ id: 'repo-1', name: 'Planner', path: '/src/planner', defaultBranch: 'main' }));
    if (url === '/api/repositories/repo-1/status') return new Response(JSON.stringify({ branch: 'main', dirty: false, ahead: 0, behind: 0 }));
    if (url === '/api/repositories/repo-1/tasks') {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { modelId: string; prompt: string };
        return new Response(JSON.stringify({ id: 'task-new', repositoryId: 'repo-1', state: 'running',
          modelId: body.modelId, title: body.prompt, createdAt: '2026-08-07T12:00:00Z' }));
      }
      return new Response(JSON.stringify([]));
    }
    if (url === '/api/repositories/repo-1/models') return new Response(JSON.stringify([
      { id: 'gpt-test', name: 'GPT Test', vendor: 'copilot', family: 'gpt', version: '1', maxInputTokens: 1000 },
    ]));
    if (url.startsWith('/api/tasks/task-new/events')) return new Response(JSON.stringify([
      { id: 'event-1', taskId: 'task-new', sequence: 1, createdAt: '2026-08-07T12:00:01Z', type: 'turn-started',
        model: { id: 'auto', name: 'Auto', family: 'gpt-resolved' } },
    ]));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  history.pushState({}, '', '/repositories/repo-1');
  render(<App />);
  await screen.findByTestId('start-task');
  expect(screen.getByRole('option', { name: 'Auto' })).toBeVisible();
  await userEvent.selectOptions(screen.getByLabelText('Model'), 'gpt-test');
  await userEvent.type(screen.getByLabelText('Task prompt'), 'Use selected model');
  await userEvent.click(screen.getByRole('button', { name: 'Start agent' }));
  expect(await screen.findByText('Model gpt-resolved')).toBeVisible();
  const creation = fetchMock.mock.calls.find(([input, init]) => String(input) === '/api/repositories/repo-1/tasks' && init?.method === 'POST');
  expect(JSON.parse(String(creation?.[1]?.body))).toMatchObject({ prompt: 'Use selected model', modelId: 'gpt-test' });
});

test('does not apply a previously selected task lifecycle state after switching tasks', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/repositories/repo-1') return new Response(JSON.stringify({ id: 'repo-1', name: 'Planner', path: '/src/planner' }));
    if (url === '/api/repositories/repo-1/status') return new Response(JSON.stringify({ branch: 'main', dirty: false, ahead: 0, behind: 0 }));
    if (url === '/api/repositories/repo-1/models') return new Response(JSON.stringify([]));
    if (url === '/api/repositories/repo-1/tasks') return new Response(JSON.stringify([
      { id: 'task-completed', state: 'completed', initialPrompt: 'Finished task', createdAt: '2026-08-07T12:00:00Z' },
      { id: 'task-running', state: 'running', initialPrompt: 'Current task', createdAt: '2026-08-07T12:01:00Z' },
    ]));
    if (url.startsWith('/api/tasks/task-completed/events')) return new Response(JSON.stringify([
      { sequence: 1, kind: 'lifecycle', createdAt: '2026-08-07T12:00:02Z', payload: { state: 'completed' } },
    ]));
    if (url.startsWith('/api/tasks/task-running/events')) return new Response(JSON.stringify([]));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  history.pushState({}, '', '/repositories/repo-1?task=task-completed');
  render(<App />);

  await screen.findByTestId('task-task-completed');
  await userEvent.click(screen.getByTestId('history-task-running'));

  expect(await within(screen.getByTestId('task-task-running')).findByTestId('task-status')).toHaveTextContent('running');
});

test('keeps the stopping state while a stop request is pending', async () => {
  let resolveStop!: (response: Response) => void;
  const stopRequest = new Promise<Response>((resolve) => { resolveStop = resolve; });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/repositories/repo-1') return new Response(JSON.stringify({ id: 'repo-1', name: 'Planner', path: '/src/planner' }));
    if (url === '/api/repositories/repo-1/status') return new Response(JSON.stringify({ branch: 'main', dirty: false, ahead: 0, behind: 0 }));
    if (url === '/api/repositories/repo-1/models') return new Response(JSON.stringify([]));
    if (url === '/api/repositories/repo-1/tasks') return new Response(JSON.stringify([
      { id: 'task-running', state: 'running', initialPrompt: 'Current task', createdAt: '2026-08-07T12:00:00Z' },
    ]));
    if (url.startsWith('/api/tasks/task-running/events')) return new Response(JSON.stringify([
      { sequence: 1, kind: 'lifecycle', createdAt: '2026-08-07T12:00:02Z', payload: { state: 'running' } },
    ]));
    if (url === '/api/tasks/task-running/stop' && init?.method === 'POST') return stopRequest;
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);

  await screen.findByTestId('task-timeline');
  await userEvent.click(screen.getByTestId('stop-task'));

  expect(within(screen.getByTestId('task-task-running')).getByTestId('task-status')).toHaveTextContent('stopping');
  resolveStop(new Response(JSON.stringify({ id: 'task-running', state: 'stopped', createdAt: '2026-08-07T12:00:00Z' })));
  expect(await within(screen.getByTestId('task-task-running')).findByTestId('task-status')).toHaveTextContent('stopped');
});

test('keeps a follow-up draft and reports its error when delivery fails', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/repositories/repo-1') return new Response(JSON.stringify({ id: 'repo-1', name: 'Planner', path: '/src/planner' }));
    if (url === '/api/repositories/repo-1/status') return new Response(JSON.stringify({ branch: 'main', dirty: false, ahead: 0, behind: 0 }));
    if (url === '/api/repositories/repo-1/models') return new Response(JSON.stringify([]));
    if (url === '/api/repositories/repo-1/tasks') return new Response(JSON.stringify([
      { id: 'task-running', state: 'running', initialPrompt: 'Current task', createdAt: '2026-08-07T12:00:00Z' },
    ]));
    if (url.startsWith('/api/tasks/task-running/events')) return new Response(JSON.stringify([]));
    if (url === '/api/tasks/task-running/messages' && init?.method === 'POST') return new Response('Task turn cannot accept a follow-up', { status: 409 });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);

  const followUp = await screen.findByLabelText('Follow-up message');
  await userEvent.type(followUp, 'Please try the focused test again');
  await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Task turn cannot accept a follow-up');
  expect(followUp).toHaveValue('Please try the focused test again');
});
