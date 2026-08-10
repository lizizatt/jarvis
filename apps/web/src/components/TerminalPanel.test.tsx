import { act, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { api } from '../api';
import { TerminalPanel } from './TerminalPanel';

const terminalInstances = vi.hoisted((): Array<{ focus: ReturnType<typeof vi.fn> }> => []);

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    textarea = document.createElement('textarea');
    loadAddon = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    reset = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
    dispose = vi.fn();
    constructor() { terminalInstances.push(this); }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); } }));

type Listener = (event: Event | MessageEvent) => void;
class SocketMock {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: SocketMock[] = [];
  readyState = SocketMock.CONNECTING;
  private readonly listeners = new Map<string, Listener[]>();
  send = vi.fn();

  constructor() { SocketMock.instances.push(this); }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() { this.emit('close', new Event('close')); }
  emit(type: string, event: Event | MessageEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

beforeEach(() => {
  SocketMock.instances = [];
  terminalInstances.length = 0;
  vi.stubGlobal('WebSocket', SocketMock);
  vi.spyOn(api, 'terminals').mockResolvedValue([{ id: 'terminal-1', name: 'shell', status: 'running' }]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('shows a terminal protocol failure and does not reconnect after it', async () => {
  render(<TerminalPanel repositoryId="repo-1" />);
  await screen.findByTestId('terminal');
  await waitFor(() => expect(SocketMock.instances).toHaveLength(1));
  const socket = SocketMock.instances[0];

  await act(async () => {
    socket.readyState = SocketMock.OPEN;
    socket.emit('open', new Event('open'));
    socket.emit('message', new MessageEvent('message', { data: JSON.stringify({ type: 'ready', id: 'terminal-1' }) }));
  });
  expect(screen.getByTestId('terminal-connection-state')).toHaveTextContent('Live');

  await act(async () => {
    socket.emit('message', new MessageEvent('message', { data: JSON.stringify({ type: 'error', message: 'Terminal session has exited' }) }));
  });

  expect(screen.getByRole('alert')).toHaveTextContent('Terminal session has exited');
  expect(screen.getByTestId('terminal-connection-state')).toHaveTextContent('Terminal failed');
  expect(SocketMock.instances).toHaveLength(1);
});

test('sends Ctrl+C through the live terminal socket and keeps terminal focus', async () => {
  render(<TerminalPanel repositoryId="repo-1" />);
  await screen.findByTestId('terminal');
  await waitFor(() => expect(SocketMock.instances).toHaveLength(1));
  const socket = SocketMock.instances[0];

  await act(async () => {
    socket.readyState = SocketMock.OPEN;
    socket.emit('message', new MessageEvent('message', { data: JSON.stringify({ type: 'ready', id: 'terminal-1' }) }));
  });
  await screen.findByRole('button', { name: 'Send Ctrl+C to terminal' });
  await screen.getByRole('button', { name: 'Send Ctrl+C to terminal' }).click();

  expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ action: 'input', data: '\u0003' }));
  expect(terminalInstances[0].focus).toHaveBeenCalled();
});
