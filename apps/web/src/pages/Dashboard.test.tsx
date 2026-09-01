import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';

beforeEach(() => { vi.stubGlobal('confirm', vi.fn(() => true)); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
  expect(screen.getByTestId('dashboard').querySelector('.ambient-sigil')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.getByText('feature/routing')).toBeVisible();
  expect(screen.getByText('Modified')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Stop task in Flight controls' }));
  expect(screen.getByText('Stopping')).toBeVisible();
  expect(fetchMock).toHaveBeenLastCalledWith('/api/tasks/task-1/stop', expect.objectContaining({ method: 'POST' }));
});

test('shows Pull for a clean repository and reports success', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/repositories') return Promise.resolve(new Response(JSON.stringify([{ id: 'repo-1', name: 'Flight controls', path: '/src/flight', copilotActive: true }])));
    if (url === '/api/repositories/repo-1/status') return Promise.resolve(new Response(JSON.stringify({ branch: 'main', dirty: false, clean: true, ahead: 0, behind: 0 })));
    if (url === '/api/repositories/repo-1/pull' && init?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ ok: true, branch: 'main', message: 'Already up to date.' })));
    return Promise.resolve(new Response('{}'));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(await screen.findByText('Flight controls')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Pull' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Pulled main from origin');
  expect(fetchMock).toHaveBeenCalledWith('/api/repositories/repo-1/pull', expect.objectContaining({ method: 'POST' }));
});

test('shows Start Copilot instead of Pull when the repository worker is inactive', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/repositories') return Promise.resolve(new Response(JSON.stringify([{ id: 'repo-1', name: 'Flight controls', path: '/src/flight', copilotActive: false }])));
    if (url === '/api/repositories/repo-1/status') return Promise.resolve(new Response(JSON.stringify({ branch: 'main', dirty: false, clean: true, ahead: 0, behind: 0 })));
    if (url === '/api/repositories/repo-1/copilot' && init?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({ started: true, active: false }), { status: 202 }));
    return Promise.resolve(new Response('{}'));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(await screen.findByRole('button', { name: 'Start Copilot' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Pull' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Start Copilot' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Opening Copilot in VS Code');
  expect(fetchMock).toHaveBeenCalledWith('/api/repositories/repo-1/copilot', expect.objectContaining({ method: 'POST' }));
});

test('keeps repository registration on the server', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([])));
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(await screen.findByText('No checkouts configured')).toBeVisible();
  expect(screen.getByText('Register repositories from the Jarvis server.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Settings' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /register/i })).not.toBeInTheDocument();
});

test('space view toggle hides the repository list without navigating away', async () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify([{ id: 'repo-1', name: 'Flight controls', path: '/src/flight' }]))));
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(await screen.findByText('Flight controls')).toBeVisible();
  const toggle = screen.getByRole('button', { name: 'Space view' });
  expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByText('Flight controls')).not.toBeInTheDocument();

  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await screen.findByText('Flight controls')).toBeVisible();
});

test('keeps repositories visible and pauses polling while the tab is hidden', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let resolveRefresh!: (response: Response) => void;
  let repositoryRequests = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input) !== '/api/repositories') return Promise.resolve(new Response('{}'));
    repositoryRequests += 1;
    if (repositoryRequests === 1) return Promise.resolve(new Response(JSON.stringify([{ id: 'repo-1', name: 'Flight controls', path: '/src/flight' }])));
    return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(await screen.findByText('Flight controls')).toBeVisible();

  await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve(); });

  expect(repositoryRequests).toBe(2);
  expect(screen.getByText('Flight controls')).toBeVisible();
  expect(screen.queryByText('Loading repositories…')).not.toBeInTheDocument();
  resolveRefresh(new Response(JSON.stringify([{ id: 'repo-1', name: 'Flight controls', path: '/src/flight' }])));
  await act(async () => {});

  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve(); });
  expect(repositoryRequests).toBe(2);

  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });
  expect(repositoryRequests).toBe(3);
});
