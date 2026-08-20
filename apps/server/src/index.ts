import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { isLoopbackHost, positiveInteger } from './config.js';
import type { ServerConfig } from './types.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
let repositoryRoot = currentDirectory;
while (!existsSync(join(repositoryRoot, 'apps/server/package.json'))) {
  const parent = dirname(repositoryRoot);
  if (parent === repositoryRoot) throw new Error('Unable to locate the Jarvis repository root');
  repositoryRoot = parent;
}
const dataDir = resolve(process.env.JARVIS_DATA_DIR || join(homedir(), '.jarvis'));
const instructionsPath = resolve(process.env.JARVIS_AGENT_INSTRUCTIONS_FILE || join(repositoryRoot, 'AGENTS.md'));
const frameworkInstructions = existsSync(instructionsPath) ? readFileSync(instructionsPath, 'utf8').trim() : '';
const configuredPolicy = process.env.JARVIS_POLICY || 'Work autonomously, but ask the user before commit, push, or pull-request operations unless this task explicitly grants permission.';
const agentBackend = process.env.JARVIS_AGENT_BACKEND || 'worker';
if (!['auto', 'worker', 'cli'].includes(agentBackend)) throw new Error('JARVIS_AGENT_BACKEND must be auto, worker, or cli');
const host = process.env.JARVIS_HOST || '127.0.0.1';
if (!isLoopbackHost(host) && process.env.JARVIS_ALLOW_INSECURE_NETWORK !== 'true') {
  throw new Error('JARVIS_HOST must remain loopback unless JARVIS_ALLOW_INSECURE_NETWORK=true');
}
const config: ServerConfig = {
  dataDir,
  host,
  port: Number(process.env.JARVIS_PORT || 3210),
  agentExecutable: process.env.JARVIS_AGENT_EXECUTABLE || 'copilot',
  agentBackend: agentBackend as ServerConfig['agentBackend'],
  policy: [frameworkInstructions, configuredPolicy].filter(Boolean).join('\n\n'),
  webRoot: process.env.JARVIS_WEB_ROOT || join(repositoryRoot, 'apps/web/dist'),
  terminalHostScript: process.env.JARVIS_TERMINAL_HOST_SCRIPT || join(currentDirectory, 'terminal-host.js'),
  terminalHostExternal: process.env.JARVIS_TERMINAL_HOST_EXTERNAL === 'true',
  tailscaleExecutable: process.env.JARVIS_TAILSCALE_EXECUTABLE || 'tailscale',
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
