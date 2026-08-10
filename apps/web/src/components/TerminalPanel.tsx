import { useEffect, useRef, useState } from 'react';
import { CircleX, Plus } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { useLoad } from '../hooks';
import type { TerminalSession } from '../types';

type ConnectionState = 'connecting' | 'live' | 'disconnected' | 'failed';

function XtermSession({ session, onExit, onInterruptAvailable }: {
  session: TerminalSession;
  onExit: () => void;
  onInterruptAvailable: (interrupt?: () => void) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  const reconnectable = useRef(true);
  const connectionStateRef = useRef<ConnectionState>('connecting');
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [connectionError, setConnectionError] = useState('');
  onExitRef.current = onExit;
  useEffect(() => {
    if (!host.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"IBM Plex Mono", monospace',
      fontSize: 13,
      scrollback: 5_000,
      theme: {
        background: '#050707',
        foreground: '#eef1ef',
        cursor: '#efbd49',
        cursorAccent: '#070909',
        selectionBackground: '#5f4d24',
        black: '#070909',
        red: '#d52f36',
        green: '#48cf80',
        yellow: '#efbd49',
        blue: '#6f91a8',
        magenta: '#b98aa5',
        cyan: '#69b8ad',
        white: '#d7dcda',
        brightBlack: '#69716f',
        brightRed: '#ff6268',
        brightGreen: '#70e59e',
        brightYellow: '#ffd475',
        brightBlue: '#91b4cb',
        brightMagenta: '#d7a9c3',
        brightCyan: '#8bd9ce',
        brightWhite: '#ffffff',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    terminal.textarea?.setAttribute('enterkeyhint', 'send');
    terminal.textarea?.setAttribute('autocapitalize', 'off');
    terminal.textarea?.setAttribute('autocomplete', 'off');
    terminal.textarea?.setAttribute('autocorrect', 'off');
    terminal.textarea?.setAttribute('spellcheck', 'false');
    fit.fit();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let retry = 0;
    let active = true;
    const updateConnectionState = (state: ConnectionState) => {
      connectionStateRef.current = state;
      setConnectionState(state);
    };
    const focusTerminal = () => {
      terminal.focus();
      window.setTimeout(() => terminal.focus(), 0);
    };
    function connect() {
      updateConnectionState(retry ? 'disconnected' : 'connecting');
      socket = new WebSocket(`${protocol}//${location.host}/ws/terminals/${encodeURIComponent(session.id)}`);
      socket.addEventListener('open', () => { retry = 0; socket?.send(JSON.stringify({ action: 'resize', cols: terminal.cols, rows: terminal.rows })); });
      socket.addEventListener('message', (frame) => {
        const message = JSON.parse(String(frame.data)) as { type: string; data?: string; replay?: string; exitCode?: number; message?: string };
        if (message.type === 'ready') {
          updateConnectionState('live');
          setConnectionError('');
          if (message.replay) { terminal.reset(); terminal.write(message.replay); }
        }
        if (message.type === 'output') terminal.write(message.data ?? '');
        if (message.type === 'exit') {
          reconnectable.current = false;
          terminal.writeln(`\r\n[process exited: ${message.exitCode ?? 'unknown'}]`);
          onExitRef.current();
        }
        if (message.type === 'missing') {
          reconnectable.current = false;
          terminal.writeln('\r\n[terminal process is no longer available]');
          onExitRef.current();
        }
        if (message.type === 'error') {
          reconnectable.current = false;
          updateConnectionState('failed');
          setConnectionError(message.message || 'Terminal protocol error');
          socket?.close();
        }
      });
      socket.addEventListener('error', () => setConnectionError('Terminal connection failed. Retrying…'));
      socket.addEventListener('close', () => {
        if (active && reconnectable.current) {
          updateConnectionState('disconnected');
          reconnectTimer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
        }
      });
    }
    connect();
    const send = (value: object) => {
      if (connectionStateRef.current === 'live' && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
    };
    onInterruptAvailable(() => {
      send({ action: 'input', data: '\u0003' });
      focusTerminal();
    });
    const fitAndResize = () => {
      fit.fit();
      send({ action: 'resize', cols: terminal.cols, rows: terminal.rows });
    };
    const input = terminal.onData((data) => send({ action: 'input', data }));
    const observer = new ResizeObserver(() => fitAndResize());
    observer.observe(host.current);
    host.current.addEventListener('click', focusTerminal);
    host.current.addEventListener('touchstart', focusTerminal, { passive: true });
    focusTerminal();
    return () => {
      active = false;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      onInterruptAvailable();
      host.current?.removeEventListener('click', focusTerminal);
      host.current?.removeEventListener('touchstart', focusTerminal);
      observer.disconnect();
      input.dispose();
      socket?.close();
      terminal.dispose();
    };
  }, [session.id]);
  return <>
    <div className={`terminal-connection terminal-connection-${connectionState}`} data-testid="terminal-connection-state" role="status">
      {connectionState === 'live' ? 'Live' : connectionState === 'connecting' ? 'Connecting…' : connectionState === 'disconnected' ? 'Disconnected; reconnecting…' : 'Terminal failed'}
    </div>
    {connectionError && <div className="notice error" role="alert">{connectionError}</div>}
    <div className="terminal-host" ref={host} data-testid="terminal" />
  </>;
}

export function TerminalPanel({ repositoryId }: { repositoryId: string }) {
  const { data: sessions = [], setData, loading, error } = useLoad(() => api.terminals(repositoryId), [repositoryId]);
  const [selected, setSelected] = useState<string>();
  const [createError, setCreateError] = useState('');
  const [interrupt, setInterrupt] = useState<(() => void) | undefined>();
  const current = sessions.find((session) => session.id === selected && session.status !== 'exited')
    ?? sessions.find((session) => session.status !== 'exited');
  async function create() {
    const names = new Set(sessions.map((session) => session.name));
    let sequence = 1;
    while (names.has(sequence === 1 ? 'shell' : `shell ${sequence}`)) sequence += 1;
    try {
      const session = await api.createTerminal(repositoryId, sequence === 1 ? 'shell' : `shell ${sequence}`);
      setData([...sessions, session]); setSelected(session.id); setCreateError('');
    } catch (reason) { setCreateError(reason instanceof Error ? reason.message : 'Could not create terminal'); }
  }
  function setInterruptAvailable(next?: () => void) { setInterrupt(() => next); }
  return <div className="terminal-view">
    <div className="section-toolbar terminal-toolbar">
      <select aria-label="Terminal session" value={current?.id ?? ''} onChange={(event) => setSelected(event.target.value)} disabled={!sessions.length}>
        {sessions.map((session) => <option value={session.id} key={session.id}>{session.name ?? 'shell'}{session.status === 'exited' ? ' (exited)' : ''}</option>)}
      </select>
      <div className="terminal-actions">
        <button className="icon-button terminal-interrupt" aria-label="Send Ctrl+C to terminal" title="Interrupt running process (Ctrl+C)" onClick={() => interrupt?.()} disabled={!interrupt}><CircleX /></button>
        <button className="button secondary compact" onClick={() => void create()}><Plus size={16} />New shell</button>
      </div>
    </div>
    {(error || createError) && <div className="notice error">{error || createError}</div>}
    {loading ? <div className="empty compact-empty">Finding persistent sessions…</div> : current ? <XtermSession session={current}
      onExit={() => setData(sessions.map((session) => session.id === current.id ? { ...session, status: 'exited' } : session))}
      onInterruptAvailable={setInterruptAvailable} />
      : <div className="empty"><h2>No running terminal</h2><p>Create a persistent shell for this checkout.</p><button className="button primary" onClick={() => void create()}><Plus size={16} />New shell</button></div>}
  </div>;
}
