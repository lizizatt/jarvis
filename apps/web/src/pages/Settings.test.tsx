import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';

beforeEach(() => { history.pushState({}, '', '/settings'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('persists across a reload by reading live Tailscale Serve state', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/deployments') return Promise.resolve(new Response(JSON.stringify([])));
    if (String(input) === '/api/settings/port-forwards' && (!init || init.method === undefined)) {
      return Promise.resolve(new Response(JSON.stringify([{ port: 8080, url: 'https://jarvis.example.ts.net:8080/' }])));
    }
    return Promise.resolve(new Response('{}'));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);

  expect(await screen.findByRole('link', { name: /jarvis\.example\.ts\.net:8080/ })).toHaveAttribute('href', 'https://jarvis.example.ts.net:8080/');
});

test('exposes a local port and presents the Tailnet link', async () => {
  let exposed = false;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/deployments') return Promise.resolve(new Response(JSON.stringify([])));
    if (String(input) === '/api/settings/port-forwards' && init?.method === 'POST') {
      exposed = true;
      return Promise.resolve(new Response(JSON.stringify({ port: 8080, url: 'https://jarvis.example.ts.net:8080/' })));
    }
    if (String(input) === '/api/settings/port-forwards' && (!init || init.method === undefined)) {
      return Promise.resolve(new Response(JSON.stringify(exposed ? [{ port: 8080, url: 'https://jarvis.example.ts.net:8080/' }] : [])));
    }
    return Promise.resolve(new Response('{}'));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);

  await userEvent.click(await screen.findByRole('button', { name: 'Expose port' }));

  expect(fetchMock).toHaveBeenCalledWith('/api/settings/port-forwards', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ port: 8080 }),
  }));
  expect(await screen.findByRole('link', { name: /jarvis\.example\.ts\.net:8080/ })).toHaveAttribute('href', 'https://jarvis.example.ts.net:8080/');
});

test('stops sharing a previously exposed port', async () => {
  let exposed = true;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/deployments') return Promise.resolve(new Response(JSON.stringify([])));
    if (String(input) === '/api/settings/port-forwards/8080' && init?.method === 'DELETE') {
      exposed = false;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (String(input) === '/api/settings/port-forwards' && (!init || init.method === undefined)) {
      return Promise.resolve(new Response(JSON.stringify(exposed ? [{ port: 8080, url: 'https://jarvis.example.ts.net:8080/' }] : [])));
    }
    return Promise.resolve(new Response('{}'));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);

  await userEvent.click(await screen.findByRole('button', { name: 'Stop sharing' }));

  expect(fetchMock).toHaveBeenCalledWith('/api/settings/port-forwards/8080', expect.objectContaining({ method: 'DELETE' }));
  expect(screen.queryByRole('link', { name: /jarvis\.example\.ts\.net:8080/ })).not.toBeInTheDocument();
});

test('starts and restarts managed deployments while protecting Jarvis', async () => {
  const confirmMock = vi.fn(() => true);
  vi.stubGlobal('confirm', confirmMock);
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/deployments' && (!init || init.method === undefined)) {
      return Promise.resolve(new Response(JSON.stringify([
        { id: 'alesis', name: 'Alesis', kind: 'managed', state: 'stopped', enabled: true, healthy: null, homeUrl: 'https://jarvis.example.ts.net:8787/', actions: ['start', 'stop', 'restart'] },
        { id: 'jarvis', name: 'Jarvis', kind: 'self', state: 'running', enabled: true, healthy: true, actions: ['restart'], warning: 'This might get weird.' },
      ])));
    }
    if (String(input).endsWith('/actions') && init?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({ accepted: true, scheduled: false })));
    }
    if (String(input) === '/api/settings/port-forwards') return Promise.resolve(new Response(JSON.stringify([])));
    return Promise.resolve(new Response('{}'));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);

  await userEvent.click(await screen.findByRole('switch', { name: 'Start Alesis' }));
  expect(screen.getByRole('link', { name: 'Open Alesis' })).toHaveAttribute('href', 'https://jarvis.example.ts.net:8787/');
  expect(fetchMock).toHaveBeenCalledWith('/api/deployments/alesis/actions', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ action: 'start' }),
  }));

  await userEvent.click(screen.getByRole('button', { name: 'Restart Jarvis' }));
  expect(confirmMock).toHaveBeenCalledWith('This might get weird.');
  expect(fetchMock).toHaveBeenCalledWith('/api/deployments/jarvis/actions', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ action: 'restart' }),
  }));
  expect(screen.queryByRole('switch', { name: /Jarvis/ })).not.toBeInTheDocument();
});
