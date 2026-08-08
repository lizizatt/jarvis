#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import { WebSocket } from 'ws';

const baseUrl = process.env.JARVIS_URL ?? 'http://127.0.0.1:3210';
const repositoryPath = process.env.JARVIS_SANDBOX_REPO ?? '/tmp/jarvis-mvp-sandbox';

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  const text = await response.text();
  assert(response.ok, `${init?.method ?? 'GET'} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function requestText(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  assert(response.ok, `GET ${path}: ${response.status} ${text}`);
  return text;
}

function openSocket(path) {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket, predicate, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out waiting for WebSocket message')), timeout);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (predicate(message)) finish(undefined, message);
    };
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      if (error) reject(error);
      else resolve(value);
    };
    socket.on('message', onMessage);
  });
}

const health = await request('/api/health');
assert.equal(health.ok, true);
await restoreTrackedFile('report.html');

const existingRepositories = await request('/api/repositories');
for (const existing of existingRepositories.filter((candidate) => candidate.path === repositoryPath)) {
  await request(`/api/repositories/${existing.id}`, { method: 'DELETE' });
}

const repository = await request('/api/repositories', {
  method: 'POST',
  body: JSON.stringify({ name: 'Jarvis Sandbox', path: repositoryPath, instructions: 'Never access paths outside this sandbox.' }),
});
assert.equal(repository.path, repositoryPath);
assert.equal(repository.previewUrl, `/previews/${repository.id}`);

const preview = await fetch(`${baseUrl}${repository.previewUrl}`);
assert(preview.ok);
assert((await preview.text()).includes('Jarvis Sandbox'));
const report = await fetch(`${baseUrl}/previews/${repository.id}/repo/report.html`);
assert(report.ok);
assert((await report.text()).includes('Preview routing works'));

await writeSandboxFile(`${repositoryPath}/report.html`, '<!doctype html><title>Sandbox preview</title><main>uncommitted sandbox change</main>\n');
const status = await request(`/api/repositories/${repository.id}/status`);
assert.equal(status.dirty, true);
const diff = await requestText(`/api/repositories/${repository.id}/diff`);
assert(diff.includes('uncommitted sandbox change'));

const task = await request(`/api/repositories/${repository.id}/tasks`, {
  method: 'POST',
  body: JSON.stringify({ prompt: 'ASK HANG' }),
});
const taskSocket = await openSocket(`/ws/tasks?taskId=${task.id}`);
const childEvent = await waitForEvent(task.id, (event) => event.kind === 'agent_event' && event.payload?.type === 'child');
const childPid = Number(childEvent.payload.pid);
assert(Number.isInteger(childPid));
await request(`/api/tasks/${task.id}/stop`, {
  method: 'POST',
  body: JSON.stringify({ confirmed: true, stoppedBy: 'sandbox-smoke' }),
});
const stopped = await request(`/api/tasks/${task.id}`);
assert.equal(stopped.state, 'stopped');
assert.throws(() => process.kill(childPid, 0), (error) => error?.code === 'ESRCH');
const persistedEvents = await request(`/api/tasks/${task.id}/events?after=0`);
assert(persistedEvents.length >= 4);
assert(persistedEvents.every((event, index) => index === 0 || event.sequence > persistedEvents[index - 1].sequence));
taskSocket.close();

const terminal = await request(`/api/repositories/${repository.id}/terminals`, {
  method: 'POST',
  body: JSON.stringify({ name: 'smoke-shell' }),
});
const terminalSocket = await openSocket(`/ws/terminals/${terminal.id}`);
await nextMessage(terminalSocket, (message) => message.type === 'ready');
terminalSocket.send(JSON.stringify({ action: 'input', data: "printf 'JARVIS_TERMINAL_OK\\n'\r" }));
await nextMessage(terminalSocket, (message) => message.type === 'output' && message.data.includes('JARVIS_TERMINAL_OK'));
terminalSocket.close();

console.log(JSON.stringify({ ok: true, repositoryId: repository.id, taskId: task.id, terminalId: terminal.id }, null, 2));

async function waitForEvent(taskId, predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = await request(`/api/tasks/${taskId}/events?after=0`);
    const match = events.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for persisted task event');
}

async function writeSandboxFile(path, contents) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, contents);
}

async function restoreTrackedFile(path) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)('git', ['-C', repositoryPath, 'show', `HEAD:${path}`], { encoding: 'utf8' });
  await writeSandboxFile(`${repositoryPath}/${path}`, stdout);
}
