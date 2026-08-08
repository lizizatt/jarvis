import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import process from 'node:process';
import * as pty from 'node-pty';
import type { TerminalCommand, TerminalMessage } from './terminal-protocol.js';

const socketPath = process.argv[2];
if (!socketPath) throw new Error('Terminal host requires a Unix socket path');
const pidPath = `${socketPath}.pid`;
mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
if (existsSync(socketPath)) rmSync(socketPath);
writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });

interface Session { terminal?: pty.IPty; replay: string; clients: Set<Socket>; exit?: { exitCode: number; signal?: number } }
const sessions = new Map<string, Session>();
const clients = new Set<Socket>();

const server = createServer((socket) => {
  clients.add(socket);
  let buffer = '';
  const attached = new Set<string>();
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { handle(socket, attached, JSON.parse(line) as TerminalCommand); }
      catch (error) { send(socket, { type: 'error', message: (error as Error).message }); }
    }
  });
  socket.on('close', () => {
    clients.delete(socket);
    for (const id of attached) sessions.get(id)?.clients.delete(socket);
  });
});

server.listen(socketPath, () => chmodSync(socketPath, 0o600));

function handle(socket: Socket, attached: Set<string>, command: TerminalCommand): void {
  if (command.action === 'create') {
    if (!sessions.has(command.id)) {
      const shell = process.env.SHELL || '/bin/bash';
      const terminal = pty.spawn(shell, [], { name: 'xterm-256color', cwd: command.cwd,
        cols: clamp(command.cols, 20, 500), rows: clamp(command.rows, 5, 200), env: process.env as Record<string, string> });
      const session: Session = { terminal, replay: '', clients: new Set() };
      sessions.set(command.id, session);
      terminal.onData((data) => {
        session.replay = (session.replay + data).slice(-1024 * 1024);
        broadcast(session, { type: 'output', id: command.id, data });
      });
      terminal.onExit(({ exitCode, signal }) => {
        session.terminal = undefined;
        session.exit = { exitCode, signal };
        broadcast(session, { type: 'exit', id: command.id, exitCode, signal });
      });
    }
    attach(socket, attached, command.id);
    return;
  }
  if (command.action === 'attach') {
    if (!sessions.has(command.id)) { send(socket, { type: 'missing', id: command.id }); return; }
    attach(socket, attached, command.id);
    return;
  }
  const session = sessions.get(command.id);
  if (!session) throw new Error('Terminal session is not running');
  if (!session.terminal) throw new Error('Terminal session has exited');
  if (command.action === 'input') session.terminal.write(command.data);
  else session.terminal.resize(clamp(command.cols, 20, 500), clamp(command.rows, 5, 200));
}

function attach(socket: Socket, attached: Set<string>, id: string): void {
  const session = sessions.get(id);
  if (!session) throw new Error('Terminal session is not running');
  session.clients.add(socket);
  attached.add(id);
  send(socket, { type: 'ready', id, replay: session.replay });
  if (session.exit) send(socket, { type: 'exit', id, ...session.exit });
}

function broadcast(session: Session, message: TerminalMessage): void {
  for (const client of session.clients) send(client, message);
}

function send(socket: Socket, message: TerminalMessage): void { socket.write(`${JSON.stringify(message)}\n`); }
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function shutdown(): void {
  for (const session of sessions.values()) session.terminal?.kill();
  sessions.clear();
  for (const client of clients) client.destroy();
  clients.clear();
  server.close();
  if (existsSync(socketPath)) rmSync(socketPath);
  if (existsSync(pidPath)) rmSync(pidPath);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
