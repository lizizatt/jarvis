import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { positiveInteger } from '../src/config.js';
import { Store } from '../src/database.js';
import { normalizePullRequest } from '../src/git.js';
import { readPreviewFile } from '../src/previews.js';
import { JsonLineParser } from '../src/tasks.js';
import type { ServerConfig, Task } from '../src/types.js';

const execFileAsync = promisify(execFile);
const fixtureAgent = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/agent.mjs');
const terminalHost = resolve(dirname(fileURLToPath(import.meta.url)), '../src/terminal-host.ts');
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const hostPids: number[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const pid of hostPids.splice(0)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
});

describe('server MVP', () => {
  it('migrates durable state and marks active tasks interrupted on startup', async () => {
    const sandbox = await makeSandbox();
    const store = new Store(join(sandbox.dataDir, 'jarvis.sqlite3'));
    const now = new Date().toISOString();
    store.insertRepository({ id: 'repo', name: 'Repo', path: sandbox.repository, defaultBranch: 'main', createdAt: now, updatedAt: now });
    store.insertTask({ id: 'task', repositoryId: 'repo', sessionId: 'session', state: 'running', createdAt: now,
      updatedAt: now, stoppedBy: null, stoppedAt: null, exitCode: null, modelId: 'auto' });
    store.close();

    const app = await trackedApp(configuration(sandbox.dataDir));
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ ok: true, interruptedOnStartup: 1 });
    expect((await app.inject({ method: 'GET', url: '/api/tasks/task' })).json().state).toBe('interrupted');
  });

  it('registers only real checkout roots and reports status and both diffs', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const nested = await app.inject({ method: 'POST', url: '/api/repositories', payload: { name: 'Nested', path: join(sandbox.repository, 'nested') } });
    expect(nested.statusCode).toBe(400);

    const repository = await register(app, sandbox.repository);
    await writeFile(join(sandbox.repository, 'tracked.txt'), 'staged\n');
    await git(sandbox.repository, ['add', 'tracked.txt']);
    await writeFile(join(sandbox.repository, 'tracked.txt'), 'unstaged\n');
    const status = (await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/status` })).json();
    expect(status.dirty).toBe(true);
    expect(status.branch).toBe('main');
    expect((await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/diff?staged=true` })).body).toContain('staged');
    expect((await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/diff` })).body).toContain('unstaged');
    const pr = (await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/pull-request` })).json();
    expect(typeof pr.available).toBe('boolean');
  });

  it('does not mark a repository dirty for untracked-only files, but still lists them', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    await writeFile(join(sandbox.repository, 'untracked.txt'), 'new file\n');

    const status = (await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/status` })).json();
    expect(status.dirty).toBe(false);
    expect((await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/diff` })).body.trim()).toBe('');
    expect((await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/diff?staged=true` })).body.trim()).toBe('');

    const files = (await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/status-files` })).json();
    expect(files).toEqual([{ status: '??', path: 'untracked.txt' }]);
  });

  it('reports a name-only status listing for a renamed file', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    await writeFile(join(sandbox.repository, 'unstaged.txt'), 'a\n');
    await git(sandbox.repository, ['add', 'unstaged.txt']);
    await git(sandbox.repository, ['commit', '-m', 'add unstaged']);
    await git(sandbox.repository, ['mv', 'unstaged.txt', 'renamed.txt']);

    const files = (await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/status-files` })).json();
    expect(files).toEqual([{ status: 'R ', path: 'unstaged.txt -> renamed.txt' }]);
  });

  it('returns an empty status-files listing for a clean checkout', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    expect((await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/status-files` })).json()).toEqual([]);
  });

  it('reports 404 for status-files on an unknown repository', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    expect((await app.inject({ method: 'GET', url: '/api/repositories/does-not-exist/status-files' })).statusCode).toBe(404);
  });

  it('lists only tracked README.md and HTML files as preview candidates', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    await mkdir(join(sandbox.repository, 'docs'), { recursive: true });
    await writeFile(join(sandbox.repository, 'docs', 'README.md'), '# Docs\n');
    await writeFile(join(sandbox.repository, 'index.html'), '<h1>Home</h1>\n');
    await writeFile(join(sandbox.repository, 'notes.txt'), 'not a preview candidate\n');
    await git(sandbox.repository, ['add', 'docs/README.md', 'index.html', 'notes.txt']);
    await git(sandbox.repository, ['commit', '-m', 'add preview candidates']);
    await writeFile(join(sandbox.repository, 'untracked.html'), '<h1>Ignored</h1>\n');

    const files = (await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/preview-files` })).json() as Array<{ path: string; kind: string }>;
    expect(files).toHaveLength(3);
    expect(files).toContainEqual({ path: 'README.md', kind: 'readme' });
    expect(files).toContainEqual({ path: 'docs/README.md', kind: 'readme' });
    expect(files).toContainEqual({ path: 'index.html', kind: 'html' });
    expect(files.some((file) => file.path === 'notes.txt' || file.path === 'untracked.html')).toBe(false);
  });

  it('reports 404 for preview-files on an unknown repository', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    expect((await app.inject({ method: 'GET', url: '/api/repositories/does-not-exist/preview-files' })).statusCode).toBe(404);
  });

  it('renders README.md as real markdown through the repository preview route', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    await writeFile(join(sandbox.repository, 'README.md'), '# Title\n\nSome **bold** text and a [link](https://example.com).\n');
    const response = await app.inject({ method: 'GET', url: `/previews/${repository.id}/repo/README.md` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<h1>Title</h1>');
    expect(response.body).toContain('<strong>bold</strong>');
    expect(response.body).toContain('<a href="https://example.com">link</a>');
  });

  it('resolves a relative inline markdown image through the repository preview route', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    await mkdir(join(sandbox.repository, 'docs'), { recursive: true });
    // A real, fully decodable 1x1 PNG (not just a plausible-looking byte string) so the test catches corrupt image bytes too.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    await writeFile(join(sandbox.repository, 'docs', 'diagram.png'), png);
    await writeFile(join(sandbox.repository, 'README.md'), '# Title\n\n![diagram](docs/diagram.png)\n');

    const readme = await app.inject({ method: 'GET', url: `/previews/${repository.id}/repo/README.md` });
    expect(readme.body).toMatch(/<img[^>]*src="docs\/diagram\.png"/);

    const image = await app.inject({ method: 'GET', url: `/previews/${repository.id}/repo/docs/diagram.png` });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.rawPayload).toEqual(png);
  });

  it('reports status for a repository before its first commit', async () => {
    const sandbox = await makeSandbox();
    const unborn = join(sandbox.root, 'unborn');
    await mkdir(unborn);
    await git(unborn, ['init', '--initial-branch=main']);
    await writeFile(join(unborn, 'new.txt'), 'new\n');
    await git(unborn, ['add', 'new.txt']);
    const app = await trackedApp(configuration(join(sandbox.root, 'unborn-data')));
    const repository = await register(app, unborn);
    const status = (await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/status` })).json();
    expect(status).toMatchObject({ branch: 'main', dirty: true, recentCommits: [] });
  });

  it('persists ordered output, diagnoses policy denial, follows up with the same session, and publishes live', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const live = new WebSocket(`${address.replace('http', 'ws')}/ws/tasks`);
    const liveEvents: unknown[] = [];
    live.on('message', (message) => liveEvents.push(JSON.parse(message.toString())));
    await onceOpen(live);

    const created = await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`, payload: { prompt: 'ASK DENY first' } });
    expect(created.statusCode).toBe(201);
    const task = created.json() as Task;
    await waitFor(async () => (await taskFrom(app, task.id)).state === 'completed');
    const firstEvents = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/events` })).json();
    expect(firstEvents.map((event: { sequence: number }) => event.sequence).every((sequence: number, index: number) => sequence === index + 1)).toBe(true);
    expect(firstEvents.some((event: { kind: string; payload?: { type?: string; text?: string } }) =>
      event.kind === 'agent_event' && event.payload?.type === 'question' && event.payload.text === 'Choose one')).toBe(true);
    expect(firstEvents.some((event: { kind: string }) => event.kind === 'policy_denial')).toBe(true);
    expect(firstEvents.find((event: { kind: string }) => event.kind === 'lifecycle').payload.args).toEqual(expect.arrayContaining([
      '-C', sandbox.repository, '--session-id', task.sessionId, '--allow-all', '--output-format', 'json', '--stream', 'on',
      '--no-color', '--no-auto-update', '--no-remote-export',
    ]));
    expect(liveEvents.length).toBeGreaterThan(0);

    const followUp = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/messages`, payload: { prompt: 'second' } });
    expect(followUp.statusCode).toBe(200);
    await waitFor(async () => (await taskFrom(app, task.id)).state === 'completed');
    expect((await taskFrom(app, task.id)).sessionId).toBe(task.sessionId);
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/events` })).json()
      .some((event: { kind: string; payload?: { kind?: string } }) => event.kind === 'user_message' && event.payload?.kind === 'follow_up')).toBe(true);
    live.close();
  });

  it('includes current task title and latest activity in repository summaries', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`, payload: { prompt: 'HANG dashboard task' } });
    await waitFor(async () => {
      const summary = (await app.inject({ method: 'GET', url: '/api/repositories' })).json()[0].activeTask;
      return summary?.title === 'HANG dashboard task' && Boolean(summary.latestAction);
    });
  });

  it('retains initial prompt titles in task history without false question events', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    const task = (await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`,
      payload: { prompt: 'mention question casually' } })).json() as Task;
    await waitFor(async () => (await taskFrom(app, task.id)).state === 'completed');
    const history = (await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/tasks` })).json();
    expect(history[0].title).toBe('mention question casually');
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/events` })).json()
      .some((event: { kind: string }) => event.kind === 'question')).toBe(false);
  });

  it('rejects a second active conversation and idempotently kills the complete process group', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    const first = (await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`, payload: { prompt: 'HANG' } })).json() as Task;
    expect((await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`, payload: { prompt: 'blocked' } })).statusCode).toBe(409);
    await waitFor(async () => {
      const events = (await app.inject({ method: 'GET', url: `/api/tasks/${first.id}/events` })).json();
      return events.some((event: { payload: { type?: string } }) => event.payload?.type === 'child');
    });
    const events = (await app.inject({ method: 'GET', url: `/api/tasks/${first.id}/events` })).json();
    const childPid = events.find((event: { payload: { type?: string } }) => event.payload?.type === 'child').payload.pid as number;
    const stopped = await app.inject({ method: 'POST', url: `/api/tasks/${first.id}/stop`, payload: { confirmed: true, stoppedBy: 'integration-test' } });
    expect(stopped.json().state).toBe('stopped');
    expect(stopped.json().stoppedBy).toBe('integration-test');
    expect((await app.inject({ method: 'POST', url: `/api/tasks/${first.id}/stop`, payload: { confirmed: true } })).json().state).toBe('stopped');
    expect(() => process.kill(childPid, 0)).toThrow();
    expect((await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`, payload: { prompt: 'replacement' } })).statusCode).toBe(201);
  });

  it('replaces an active turn with a follow-up on the same native session', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    const task = (await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`, payload: { prompt: 'HANG' } })).json() as Task;
    await waitFor(async () => (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/events` })).json()
      .some((event: { payload: { type?: string } }) => event.payload?.type === 'child'));

    const replies = await Promise.all([
      app.inject({ method: 'POST', url: `/api/tasks/${task.id}/messages`, payload: { prompt: 'continue now' } }),
      app.inject({ method: 'POST', url: `/api/tasks/${task.id}/messages`, payload: { prompt: 'do not lose me' } }),
    ]);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
    await waitFor(async () => (await taskFrom(app, task.id)).state === 'completed');
    expect((await taskFrom(app, task.id)).sessionId).toBe(task.sessionId);
    const events = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/events` })).json();
    expect(events.filter((event: { kind: string; payload?: { followUp?: boolean } }) => event.kind === 'user_message' && event.payload?.followUp)).toHaveLength(1);
    const launches = events.filter((event: { kind: string; payload?: { args?: string[] } }) => event.kind === 'lifecycle' && event.payload?.args);
    expect(launches).toHaveLength(2);
    expect(launches.every((event: { payload: { args: string[] } }) => event.payload.args.includes(task.sessionId))).toBe(true);
  });

  it('dispatches worker turns, persists events, and follows up in the same session', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const workerRoot = join(sandbox.root, 'worker-repository');
    await symlink(sandbox.repository, workerRoot);
    const worker = await connectWorker(address, workerRoot);

    expect((await app.inject({ method: 'GET', url: '/api/workers' })).json()).toMatchObject([{
      workerId: 'test-worker', windowName: 'test-window', workspaceRoots: [sandbox.repository],
      models: expect.arrayContaining([expect.objectContaining({ id: 'auto', vendor: 'copilot' })]),
      activeTaskIds: [],
    }]);
    const task = (await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`,
      payload: { prompt: 'worker first' } })).json() as Task;
    const firstTurn = await takeWorkerMessage(worker, 'turn');
    expect(firstTurn).toMatchObject({ version: 2, taskId: task.id, sessionId: task.sessionId,
      policy: 'TEST POLICY', prompt: 'worker first', repositoryPath: sandbox.repository, modelId: 'auto' });
    expect(firstTurn.history).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/workers' })).json()[0].activeTaskIds).toEqual([task.id]);

    worker.socket.send(JSON.stringify({ version: 2, type: 'event', taskId: task.id,
      kind: 'question', payload: { type: 'question', questionId: 'question-1', prompt: 'Choose a path', choices: ['A', 'B'] } }));
    worker.socket.send(JSON.stringify({ version: 2, type: 'event', taskId: task.id,
      kind: 'tool-completed', payload: { toolName: 'edit', message: 'Changed a file' } }));
    worker.socket.send(JSON.stringify({ version: 2, type: 'complete', taskId: task.id }));
    await waitFor(async () => (await taskFrom(app, task.id)).state === 'completed');
    const firstEvents = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/events` })).json();
    expect(firstEvents.filter((event: { kind: string; payload?: { type?: string; prompt?: string } }) =>
      event.kind === 'agent_event' && event.payload?.type === 'question')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ prompt: 'Choose a path' }) }),
    ]);
    expect(firstEvents.map((event: { sequence: number }) => event.sequence)
      .every((sequence: number, index: number) => sequence === index + 1)).toBe(true);

    expect((await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/messages`,
      payload: { prompt: 'worker second' } })).statusCode).toBe(200);
    const secondTurn = await takeWorkerMessage(worker, 'turn');
    expect(secondTurn).toMatchObject({ taskId: task.id, sessionId: task.sessionId, prompt: 'worker second' });
    expect(secondTurn.history).toEqual(expect.arrayContaining([{ role: 'user', content: 'worker first' }]));
    worker.socket.send(JSON.stringify({ version: 2, type: 'complete', taskId: task.id }));
    await waitFor(async () => (await taskFrom(app, task.id)).state === 'completed');
    worker.socket.close();
  });

  it('persists and dispatches a selected conversation model', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const worker = await connectWorker(address, sandbox.repository);
    const models = (await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/models` })).json();
    expect(models.map((model: { id: string }) => model.id)).toEqual(expect.arrayContaining(['auto', 'test-model']));

    const created = await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`,
      payload: { prompt: 'selected model', modelId: 'test-model' } });
    expect(created.json().modelId).toBe('test-model');
    expect(await takeWorkerMessage(worker, 'turn')).toMatchObject({ modelId: 'test-model' });
    worker.socket.send(JSON.stringify({ version: 2, type: 'complete', taskId: created.json().id }));
    await waitFor(async () => (await taskFrom(app, created.json().id)).state === 'completed');

    const unavailable = await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`,
      payload: { prompt: 'bad model', modelId: 'not-a-model' } });
    expect(unavailable.statusCode).toBe(400);
    expect(unavailable.json().error).toContain('not available');
    worker.socket.close();
  });

  it('waits for a worker terminal state before resolving stop', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const worker = await connectWorker(address, sandbox.repository);
    const task = (await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`,
      payload: { prompt: 'worker wait' } })).json() as Task;
    await takeWorkerMessage(worker, 'turn');

    const stoppedResponse = app.inject({ method: 'POST', url: `/api/tasks/${task.id}/stop`,
      payload: { confirmed: true, stoppedBy: 'integration-test' } });
    expect(await takeWorkerMessage(worker, 'cancel')).toMatchObject({ taskId: task.id });
    expect((await taskFrom(app, task.id)).state).toBe('stopping');
    worker.socket.send(JSON.stringify({ version: 2, type: 'stopped', taskId: task.id }));
    expect((await stoppedResponse).json()).toMatchObject({ state: 'stopped', stoppedBy: 'integration-test' });
    worker.socket.close();
  });

  it('interrupts a worker task when its connection drops', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const worker = await connectWorker(address, sandbox.repository);
    const task = (await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`,
      payload: { prompt: 'worker disconnect' } })).json() as Task;
    await takeWorkerMessage(worker, 'turn');
    worker.socket.close();
    await waitFor(async () => (await taskFrom(app, task.id)).state === 'interrupted');
    expect((await app.inject({ method: 'GET', url: '/api/workers' })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/events` })).json())
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'process_error',
        payload: expect.objectContaining({ message: 'Worker disconnected' }) })]));
  });

  it('rejects task creation in worker-only mode when the repository window is closed', async () => {
    const sandbox = await makeSandbox();
    const config = configuration(sandbox.dataDir);
    config.agentBackend = 'worker';
    const app = await trackedApp(config);
    const repository = await register(app, sandbox.repository);
    const response = await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`,
      payload: { prompt: 'must not fall back' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('Open that repository in VS Code');
    expect((await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/tasks` })).json()).toEqual([]);
  });

  it('rejects task creation when a connected worker exposes no models', async () => {
    const sandbox = await makeSandbox();
    const config = configuration(sandbox.dataDir);
    config.agentBackend = 'worker';
    const app = await trackedApp(config);
    const repository = await register(app, sandbox.repository);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const worker = await connectWorker(address, sandbox.repository, []);
    const response = await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`,
      payload: { prompt: 'cannot run' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('No Copilot model');
    worker.socket.close();
  });

  it('blocks traversal and symlink escapes while serving managed and checkout previews', async () => {
    const sandbox = await makeSandbox();
    const outside = join(sandbox.root, 'secret.html');
    await writeFile(outside, 'secret');
    await writeFile(join(sandbox.repository, 'page.html'), '<h1>page</h1><script src="/app.js"></script>');
    await symlink(outside, join(sandbox.repository, 'escape.html'));
    await expect(readPreviewFile(sandbox.repository, '../secret.html')).rejects.toMatchObject({ statusCode: 403 });
    await expect(readPreviewFile(sandbox.repository, 'escape.html')).rejects.toMatchObject({ statusCode: 403 });

    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    expect((await app.inject({ method: 'GET', url: `/previews/${repository.id}` })).body).toContain('Sandbox');
    const page = (await app.inject({ method: 'GET', url: `/previews/${repository.id}/repo/page.html` })).body;
    expect(page).toContain('page');
    expect(page).toContain(`/previews/${repository.id}/repo/app.js`);
    expect((await app.inject({ method: 'GET', url: `/previews/${repository.id}/repo/escape.html` })).statusCode).toBe(403);
  });

  it('reattaches to a real PTY through the detached Unix-socket host', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    const terminal = (await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/terminals`, payload: { name: 'main' } })).json();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `${address.replace('http', 'ws')}/ws/terminals/${terminal.id}`;
    const first = new WebSocket(url);
    const firstOutput = await collectUntil(first, 'ready');
    expect(firstOutput).toContain('ready');
    first.send(JSON.stringify({ action: 'input', data: "printf 'PTY_PERSISTS\\n'\n" }));
    await collectUntil(first, 'PTY_PERSISTS');
    first.close();

    const second = new WebSocket(url);
    expect(await collectUntil(second, 'PTY_PERSISTS')).toContain('PTY_PERSISTS');
    second.send(JSON.stringify({ action: 'input', data: 'exit\n' }));
    await collectUntil(second, '"type":"exit"');
    second.close();
    await waitFor(async () => (await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/terminals` })).json()[0].status === 'exited');
    const third = new WebSocket(url);
    const closeCode = await new Promise<number>((resolve, reject) => {
      third.once('close', resolve);
      third.once('error', reject);
    });
    expect(closeCode).toBe(1008);
    const pidFile = join(sandbox.dataDir, 'terminal-host.sock.pid');
    await waitFor(async () => { try { return Boolean(await readFile(pidFile)); } catch { return false; } });
    hostPids.push(Number((await readFile(pidFile, 'utf8')).trim()));
  });

  it('marks a terminal exited when its host restarts without the PTY', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    const terminal = (await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/terminals`, payload: { name: 'lost' } })).json();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `${address.replace('http', 'ws')}/ws/terminals/${terminal.id}`;
    const first = new WebSocket(url);
    await collectUntil(first, 'ready');

    const pidFile = join(sandbox.dataDir, 'terminal-host.sock.pid');
    const firstHostPid = Number((await readFile(pidFile, 'utf8')).trim());
    process.kill(firstHostPid, 'SIGTERM');
    await waitFor(async () => !processExists(firstHostPid));

    const second = new WebSocket(url);
    expect(await collectUntil(second, '"type":"missing"')).toContain('missing');
    await waitFor(async () => (await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/terminals` })).json()[0].status === 'exited');
    await waitFor(async () => {
      try {
        const restartedPid = Number((await readFile(pidFile, 'utf8')).trim());
        if (restartedPid !== firstHostPid) { hostPids.push(restartedPid); return true; }
      } catch { /* Host is still restarting. */ }
      return false;
    });
  });
});

describe('bounded JSONL parser', () => {
  it('parses structured and raw lines and rejects oversized records', () => {
    const values: unknown[] = [];
    const parser = new JsonLineParser(16, (value) => values.push(value));
    parser.write(Buffer.from('{"ok":true}\nraw\n'));
    parser.write(Buffer.from('x'.repeat(17)));
    parser.write(Buffer.from('discarded-tail\n{"next":true}\n'));
    expect(values).toEqual([{ ok: true }, { type: 'raw_stdout', text: 'raw' },
      { type: 'parse_error', reason: 'line_too_large', bytes: 17 }, { next: true }]);
  });
});

describe('server configuration', () => {
  it('accepts only positive integer byte limits', () => {
    expect(positiveInteger(undefined, 64, 'LIMIT')).toBe(64);
    expect(positiveInteger('128', 64, 'LIMIT')).toBe(128);
    for (const invalid of ['0', '-1', '1.5', 'NaN', 'Infinity']) {
      expect(() => positiveInteger(invalid, 64, 'LIMIT')).toThrow('LIMIT must be a positive integer');
    }
  });
});

describe('GitHub pull request normalization', () => {
  it('maps status rollups into displayable checks', () => {
    expect(normalizePullRequest({ number: 4, statusCheckRollup: [
      { name: 'unit tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { context: 'lint', state: 'PENDING' },
    ] })).toMatchObject({ checks: [{ name: 'unit tests', state: 'SUCCESS' }, { name: 'lint', state: 'PENDING' }] });
  });
});

async function makeSandbox(): Promise<{ root: string; dataDir: string; repository: string }> {
  await chmod(fixtureAgent, 0o755);
  const root = await mkdtemp(join(tmpdir(), 'jarvis-server-'));
  const repository = join(root, 'repository');
  const dataDir = join(root, 'data');
  await mkdir(join(repository, 'nested'), { recursive: true });
  await git(repository, ['init', '--initial-branch=main']);
  await git(repository, ['config', 'user.email', 'fixture@example.test']);
  await git(repository, ['config', 'user.name', 'Fixture']);
  await writeFile(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['add', 'README.md']);
  await git(repository, ['commit', '-m', 'initial']);
  return { root, dataDir, repository };
}

function configuration(dataDir: string): ServerConfig {
  return { dataDir, host: '127.0.0.1', port: 0, agentExecutable: fixtureAgent, agentBackend: 'auto', policy: 'TEST POLICY',
    terminalHostScript: terminalHost, maxJsonLineBytes: 1024 * 1024, maxStderrChunkBytes: 64 * 1024 };
}

async function trackedApp(config: ServerConfig): Promise<Awaited<ReturnType<typeof createApp>>> {
  const app = await createApp(config); apps.push(app); return app;
}

async function register(app: Awaited<ReturnType<typeof createApp>>, path: string): Promise<{ id: string }> {
  const response = await app.inject({ method: 'POST', url: '/api/repositories', payload: { name: 'Sandbox', path } });
  expect(response.statusCode).toBe(201); return response.json();
}

async function taskFrom(app: Awaited<ReturnType<typeof createApp>>, id: string): Promise<Task> {
  return (await app.inject({ method: 'GET', url: `/api/tasks/${id}` })).json() as Task;
}

async function git(cwd: string, args: string[]): Promise<void> { await execFileAsync('git', ['-C', cwd, ...args]); }
async function waitFor(predicate: () => Promise<boolean>, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for condition');
}
async function onceOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === socket.OPEN) return;
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
}
async function collectUntil(socket: WebSocket, needle: string): Promise<string> {
  let output = '';
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${needle}: ${output}`)), 5000);
    socket.on('message', (message) => {
      output += message.toString();
      if (output.includes(needle)) { clearTimeout(timeout); resolvePromise(output); }
    });
    socket.once('error', reject);
  });
}
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface WorkerClient { socket: WebSocket; messages: Record<string, unknown>[] }

async function connectWorker(address: string, workspaceRoot: string, models = [
  { id: 'auto', name: 'Auto', vendor: 'copilot', family: 'auto', version: '1', maxInputTokens: 1000 },
  { id: 'test-model', name: 'Test Model', vendor: 'copilot', family: 'test', version: '1', maxInputTokens: 1000 },
]): Promise<WorkerClient> {
  const socket = new WebSocket(`${address.replace('http', 'ws')}/ws/workers`);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (message) => messages.push(JSON.parse(message.toString()) as Record<string, unknown>));
  await onceOpen(socket);
  socket.send(JSON.stringify({ version: 2, type: 'hello', workerId: 'test-worker', windowName: 'test-window',
    workspaceRoots: [workspaceRoot], models }));
  const worker = { socket, messages };
  await takeWorkerMessage(worker, 'ready');
  return worker;
}

async function takeWorkerMessage(worker: WorkerClient, type: string): Promise<Record<string, unknown>> {
  await waitFor(async () => worker.messages.some((message) => message.type === type));
  const index = worker.messages.findIndex((message) => message.type === type);
  return worker.messages.splice(index, 1)[0];
}
