import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PushSubscription } from 'web-push';
import { Store } from './database.js';
import { EventHub } from './events.js';
import { pullRequest, previewCandidates, repositoryDiff, repositoryStatus, repositoryStatusFiles, validateGitRoot } from './git.js';
import { CopilotUsageFetcher } from './copilot.js';
import { HostMetricsSampler } from './metrics.js';
import { ensureLanding, readPreviewFile, rewritePreviewHtml } from './previews.js';
import { PushService } from './push.js';
import { TaskManager } from './tasks.js';
import { TerminalManager } from './terminals.js';
import { ACTIVE_TASK_STATES, type Repository, type ServerConfig } from './types.js';
import { WorkerManager } from './workers.js';

interface IdParams { id: string }

export async function createApp(config: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const store = new Store(join(config.dataDir, 'jarvis.sqlite3'));
  const interrupted = store.interruptActiveTasks();
  const hub = new EventHub();
  hub.setMaxListeners(0);
  const push = new PushService(store);
  const workers = new WorkerManager();
  const tasks = new TaskManager(store, hub, push, config, workers);
  const terminals = new TerminalManager(join(config.dataDir, 'terminal-host.sock'), config.terminalHostScript!, config.terminalHostExternal);
  const metrics = new HostMetricsSampler();
  const copilot = new CopilotUsageFetcher();
  await app.register(websocket);

  app.addHook('onClose', async () => { await tasks.shutdown(); workers.close(); hub.removeAllListeners(); store.close(); metrics.close(); });
  app.get('/api/health', async () => ({ ok: true, interruptedOnStartup: interrupted }));
  app.get('/api/metrics', async () => metrics.current());
  app.get('/api/copilot-usage', async () => copilot.current());
  app.get('/api/config', async () => ({ agentExecutable: config.agentExecutable, policy: config.policy,
    vapidPublicKey: push.publicKey, terminalPersistence: 'node-pty-detached-host' }));
  app.get('/api/workers', async () => workers.list());

  app.get('/api/repositories', async () => store.listRepositories().map((repository) => {
    const activeTask = store.listTasks(repository.id).find((task) => ACTIVE_TASK_STATES.includes(task.state));
    return { ...repository, previewUrl: `/previews/${repository.id}`,
      activeTask: activeTask ? taskSummary(store, activeTask) : null };
  }));
  app.post<{ Body: { name?: string; path?: string; defaultBranch?: string | null } }>('/api/repositories', async (request, reply) => {
    if (!request.body?.name?.trim() || !request.body.path) return reply.code(400).send({ error: 'name and path are required' });
    try {
      const gitRoot = await validateGitRoot(request.body.path);
      const now = new Date().toISOString();
      const repository: Repository = { id: randomUUID(), name: request.body.name.trim(), path: gitRoot.path,
        defaultBranch: request.body.defaultBranch ?? gitRoot.branch, createdAt: now, updatedAt: now };
      store.insertRepository(repository);
      await ensureLanding(join(config.dataDir, 'previews'), repository.id, repository.name);
      return reply.code(201).send({ ...repository, previewUrl: `/previews/${repository.id}` });
    } catch (error) { return sendKnownError(reply, error); }
  });
  app.get<{ Params: IdParams }>('/api/repositories/:id', async (request, reply) => {
    const repository = store.getRepository(request.params.id);
    return repository ? { ...repository, previewUrl: `/previews/${repository.id}` } : reply.code(404).send({ error: 'Repository not found' });
  });
  app.put<{ Params: IdParams; Body: { name?: string; defaultBranch?: string | null } }>('/api/repositories/:id', async (request, reply) => {
    const current = store.getRepository(request.params.id);
    if (!current) return reply.code(404).send({ error: 'Repository not found' });
    return store.updateRepository(current.id, { name: request.body.name?.trim() || current.name,
      defaultBranch: request.body.defaultBranch === undefined ? current.defaultBranch : request.body.defaultBranch });
  });
  app.delete<{ Params: IdParams }>('/api/repositories/:id', async (request, reply) => {
    if (store.listTasks(request.params.id).some((task) => ACTIVE_TASK_STATES.includes(task.state))) {
      return reply.code(409).send({ error: 'Repository has an active task' });
    }
    return store.deleteRepository(request.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'Repository not found' });
  });
  app.get<{ Params: IdParams }>('/api/repositories/:id/status', async (request, reply) => withRepository(store, request.params.id, reply, repositoryStatus));
  app.get<{ Params: IdParams; Querystring: { staged?: string } }>('/api/repositories/:id/diff', async (request, reply) =>
    withRepository(store, request.params.id, reply, (path) => repositoryDiff(path, request.query.staged === 'true')));
  app.get<{ Params: IdParams }>('/api/repositories/:id/status-files', async (request, reply) => withRepository(store, request.params.id, reply, repositoryStatusFiles));
  app.get<{ Params: IdParams }>('/api/repositories/:id/preview-files', async (request, reply) => withRepository(store, request.params.id, reply, previewCandidates));
  app.get<{ Params: IdParams }>('/api/repositories/:id/pull-request', async (request, reply) => withRepository(store, request.params.id, reply, pullRequest));
  app.get<{ Params: IdParams }>('/api/repositories/:id/models', async (request, reply) => {
    const repository = store.getRepository(request.params.id);
    if (!repository) return reply.code(404).send({ error: 'Repository not found' });
    const workerModels = workers.modelsFor(repository.path);
    if (workerModels.length > 0 || config.agentBackend === 'worker') return workerModels;
    // CLI / auto-with-no-worker: expose a single auto entry so the UI can submit.
    return [{ id: 'auto', name: 'Auto', vendor: 'cli', family: 'auto', version: '1', maxInputTokens: 0 }];
  });

  app.get<{ Querystring: { repositoryId?: string } }>('/api/tasks', async (request) =>
    store.listTasks(request.query.repositoryId).map((task) => taskSummary(store, task)));
  app.get<{ Params: IdParams }>('/api/repositories/:id/tasks', async (request, reply) => {
    if (!store.getRepository(request.params.id)) return reply.code(404).send({ error: 'Repository not found' });
    return store.listTasks(request.params.id).map((task) => taskSummary(store, task));
  });
  app.post<{ Params: IdParams; Body: { prompt?: string; modelId?: string } }>('/api/repositories/:id/tasks', async (request, reply) => {
    const repository = store.getRepository(request.params.id);
    if (!repository) return reply.code(404).send({ error: 'Repository not found' });
    if (!request.body?.prompt?.trim()) return reply.code(400).send({ error: 'prompt is required' });
    try { return reply.code(201).send(taskSummary(store, tasks.create(repository, request.body.prompt, request.body.modelId?.trim() || 'auto'))); }
    catch (error) { return sendKnownError(reply, error); }
  });
  app.get<{ Params: IdParams }>('/api/tasks/:id', async (request, reply) => {
    const task = store.getTask(request.params.id);
    return task ? taskSummary(store, task) : reply.code(404).send({ error: 'Task not found' });
  });
  app.get<{ Params: IdParams; Querystring: { after?: string } }>('/api/tasks/:id/events', async (request, reply) => {
    if (!store.getTask(request.params.id)) return reply.code(404).send({ error: 'Task not found' });
    const after = parseInt(request.query.after ?? '0', 10);
    return store.listEvents(request.params.id, isNaN(after) ? 0 : after);
  });
  app.post<{ Params: IdParams; Body: { prompt?: string; kind?: string; questionId?: string } }>('/api/tasks/:id/messages', async (request, reply) => {
    const task = store.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: 'Task not found' });
    const repository = store.getRepository(task.repositoryId)!;
    if (!request.body?.prompt?.trim()) return reply.code(400).send({ error: 'prompt is required' });
    try { return taskSummary(store, await tasks.followUp(task, repository, request.body.prompt,
      { kind: request.body.kind?.trim() || 'follow_up', questionId: request.body.questionId?.trim() || undefined })); }
    catch (error) { return sendKnownError(reply, error); }
  });
  app.post<{ Params: IdParams; Body: { confirmed?: boolean; stoppedBy?: string } }>('/api/tasks/:id/stop', async (request, reply) => {
    if (request.body?.confirmed !== true) return reply.code(400).send({ error: 'confirmed must be true' });
    if (!store.getTask(request.params.id)) return reply.code(404).send({ error: 'Task not found' });
    try { return taskSummary(store, await tasks.stop(request.params.id, request.body.stoppedBy?.trim() || 'user')); }
    catch (error) { return sendKnownError(reply, error); }
  });
  app.delete<{ Params: IdParams }>('/api/tasks/:id', async (request, reply) => {
    const task = store.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: 'Task not found' });
    if (ACTIVE_TASK_STATES.includes(task.state)) return reply.code(409).send({ error: 'Task is still active' });
    return store.deleteTask(request.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'Task not found' });
  });

  app.get('/ws/tasks', { websocket: true }, (socket, request) => {
    const taskId = (request.query as { taskId?: string }).taskId;
    const listener = (event: { taskId: string }) => { if (!taskId || taskId === event.taskId) socket.send(JSON.stringify(event)); };
    hub.on('task-event', listener);
    socket.on('close', () => hub.off('task-event', listener));
  });
  app.get('/ws/workers', { websocket: true }, (socket) => workers.accept(socket));

  app.get<{ Params: IdParams }>('/api/repositories/:id/terminals', async (request, reply) => {
    if (!store.getRepository(request.params.id)) return reply.code(404).send({ error: 'Repository not found' });
    return store.listTerminals(request.params.id);
  });
  app.post<{ Params: IdParams; Body: { name?: string } }>('/api/repositories/:id/terminals', async (request, reply) => {
    if (!store.getRepository(request.params.id)) return reply.code(404).send({ error: 'Repository not found' });
    try { return reply.code(201).send(store.createTerminal(randomUUID(), request.params.id, request.body?.name?.trim() || 'shell')); }
    catch (error) { return sendKnownError(reply, error); }
  });
  app.get<{ Params: IdParams }>('/ws/terminals/:id', { websocket: true }, (socket, request) => {
    const terminal = store.getTerminal(request.params.id);
    const repository = terminal && store.getRepository(terminal.repositoryId);
    if (!terminal || !repository) { socket.close(1008, 'Terminal not found'); return; }
    if (terminal.status === 'exited') { socket.close(1008, 'Terminal has exited'); return; }
    void terminals.bridge(socket, terminal.id, repository.path, terminal.status === 'new',
      () => store.setTerminalStatus(terminal.id, 'running'), () => store.setTerminalStatus(terminal.id, 'exited'))
      .catch((error) => socket.close(1011, error.message));
  });

  app.post<{ Body: PushSubscription }>('/api/push/subscriptions', async (request, reply) => {
    try { push.subscribe(request.body); return reply.code(204).send(); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.delete<{ Body: { endpoint?: string } }>('/api/push/subscriptions', async (request, reply) => {
    if (!request.body?.endpoint) return reply.code(400).send({ error: 'endpoint is required' });
    store.deletePushSubscription(request.body.endpoint); return reply.code(204).send();
  });

  app.get<{ Params: IdParams }>('/previews/:id', async (request, reply) => servePreview(store, config, request.params.id, '', reply, true));
  app.get<{ Params: IdParams & { '*': string } }>('/previews/:id/repo/*', async (request, reply) =>
    servePreview(store, config, request.params.id, request.params['*'], reply, false));

  if (config.webRoot && existsSync(config.webRoot)) {
    await app.register(fastifyStatic, { root: config.webRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => request.raw.url?.startsWith('/api/') || request.raw.url?.startsWith('/ws/')
      ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'));
  }
  return app;
}

async function withRepository(store: Store, id: string, reply: FastifyReply, operation: (path: string) => Promise<unknown>): Promise<unknown> {
  const repository = store.getRepository(id);
  if (!repository) return reply.code(404).send({ error: 'Repository not found' });
  try { return await operation(repository.path); } catch (error) { return sendKnownError(reply, error); }
}

async function servePreview(store: Store, config: ServerConfig, id: string, requestedPath: string,
  reply: FastifyReply, landing: boolean): Promise<unknown> {
  const repository = store.getRepository(id);
  if (!repository) return reply.code(404).send({ error: 'Repository not found' });
  try {
    const root = landing ? join(config.dataDir, 'previews', id) : repository.path;
    const file = await readPreviewFile(root, landing ? 'index.html' : requestedPath);
    const body = !landing && file.contentType.startsWith('text/html') ? rewritePreviewHtml(file.body, id) : file.body;
    return reply.type(file.contentType).send(body);
  } catch (error) { return sendKnownError(reply, error); }
}

function sendKnownError(reply: FastifyReply, error: unknown): unknown {
  const known = error as NodeJS.ErrnoException & { statusCode?: number };
  const status = known.statusCode ?? (known.code?.startsWith('SQLITE_CONSTRAINT') ? 409 : 400);
  return reply.code(status).send({ error: known.message || 'Request failed' });
}

function taskSummary(store: Store, task: import('./types.js').Task): import('./types.js').Task & { title?: string; latestAction?: string } {
  const events = store.listEvents(task.id);
  const firstMessage = events.find((event) => event.kind === 'user_message');
  const latestAction = [...events].reverse().map(eventAction).find(Boolean);
  return { ...task, title: eventText(firstMessage?.payload), latestAction };
}

function eventAction(event: import('./types.js').TaskEvent): string | undefined {
  const payload = record(event.payload);
  const nested = record(payload.event);
  return eventText(payload) ?? eventText(nested) ?? stringValue(payload.command) ?? stringValue(payload.toolName)
    ?? stringValue(payload.summary) ?? stringValue(nested.type) ?? (event.kind === 'lifecycle' ? stringValue(payload.state) : undefined);
}

function eventText(value: unknown): string | undefined {
  const payload = record(value);
  return stringValue(payload.text) ?? stringValue(payload.message) ?? stringValue(payload.prompt);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
