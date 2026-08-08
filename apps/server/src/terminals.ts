import { spawn } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { extname } from 'node:path';
import type { WebSocket } from 'ws';
import type { TerminalCommand } from './terminal-protocol.js';

export class TerminalManager {
  private starting?: Promise<void>;
  constructor(private readonly socketPath: string, private readonly hostScript: string, private readonly externalHost = false) {}

  async bridge(webSocket: WebSocket, terminalId: string, cwd: string, create: boolean,
    onReady: () => void, onExit: () => void): Promise<void> {
    await this.ensureHost();
    const socket = createConnection(this.socketPath);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const frame = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let missing = false;
        try {
          const message = JSON.parse(frame) as { type?: string };
          if (message.type === 'ready') onReady();
          if (message.type === 'exit' || message.type === 'missing') onExit();
          missing = message.type === 'missing';
        } catch { /* Forward protocol errors to the browser unchanged. */ }
        if (webSocket.readyState === webSocket.OPEN) webSocket.send(frame);
        if (missing) { webSocket.close(1011, 'Terminal process is no longer available'); socket.destroy(); }
      }
    });
    socket.on('connect', () => socket.write(`${JSON.stringify(create
      ? { action: 'create', id: terminalId, cwd, cols: 80, rows: 24 }
      : { action: 'attach', id: terminalId })}\n`));
    socket.on('error', (error) => webSocket.close(1011, error.message));
    socket.on('close', () => webSocket.close());
    webSocket.on('message', (data) => {
      try {
        const command = JSON.parse(data.toString()) as TerminalCommand;
        if (command.action === 'input') socket.write(`${JSON.stringify({ ...command, id: terminalId })}\n`);
        else if (command.action === 'resize') socket.write(`${JSON.stringify({ ...command, id: terminalId })}\n`);
        else throw new Error('Only input and resize actions are accepted');
      } catch (error) {
        webSocket.send(JSON.stringify({ type: 'error', message: (error as Error).message }));
      }
    });
    webSocket.on('close', () => socket.destroy());
  }

  private async ensureHost(): Promise<void> {
    if (await canConnect(this.socketPath)) return;
    if (this.externalHost) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (await canConnect(this.socketPath)) return;
      }
      throw new Error('Managed terminal host is not available');
    }
    if (!this.starting) {
      this.starting = (async () => {
        const hostArguments = extname(this.hostScript) === '.ts'
          ? ['--import', 'tsx', this.hostScript, this.socketPath]
          : [this.hostScript, this.socketPath];
        const child = spawn(process.execPath, hostArguments, { detached: true, stdio: 'ignore' });
        child.unref();
        for (let attempt = 0; attempt < 50; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (await canConnect(this.socketPath)) return;
        }
        throw new Error('Detached terminal host did not become ready');
      })().finally(() => { this.starting = undefined; });
    }
    await this.starting;
  }
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket: Socket = createConnection(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}
