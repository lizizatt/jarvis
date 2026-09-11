import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { absolutePath, isLoopbackHost, nodeTimeout, positiveInteger, tcpPort } from '../src/config.js';
import { Store } from '../src/database.js';
import { normalizePullRequest } from '../src/git.js';
import { readPreviewFile } from '../src/previews.js';
import { JsonLineParser } from '../src/tasks.js';
import { TerminalManager } from '../src/terminals.js';
import type { ServerConfig, Task } from '../src/types.js';
import { modelHistory } from '../src/workers.js';

const execFileAsync = promisify(execFile);
const fixtureAgent = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/agent.mjs');
const terminalHost = resolve(dirname(fileURLToPath(import.meta.url)), '../src/terminal-host.ts');
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const hostPids: number[] = [];
const sandboxRoots: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const pid of hostPids.splice(0)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await Promise.all(sandboxRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('server MVP', () => {
  it('recognizes only local server bind addresses as loopback', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
  });

  it('migrates durable state and marks active tasks interrupted on startup', async () => {
    const sandbox = await makeSandbox();
    const store = new Store(join(sandbox.dataDir, 'jarvis.sqlite3'));
    const now = new Date().toISOString();
    store.insertRepository({ id: 'repo', name: 'Repo', path: sandbox.repository, defaultBranch: 'main', createdAt: now, updatedAt: now });
    store.insertTask({ id: 'task', repositoryId: 'repo', sessionId: 'session', origin: 'jarvis-pwa', clientConversationId: null, state: 'running', createdAt: now,
      updatedAt: now, stoppedBy: null, stoppedAt: null, exitCode: null, modelId: 'auto' });
    store.close();

    const app = await trackedApp(configuration(sandbox.dataDir));
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ ok: true, interruptedOnStartup: 1 });
    expect((await app.inject({ method: 'GET', url: '/api/tasks/task' })).json().state).toBe('interrupted');
  });

  it('keeps liveness healthy while required web and terminal capabilities are unavailable', async () => {
    const sandbox = await makeSandbox();
    const webRoot = join(sandbox.root, 'web');
    await mkdir(webRoot);
    const app = await trackedApp({
      ...configuration(sandbox.dataDir),
      webRoot,
      readinessWebRequired: true,
      readinessTerminalHostRequired: true,
    });

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });

    const readiness = await app.inject({ method: 'GET', url: '/api/readiness' });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toEqual({
      ok: false,
      checks: {
        web: { ok: false, detail: `Web entry file is missing: ${join(webRoot, 'index.html')}` },
        terminalHost: { ok: false, detail: `Terminal host socket is unavailable: ${join(sandbox.dataDir, 'terminal-host.sock')}` },
      },
    });
    expect(existsSync(join(sandbox.dataDir, 'terminal-host.sock'))).toBe(false);
    expect(existsSync(join(sandbox.dataDir, 'terminal-host.sock.pid'))).toBe(false);
  });

  it('stays unready when the web entry appears after static route registration was skipped', async () => {
    const sandbox = await makeSandbox();
    const webRoot = join(sandbox.root, 'late-web');
    const app = await trackedApp({
      ...configuration(sandbox.dataDir),
      webRoot,
      readinessWebRequired: true,
    });

    await mkdir(webRoot);
    await writeFile(join(webRoot, 'index.html'), '<main>Too late</main>');

    const readiness = await app.inject({ method: 'GET', url: '/api/readiness' });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({ ok: false, checks: { web: { ok: false } } });
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  });

  it('rejects a terminal host peer that closes without answering the protocol probe', async () => {
    const sandbox = await makeSandbox();
    const socketPath = join(sandbox.dataDir, 'terminal-host.sock');
    await mkdir(sandbox.dataDir);
    const terminalSocketServer = createServer((socket) => { socket.resume(); socket.end(); });
    await new Promise<void>((resolvePromise, reject) => {
      terminalSocketServer.once('error', reject);
      terminalSocketServer.listen(socketPath, resolvePromise);
    });

    try {
      const terminals = new TerminalManager(socketPath, terminalHost, true);
      expect(await terminals.isHostAvailable()).toBe(false);
    } finally {
      await new Promise<void>((resolvePromise, reject) => terminalSocketServer.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it('rejects a terminal host peer that accepts the probe without responding', async () => {
    const sandbox = await makeSandbox();
    const socketPath = join(sandbox.dataDir, 'terminal-host.sock');
    await mkdir(sandbox.dataDir);
    const terminalSocketServer = createServer((socket) => socket.resume());
    await new Promise<void>((resolvePromise, reject) => {
      terminalSocketServer.once('error', reject);
      terminalSocketServer.listen(socketPath, resolvePromise);
    });

    try {
      const terminals = new TerminalManager(socketPath, terminalHost, true);
      expect(await terminals.isHostAvailable()).toBe(false);
    } finally {
      await new Promise<void>((resolvePromise, reject) => terminalSocketServer.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it('reports ready when the web entry exists and the real terminal host answers the protocol probe', async () => {
    const sandbox = await makeSandbox();
    const webRoot = join(sandbox.root, 'web');
    const socketPath = join(sandbox.dataDir, 'terminal-host.sock');
    await Promise.all([mkdir(webRoot), mkdir(sandbox.dataDir)]);
    await writeFile(join(webRoot, 'index.html'), '<main>Jarvis fixture</main>');
    await startTerminalHost(socketPath);
    const app = await trackedApp({
      ...configuration(sandbox.dataDir),
      webRoot,
      readinessWebRequired: true,
      readinessTerminalHostRequired: true,
    });

    const readiness = await app.inject({ method: 'GET', url: '/api/readiness' });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toEqual({
      ok: true,
      checks: { web: { ok: true }, terminalHost: { ok: true } },
    });
    expect((await app.inject({ method: 'GET', url: '/api/workers' })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/' })).body).toContain('Jarvis fixture');
  });

  it('reports current host metrics with per-core load and bounded history', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const metrics = (await app.inject({ method: 'GET', url: '/api/metrics' })).json();
    expect(metrics.cpuCount).toBeGreaterThan(0);
    expect(metrics.perCorePercent.length).toBe(metrics.cpuCount);
    expect(metrics.memoryTotalBytes).toBeGreaterThan(0);
    expect(metrics.history.length).toBeGreaterThan(0);
  });

  it('exposes validated loopback ports through Tailscale', async () => {
    const sandbox = await makeSandbox();
    const executable = join(sandbox.root, 'tailscale');
    const calls = join(sandbox.root, 'tailscale-calls');
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
if [ "$1" = status ]; then printf '%s' '{"Self":{"DNSName":"jarvis.example.ts.net."}}'; fi
`);
    await chmod(executable, 0o700);
    const app = await trackedApp({ ...configuration(sandbox.dataDir), tailscaleExecutable: executable });

    const exposed = await app.inject({ method: 'POST', url: '/api/settings/port-forwards', payload: { port: 8080 } });
    expect(exposed.statusCode).toBe(200);
    expect(exposed.json()).toEqual({ port: 8080, url: 'https://jarvis.example.ts.net:8080/' });
    const invalid = await app.inject({ method: 'POST', url: '/api/settings/port-forwards', payload: { port: 65_536 } });
    expect(invalid.statusCode).toBe(400);
    expect(await readFile(calls, 'utf8')).not.toContain('65536');
  });

  it('turns off an exposed port through Tailscale', async () => {
    const sandbox = await makeSandbox();
    const executable = join(sandbox.root, 'tailscale');
    const calls = join(sandbox.root, 'tailscale-calls');
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
`);
    await chmod(executable, 0o700);
    const app = await trackedApp({ ...configuration(sandbox.dataDir), tailscaleExecutable: executable });

    const closed = await app.inject({ method: 'DELETE', url: '/api/settings/port-forwards/8080' });
    expect(closed.statusCode).toBe(204);
    expect(await readFile(calls, 'utf8')).toBe('serve --yes --https=8080 off\n');
  });

  it('lists currently exposed ports by reading live Tailscale Serve state', async () => {
    const sandbox = await makeSandbox();
    const executable = join(sandbox.root, 'tailscale');
    await writeFile(executable, `#!/bin/sh
if [ "$1" = serve ] && [ "$2" = status ]; then printf '%s' '{"Web":{"jarvis.example.ts.net:8080":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8080/"}}}}}'; fi
`);
    await chmod(executable, 0o700);
    const app = await trackedApp({ ...configuration(sandbox.dataDir), tailscaleExecutable: executable });

    const listed = await app.inject({ method: 'GET', url: '/api/settings/port-forwards' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([{ port: 8080, url: 'https://jarvis.example.ts.net:8080/' }]);
  });

  it('lists and controls only registered deployments', async () => {
    const sandbox = await makeSandbox();
    const systemctl = join(sandbox.root, 'systemctl');
    const calls = join(sandbox.root, 'systemctl-calls');
    const manifest = join(sandbox.root, 'deployment.json');
    const registry = join(sandbox.root, 'deployments.json');
    await writeFile(systemctl, `#!/bin/sh
if [ "$2" = show ]; then
  printf '%s\n' 'LoadState=loaded' 'ActiveState=inactive' 'SubState=dead' 'UnitFileState=enabled'
else
  printf '%s\n' "$*" >> "${calls}"
fi
`);
    await chmod(systemctl, 0o700);
    await writeFile(manifest, JSON.stringify({ version: 1, id: 'alesis', name: 'Alesis', kind: 'managed',
      systemdUnit: 'jarvis-alesis.service', runner: 'deploy/run-jarvis.sh', actions: ['start', 'stop', 'restart'] }));
    await writeFile(registry, JSON.stringify({ version: 1, manifests: [manifest] }));
    const app = await trackedApp({ ...configuration(sandbox.dataDir), deploymentRegistryFile: registry, systemctlExecutable: systemctl });

    const listed = await app.inject({ method: 'GET', url: '/api/deployments' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([{ id: 'alesis', name: 'Alesis', kind: 'managed', state: 'stopped',
      enabled: true, healthy: null, actions: ['start', 'stop', 'restart'] }]);
    expect((await app.inject({ method: 'POST', url: '/api/deployments/alesis/actions', payload: { action: 'start' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/deployments/missing/actions', payload: { action: 'restart' } })).statusCode).toBe(404);
    expect(await readFile(calls, 'utf8')).toBe('--user start jarvis-alesis.service\n');
  });

  it('allows a delayed managed action to finish within its configured budget', async () => {
    const sandbox = await makeSandbox();
    const app = await deploymentActionApp(sandbox, 'setTimeout(() => process.exit(0), 30);', 100);

    const response = await app.inject({
      method: 'POST',
      url: '/api/deployments/alesis/actions',
      payload: { action: 'restart' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true, scheduled: false });
  });

  it('reports a managed action timeout separately from command failures', async () => {
    const sandbox = await makeSandbox();
    const app = await deploymentActionApp(sandbox, 'setTimeout(() => process.exit(0), 100);', 10);

    const response = await app.inject({
      method: 'POST',
      url: '/api/deployments/alesis/actions',
      payload: { action: 'restart' },
    });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({ error: 'Managed action restart for Alesis timed out after 10 ms' });
  });

  it('reports a managed action command error without classifying it as a timeout', async () => {
    const sandbox = await makeSandbox();
    const app = await deploymentActionApp(sandbox, "process.stderr.write('fixture action failed\\n'); process.exit(23);", 100);

    const response = await app.inject({
      method: 'POST',
      url: '/api/deployments/alesis/actions',
      payload: { action: 'restart' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('fixture action failed');
    expect(response.json().error).not.toContain('timed out');
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

  it('reports Copilot presence and opens an inactive repository in VS Code', async () => {
    const sandbox = await makeSandbox();
    const executable = join(sandbox.root, 'code');
    const calls = join(sandbox.root, 'code-calls');
    await writeFile(executable, `#!/bin/sh
printf '%s\n' "$@" > "${calls}"
`);
    await chmod(executable, 0o700);
    const app = await trackedApp({ ...configuration(sandbox.dataDir), editorExecutable: executable });
    const repository = await register(app, sandbox.repository);

    expect((await app.inject({ method: 'GET', url: '/api/repositories' })).json()[0]).toMatchObject({
      id: repository.id,
      copilotActive: false,
    });
    const opened = await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/copilot` });
    expect(opened.statusCode).toBe(202);
    await waitFor(async () => existsSync(calls));
    expect(await readFile(calls, 'utf8')).toBe(`--new-window\n${sandbox.repository}\n`);
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

  it('pulls the current branch from origin only when the checkout is clean', async () => {
    const sandbox = await makeSandbox();
    const remote = join(sandbox.root, 'remote.git');
    await git(sandbox.root, ['init', '--bare', remote]);
    await git(sandbox.repository, ['remote', 'add', 'origin', remote]);
    await git(sandbox.repository, ['push', '--set-upstream', 'origin', 'main']);
    const upstream = join(sandbox.root, 'upstream');
    await execFileAsync('git', ['clone', '--branch', 'main', remote, upstream]);
    await writeFile(join(upstream, 'from-origin.txt'), 'pulled\n');
    await git(upstream, ['config', 'user.email', 'fixture@example.test']);
    await git(upstream, ['config', 'user.name', 'Fixture']);
    await git(upstream, ['add', 'from-origin.txt']);
    await git(upstream, ['commit', '-m', 'from origin']);
    await git(upstream, ['push', 'origin', 'main']);

    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    const status = (await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/status` })).json();
    expect(status.clean).toBe(true);
    const pulled = await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/pull` });
    expect(pulled.statusCode).toBe(200);
    expect(pulled.json()).toMatchObject({ ok: true, branch: 'main' });
    expect(await readFile(join(sandbox.repository, 'from-origin.txt'), 'utf8')).toBe('pulled\n');

    await writeFile(join(sandbox.repository, 'untracked.txt'), 'local\n');
    const rejected = await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/pull` });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toEqual({ error: 'Repository must be clean before pulling' });
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

  it('batches active task and event loading for repository summaries', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`, payload: { prompt: 'HANG dashboard batch' } });
    await waitFor(async () => (await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/tasks` })).json()[0]?.state === 'running');

    const listTasks = Store.prototype.listTasks;
    const listEvents = Store.prototype.listEvents;
    Store.prototype.listTasks = () => { throw new Error('Repository summaries must batch task loading'); };
    Store.prototype.listEvents = () => { throw new Error('Repository summaries must batch event loading'); };
    try {
      const summary = (await app.inject({ method: 'GET', url: '/api/repositories' })).json()[0].activeTask;
      expect(summary).toMatchObject({ id: expect.any(String), title: 'HANG dashboard batch' });
    } finally {
      Store.prototype.listTasks = listTasks;
      Store.prototype.listEvents = listEvents;
    }
  });

  it('lists task history without loading every event payload', async () => {
    const sandbox = await makeSandbox();
    const now = new Date().toISOString();
    const store = new Store(join(sandbox.dataDir, 'jarvis.sqlite3'));
    store.insertRepository({ id: 'repo', name: 'Repo', path: sandbox.repository, defaultBranch: 'main', createdAt: now, updatedAt: now });
    store.insertTask({ id: 'task', repositoryId: 'repo', sessionId: 'session', origin: 'jarvis-pwa', clientConversationId: null,
      state: 'completed', createdAt: now, updatedAt: now, stoppedBy: null, stoppedAt: null, exitCode: 0, modelId: 'auto' });
    store.appendEvent('task', 'user_message', { text: 'Recover this history' });
    store.appendEvent('task', 'lifecycle', { state: 'completed' });
    store.close();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const listEvents = Store.prototype.listEvents;
    Store.prototype.listEvents = () => { throw new Error('History listing must not load full event payloads'); };
    try {
      const response = await app.inject({ method: 'GET', url: '/api/repositories/repo/tasks' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([expect.objectContaining({ title: 'Recover this history', latestAction: 'completed' })]);
    } finally {
      Store.prototype.listEvents = listEvents;
    }
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

  it('deletes a finished task but rejects deleting an active one', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    const finished = (await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`,
      payload: { prompt: 'mention question casually' } })).json() as Task;
    await waitFor(async () => (await taskFrom(app, finished.id)).state === 'completed');
    const active = (await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`, payload: { prompt: 'HANG' } })).json() as Task;
    expect((await app.inject({ method: 'DELETE', url: `/api/tasks/${active.id}` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/tasks/${finished.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${finished.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/tasks/${finished.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/tasks/does-not-exist' })).statusCode).toBe(404);
    await app.inject({ method: 'POST', url: `/api/tasks/${active.id}/stop`, payload: { confirmed: true } });
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
      workerId: 'test-worker', windowName: 'test-window', windowPid: process.pid, workspaceRoots: [sandbox.repository],
      models: expect.arrayContaining([expect.objectContaining({ id: 'auto', vendor: 'copilot' })]),
      activeTaskIds: [], activity: 'idle', presence: { focused: true, active: true },
    }]);
    expect((await app.inject({ method: 'GET', url: '/api/repositories' })).json()[0].copilotActive).toBe(true);
    worker.socket.send(JSON.stringify({ version: 2, type: 'hello', workerId: 'test-worker', windowName: 'test-window',
      workspaceRoots: [workerRoot], models: [],
      presence: { focused: false, active: true, updatedAt: new Date().toISOString() } }));
    await waitFor(async () => (await app.inject({ method: 'GET', url: '/api/workers' })).json()[0].presence.focused === false);
    expect((await app.inject({ method: 'GET', url: '/api/workers' })).json()[0]).toMatchObject({
      activity: 'idle', presence: { focused: false, active: true },
    });
    const task = (await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`,
      payload: { prompt: 'worker first' } })).json() as Task;
    const firstTurn = await takeWorkerMessage(worker, 'turn');
    expect(firstTurn).toMatchObject({ version: 2, taskId: task.id, sessionId: task.sessionId,
      policy: 'TEST POLICY', prompt: 'worker first', repositoryPath: sandbox.repository, modelId: 'auto' });
    expect(firstTurn.history).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/workers' })).json()[0]).toMatchObject({
      activeTaskIds: [task.id], activity: 'thinking',
    });

    worker.socket.send(JSON.stringify({ version: 2, type: 'event', taskId: task.id,
      kind: 'question', payload: { type: 'question', questionId: 'question-1', prompt: 'Choose a path', choices: ['A', 'B'] } }));
    await waitFor(async () => (await app.inject({ method: 'GET', url: '/api/workers' })).json()[0].activity === 'needs-input');
    worker.socket.send(JSON.stringify({ version: 2, type: 'event', taskId: task.id,
      kind: 'tool-completed', payload: { toolName: 'edit', message: 'Changed a file' } }));
    worker.socket.send(JSON.stringify({ version: 2, type: 'complete', taskId: task.id }));
    await waitFor(async () => (await taskFrom(app, task.id)).state === 'completed');
    expect((await app.inject({ method: 'GET', url: '/api/workers' })).json()[0].activity).toBe('idle');
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
    expect((await app.inject({ method: 'GET', url: '/api/workers' })).json()[0].activity).toBe('thinking');
    expect(secondTurn).toMatchObject({ taskId: task.id, sessionId: task.sessionId, prompt: 'worker second' });
    expect(secondTurn.history).toEqual(expect.arrayContaining([{ role: 'user', content: 'worker first' }]));
    worker.socket.send(JSON.stringify({ version: 2, type: 'complete', taskId: task.id }));
    await waitFor(async () => (await taskFrom(app, task.id)).state === 'completed');
    expect((await app.inject({ method: 'GET', url: '/api/workers' })).json()[0].activity).toBe('idle');
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

  it('persists VS Code Chat task provenance and delivers its opaque key to the worker', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const worker = await connectWorker(address, sandbox.repository);

    const created = await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`, payload: {
      prompt: 'from chat', origin: 'vscode-chat', clientConversationId: 'chat-key', modelId: 'test-model',
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ origin: 'vscode-chat', clientConversationId: 'chat-key' });
    expect(await takeWorkerMessage(worker, 'turn')).toMatchObject({ clientConversationId: 'chat-key', modelId: 'test-model' });
    worker.socket.send(JSON.stringify({ version: 2, type: 'complete', taskId: created.json().id }));
    await waitFor(async () => (await taskFrom(app, created.json().id)).state === 'completed');
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

  it('interrupts a worker task when cancellation times out', async () => {
    const sandbox = await makeSandbox();
    const app = await trackedApp(configuration(sandbox.dataDir));
    const repository = await register(app, sandbox.repository);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const worker = await connectWorker(address, sandbox.repository);
    const task = (await app.inject({ method: 'POST', url: `/api/repositories/${repository.id}/tasks`,
      payload: { prompt: 'worker timeout' } })).json() as Task;
    await takeWorkerMessage(worker, 'turn');

    const stoppedResponse = app.inject({ method: 'POST', url: `/api/tasks/${task.id}/stop`,
      payload: { confirmed: true, stoppedBy: 'integration-test' } });
    expect(await takeWorkerMessage(worker, 'cancel')).toMatchObject({ taskId: task.id });
    await waitFor(async () => (await taskFrom(app, task.id)).state === 'interrupted', 7_000);
    expect((await stoppedResponse).json()).toMatchObject({ state: 'interrupted', stoppedBy: 'integration-test' });
    worker.socket.close();
  }, 8_000);

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

  it('advertises auto when CLI or auto mode has no worker models', async () => {
    for (const agentBackend of ['cli', 'auto'] as const) {
      const sandbox = await makeSandbox();
      const config = configuration(sandbox.dataDir);
      config.agentBackend = agentBackend;
      const app = await trackedApp(config);
      const repository = await register(app, sandbox.repository);
      const models = (await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/models` })).json();
      expect(models).toEqual([expect.objectContaining({ id: 'auto', vendor: 'cli', family: 'auto' })]);
    }
  });

  it('rejects task creation when a connected worker exposes no models', async () => {
    const sandbox = await makeSandbox();
    const config = configuration(sandbox.dataDir);
    config.agentBackend = 'worker';
    const app = await trackedApp(config);
    const repository = await register(app, sandbox.repository);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const worker = await connectWorker(address, sandbox.repository, []);
    expect((await app.inject({ method: 'GET', url: `/api/repositories/${repository.id}/models` })).json()).toEqual([]);
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

describe('worker model history', () => {
  const event = (sequence: number, kind: string, payload: unknown) => ({
    id: sequence, taskId: 'task', sequence, kind, payload, createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('removes only the latest occurrence of the current prompt', () => {
    expect(modelHistory([
      event(1, 'user_message', { text: 'repeat' }),
      event(2, 'agent_event', { type: 'text', text: 'Acknowledged.' }),
      event(3, 'user_message', { text: 'repeat' }),
    ], 'repeat')).toEqual([
      { role: 'user', content: 'repeat' },
      { role: 'assistant', content: 'Acknowledged.' },
    ]);
  });

  it('returns no history when every stored message is the current prompt', () => {
    expect(modelHistory([event(1, 'user_message', { text: 'current prompt' })], 'current prompt')).toEqual([]);
  });

  it('merges consecutive agent text chunks into one assistant message', () => {
    expect(modelHistory([
      event(1, 'user_message', { text: 'first prompt' }),
      event(2, 'agent_event', { type: 'text', text: 'First ' }),
      event(3, 'agent_event', { type: 'text', text: 'response.' }),
      event(4, 'user_message', { text: 'current prompt' }),
    ], 'current prompt')).toEqual([
      { role: 'user', content: 'first prompt' },
      { role: 'assistant', content: 'First response.' },
    ]);
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

  it('caps Node timeouts without restricting unrelated positive integers', () => {
    expect(nodeTimeout(undefined, 45_000, 'TIMEOUT')).toBe(45_000);
    expect(nodeTimeout('2147483647', 45_000, 'TIMEOUT')).toBe(2_147_483_647);
    expect(() => nodeTimeout('2147483648', 45_000, 'TIMEOUT'))
      .toThrow('TIMEOUT must be a positive integer no greater than 2147483647');
    expect(positiveInteger('2147483648', 64, 'LIMIT')).toBe(2_147_483_648);
  });

  it('accepts only TCP ports and absolute configured paths', () => {
    expect(tcpPort(undefined, 3210, 'JARVIS_PORT')).toBe(3210);
    expect(tcpPort('4321', 3210, 'JARVIS_PORT')).toBe(4321);
    for (const invalid of ['0', '65536', '1.5', 'NaN']) {
      expect(() => tcpPort(invalid, 3210, 'JARVIS_PORT')).toThrow('JARVIS_PORT must be an integer from 1 through 65535');
    }
    expect(absolutePath('/tmp/deployments.json', '/default', 'REGISTRY')).toBe('/tmp/deployments.json');
    expect(() => absolutePath('deployments.json', '/default', 'REGISTRY')).toThrow('REGISTRY must be an absolute path');
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
  sandboxRoots.push(root);
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
  return { dataDir, host: '127.0.0.1', port: 0, agentExecutable: fixtureAgent, editorExecutable: 'code', agentBackend: 'auto', policy: 'TEST POLICY',
    terminalHostScript: terminalHost, maxJsonLineBytes: 1024 * 1024, maxStderrChunkBytes: 64 * 1024 };
}

async function deploymentActionApp(sandbox: { root: string; dataDir: string }, actionSource: string,
  timeoutMs: number): Promise<Awaited<ReturnType<typeof createApp>>> {
  const systemctl = join(sandbox.root, 'systemctl.mjs');
  const manifest = join(sandbox.root, 'deployment.json');
  const registry = join(sandbox.root, 'deployments.json');
  await writeFile(systemctl, `#!${process.execPath}\n${actionSource}\n`, { mode: 0o700 });
  await writeFile(manifest, JSON.stringify({ version: 1, id: 'alesis', name: 'Alesis', kind: 'managed',
    systemdUnit: 'jarvis-alesis.service', runner: 'deploy/run-jarvis.sh', actions: ['start', 'stop', 'restart'] }));
  await writeFile(registry, JSON.stringify({ version: 1, manifests: [manifest] }));
  return trackedApp({
    ...configuration(sandbox.dataDir),
    deploymentRegistryFile: registry,
    systemctlExecutable: systemctl,
    deploymentActionTimeoutMs: timeoutMs,
  });
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
async function startTerminalHost(socketPath: string): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', terminalHost, socketPath], { stdio: 'ignore' });
  await new Promise<void>((resolvePromise, reject) => {
    child.once('spawn', resolvePromise);
    child.once('error', reject);
  });
  if (!child.pid) throw new Error('Terminal host did not report a process ID');
  hostPids.push(child.pid);
  const terminals = new TerminalManager(socketPath, terminalHost, true);
  await waitFor(() => terminals.isHostAvailable());
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
    windowPid: process.pid, workspaceRoots: [workspaceRoot], models,
    presence: { focused: true, active: true, updatedAt: new Date().toISOString() } }));
  const worker = { socket, messages };
  await takeWorkerMessage(worker, 'ready');
  return worker;
}

async function takeWorkerMessage(worker: WorkerClient, type: string): Promise<Record<string, unknown>> {
  await waitFor(async () => worker.messages.some((message) => message.type === type));
  const index = worker.messages.findIndex((message) => message.type === type);
  return worker.messages.splice(index, 1)[0];
}
