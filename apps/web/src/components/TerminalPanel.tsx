import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { useLoad } from '../hooks';
import type { TerminalSession } from '../types';

function XtermSession({ session, onExit }: { session: TerminalSession; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
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
    let viewportHandler: (() => void) | undefined;
    const focusTerminal = () => {
      terminal.focus();
      window.setTimeout(() => terminal.focus(), 0);
    };
    function connect() {
      socket = new WebSocket(`${protocol}//${location.host}/ws/terminals/${encodeURIComponent(session.id)}`);
      socket.addEventListener('open', () => { retry = 0; socket?.send(JSON.stringify({ action: 'resize', cols: terminal.cols, rows: terminal.rows })); });
      socket.addEventListener('message', (frame) => {
        const message = JSON.parse(String(frame.data)) as { type: string; data?: string; replay?: string; exitCode?: number };
        if (message.type === 'ready' && message.replay) { terminal.reset(); terminal.write(message.replay); }
        if (message.type === 'output') terminal.write(message.data ?? '');
        if (message.type === 'exit') { terminal.writeln(`\r\n[process exited: ${message.exitCode ?? 'unknown'}]`); onExitRef.current(); }
        if (message.type === 'missing') { terminal.writeln('\r\n[terminal process is no longer available]'); onExitRef.current(); }
      });
      socket.addEventListener('close', () => {
        if (active) reconnectTimer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      });
    }
    connect();
    const send = (value: object) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
    const fitAndResize = () => {
      fit.fit();
      send({ action: 'resize', cols: terminal.cols, rows: terminal.rows });
    };
    const input = terminal.onData((data) => send({ action: 'input', data }));
    const observer = new ResizeObserver(() => fitAndResize());
    observer.observe(host.current);
    host.current.addEventListener('click', focusTerminal);
    host.current.addEventListener('touchstart', focusTerminal, { passive: true });
    if (window.visualViewport) {
      viewportHandler = () => window.requestAnimationFrame(() => fitAndResize());
      window.visualViewport.addEventListener('resize', viewportHandler);
      window.visualViewport.addEventListener('scroll', viewportHandler);
    }
    focusTerminal();
    return () => {
      active = false;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (viewportHandler && window.visualViewport) {
        window.visualViewport.removeEventListener('resize', viewportHandler);
        window.visualViewport.removeEventListener('scroll', viewportHandler);
      }
      host.current?.removeEventListener('click', focusTerminal);
      host.current?.removeEventListener('touchstart', focusTerminal);
      observer.disconnect();
      input.dispose();
      socket?.close();
      terminal.dispose();
    };
  }, [session.id]);
  return <div className="terminal-host" ref={host} data-testid="terminal" />;
}

export function TerminalPanel({ repositoryId }: { repositoryId: string }) {
  const { data: sessions = [], setData, loading, error } = useLoad(() => api.terminals(repositoryId), [repositoryId]);
  const [selected, setSelected] = useState<string>();
  const [createError, setCreateError] = useState('');
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
  return <div className="terminal-view">
    <div className="section-toolbar">
      <select aria-label="Terminal session" value={current?.id ?? ''} onChange={(event) => setSelected(event.target.value)} disabled={!sessions.length}>
        {sessions.map((session) => <option value={session.id} key={session.id}>{session.name ?? 'shell'}{session.status === 'exited' ? ' (exited)' : ''}</option>)}
      </select>
      <button className="button secondary compact" onClick={() => void create()}><Plus size={16} />New shell</button>
    </div>
    {(error || createError) && <div className="notice error">{error || createError}</div>}
    {loading ? <div className="empty compact-empty">Finding persistent sessions…</div> : current ? <XtermSession session={current}
      onExit={() => setData(sessions.map((session) => session.id === current.id ? { ...session, status: 'exited' } : session))} />
      : <div className="empty"><h2>No running terminal</h2><p>Create a persistent shell for this checkout.</p><button className="button primary" onClick={() => void create()}><Plus size={16} />New shell</button></div>}
  </div>;
}
