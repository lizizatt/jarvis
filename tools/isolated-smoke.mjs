#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { createApp } from '../apps/server/dist/src/app.js';
import { runCleanupSteps } from './isolated-runner-lib.mjs';

class SocketChannel {
  static async open(url) {
    const channel = new SocketChannel(new WebSocket(url));
    await channel.opened;
    return channel;
  }

  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    this.opened = new Promise((resolvePromise, reject) => {
      socket.once('open', resolvePromise);
      socket.once('error', reject);
    });
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex < 0) this.messages.push(message);
      else this.waiters.splice(waiterIndex, 1)[0].resolve(message);
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  next(predicate, timeout = 5_000) {
    const messageIndex = this.messages.findIndex(predicate);
    if (messageIndex >= 0) return Promise.resolve(this.messages.splice(messageIndex, 1)[0]);
    return new Promise((resolvePromise, reject) => {
      const waiter = { predicate, resolve: resolvePromise };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.indexOf(waiter);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(new Error('Timed out waiting for WebSocket message'));
      }, timeout);
      waiter.resolve = (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      };
    });
  }

  close() {
    this.socket.close();
  }
}

const execFile = promisify((await import('node:child_process')).execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smokeRoot = await mkdtemp(join(tmpdir(), 'jarvis-isolated-smoke-'));
const dataDirectory = join(smokeRoot, 'state');
const fixtureRepository = join(smokeRoot, 'repository');
const socketPath = join(dataDirectory, 'terminal-host.sock');
const terminalHostScript = join(repositoryRoot, 'apps/server/dist/src/terminal-host.js');
const fixtureAgent = join(repositoryRoot, 'apps/server/test/fixtures/agent.mjs');
const webRoot = join(repositoryRoot, 'apps/web/dist');
let app;
let workerChannel;
let terminalChannel;
let terminalHost;
let terminalHostStderr = '';
let smokeError;
let cleanupError;

try {
  assert.equal(process.env.JARVIS_HOST, '127.0.0.1');
  assert.equal(process.env.JARVIS_PORT, '0');
  assert.equal(process.env.PLAYWRIGHT_ALLOW_EXTERNAL, 'false');
  assert.equal(process.env.DBUS_SESSION_BUS_ADDRESS, undefined);
  await Promise.all([
    access(join(webRoot, 'index.html')),
    access(terminalHostScript),
    access(fixtureAgent),
  ]);
  await createFixtureRepository(fixtureRepository);
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });

  terminalHost = spawn(process.execPath, [terminalHostScript, socketPath], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  terminalHost.stderr.on('data', (chunk) => { terminalHostStderr = `${terminalHostStderr}${chunk}`.slice(-16_384); });
  await waitFor(() => canConnect(socketPath), 'terminal host socket');

  app = await createApp({
    dataDir: dataDirectory,
    host: '127.0.0.1',
    port: 0,
    agentExecutable: fixtureAgent,
    editorExecutable: '/bin/false',
    agentBackend: 'worker',
    policy: 'ISOLATED SMOKE POLICY',
    webRoot,
    terminalHostScript,
    terminalHostExternal: true,
    readinessWebRequired: true,
    readinessTerminalHostRequired: true,
    maxJsonLineBytes: 1024 * 1024,
    maxStderrChunkBytes: 64 * 1024,
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = new URL(address);
  assert.equal(baseUrl.hostname, '127.0.0.1');
  assert.notEqual(baseUrl.port, '0');

  workerChannel = await SocketChannel.open(webSocketUrl(baseUrl, '/ws/workers'));
  workerChannel.send({
    version: 2,
    type: 'hello',
    workerId: 'isolated-fixture-worker',
    windowName: 'isolated-fixture',
    workspaceRoots: [fixtureRepository],
    models: [{
      id: 'fixture-model',
      name: 'Fixture Model',
      vendor: 'jarvis-test',
      family: 'fixture',
      version: '1',
      maxInputTokens: 4096,
    }],
  });
  await workerChannel.next((message) => message.type === 'ready');

  const health = await requestJson(baseUrl, '/api/health');
  assert.equal(health.ok, true);
  const pwaResponse = await fetch(new URL('/', baseUrl));
  assert.equal(pwaResponse.status, 200);
  assert.match(pwaResponse.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await pwaResponse.text(), /id="root"/);

  const repository = await requestJson(baseUrl, '/api/repositories', {
    method: 'POST',
    body: JSON.stringify({ name: 'Isolated Fixture', path: fixtureRepository }),
  });
  assert.equal(repository.path, fixtureRepository);
  const workers = await requestJson(baseUrl, '/api/workers');
  assert.deepEqual(workers.map((worker) => worker.workerId), ['isolated-fixture-worker']);

  const task = await requestJson(baseUrl, `/api/repositories/${repository.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'Exercise the isolated fixture worker', modelId: 'fixture-model' }),
  });
  const turn = await workerChannel.next((message) => message.type === 'turn' && message.taskId === task.id);
  assert.equal(turn.repositoryPath, fixtureRepository);
  workerChannel.send({
    version: 2,
    type: 'event',
    taskId: task.id,
    kind: 'text',
    payload: { text: 'ISOLATED_WORKER_OK' },
  });
  workerChannel.send({ version: 2, type: 'complete', taskId: task.id });
  const completedTask = await waitFor(async () => {
    const candidate = await requestJson(baseUrl, `/api/tasks/${task.id}`);
    return candidate.state === 'completed' ? candidate : undefined;
  }, 'fixture worker task completion');
  assert.equal(completedTask.state, 'completed');

  const terminal = await requestJson(baseUrl, `/api/repositories/${repository.id}/terminals`, {
    method: 'POST',
    body: JSON.stringify({ name: 'isolated-smoke' }),
  });
  terminalChannel = await SocketChannel.open(webSocketUrl(baseUrl, `/ws/terminals/${terminal.id}`));
  await terminalChannel.next((message) => message.type === 'ready');
  terminalChannel.send({ action: 'input', data: "printf '\\112\\101\\122\\126\\111\\123_ISOLATED_TERMINAL_OK\\n'\r" });
  await terminalChannel.next((message) => message.type === 'output' && message.data.includes('JARVIS_ISOLATED_TERMINAL_OK'));
  terminalChannel.send({ action: 'input', data: 'exit\r' });
  await terminalChannel.next((message) => message.type === 'exit');

  const readiness = await requestJson(baseUrl, '/api/readiness');
  assert.deepEqual(readiness, {
    ok: true,
    checks: { web: { ok: true }, terminalHost: { ok: true } },
  });
  await access(join(dataDirectory, 'jarvis.sqlite3'));

  console.log(JSON.stringify({
    ok: true,
    address,
    workerId: workers[0].workerId,
    taskId: task.id,
    terminalId: terminal.id,
  }));
} catch (error) {
  smokeError = error;
} finally {
  try {
    await runCleanupSteps([
      { label: 'terminal WebSocket', run: () => terminalChannel?.close() },
      { label: 'worker WebSocket', run: () => workerChannel?.close() },
      { label: 'Fastify app', run: () => app?.close() },
      { label: 'terminal host', run: () => terminalHost ? stopChild(terminalHost) : undefined },
      { label: 'temporary smoke state', run: () => rm(smokeRoot, { recursive: true, force: true }) },
    ]);
  } catch (error) {
    cleanupError = error;
  }
}
if (smokeError && cleanupError) {
  throw new AggregateError([smokeError, cleanupError], 'Smoke validation failed and cleanup was incomplete');
}
if (smokeError) throw smokeError;
if (cleanupError) throw cleanupError;

async function createFixtureRepository(path) {
  await mkdir(path, { recursive: true });
  await execFile('git', ['-C', path, 'init', '--initial-branch=main']);
  await execFile('git', ['-C', path, 'config', 'user.email', 'isolated@jarvis.test']);
  await execFile('git', ['-C', path, 'config', 'user.name', 'Jarvis Isolated Fixture']);
  await writeFile(join(path, 'README.md'), '# Isolated Jarvis fixture\n');
  await execFile('git', ['-C', path, 'add', 'README.md']);
  await execFile('git', ['-C', path, 'commit', '-m', 'fixture']);
}

async function requestJson(baseUrl, path, init) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });
  const text = await response.text();
  assert.equal(response.ok, true, `${init?.method ?? 'GET'} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

function webSocketUrl(baseUrl, path) {
  const url = new URL(path, baseUrl);
  url.protocol = 'ws:';
  return url;
}

async function waitFor(predicate, description, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function canConnect(path) {
  return new Promise((resolvePromise) => {
    const socket = createConnection(path);
    socket.once('connect', () => { socket.destroy(); resolvePromise(true); });
    socket.once('error', () => resolvePromise(false));
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 2_000)),
  ]);
  if (stopped) return;
  child.kill('SIGKILL');
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Terminal host did not stop: ${terminalHostStderr.trim()}`)), 2_000)),
  ]);
}
