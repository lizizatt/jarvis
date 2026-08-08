import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { positiveInteger } from './config.js';
import type { ServerConfig } from './types.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.env.JARVIS_DATA_DIR || join(homedir(), '.jarvis'));
const agentBackend = process.env.JARVIS_AGENT_BACKEND || 'worker';
if (!['auto', 'worker', 'cli'].includes(agentBackend)) throw new Error('JARVIS_AGENT_BACKEND must be auto, worker, or cli');
const config: ServerConfig = {
  dataDir,
  host: process.env.JARVIS_HOST || '127.0.0.1',
  port: Number(process.env.JARVIS_PORT || 3210),
  agentExecutable: process.env.JARVIS_AGENT_EXECUTABLE || 'copilot',
  agentBackend: agentBackend as ServerConfig['agentBackend'],
  policy: process.env.JARVIS_POLICY || 'Work autonomously, but ask the user before commit, push, or pull-request operations unless this task explicitly grants permission.',
  webRoot: process.env.JARVIS_WEB_ROOT || resolve(process.cwd(), 'apps/web/dist'),
  terminalHostScript: process.env.JARVIS_TERMINAL_HOST_SCRIPT || join(currentDirectory, 'terminal-host.js'),
  terminalHostExternal: process.env.JARVIS_TERMINAL_HOST_EXTERNAL === 'true',
  maxJsonLineBytes: positiveInteger(process.env.JARVIS_MAX_JSON_LINE_BYTES, 1024 * 1024, 'JARVIS_MAX_JSON_LINE_BYTES'),
  maxStderrChunkBytes: positiveInteger(process.env.JARVIS_MAX_STDERR_CHUNK_BYTES, 64 * 1024, 'JARVIS_MAX_STDERR_CHUNK_BYTES'),
};

const app = await createApp(config);
await app.listen({ host: config.host, port: config.port });
console.log(`Jarvis server listening on http://${config.host}:${config.port}`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`Jarvis received ${signal}; shutting down`);
  await app.close();
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
