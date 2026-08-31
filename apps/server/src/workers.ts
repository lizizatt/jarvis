import { realpath } from 'node:fs/promises';
import type { WebSocket } from 'ws';
import type { Repository, Task, TaskEvent } from './types.js';

const PROTOCOL_VERSION = 2;
const HELLO_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

interface WorkerHello {
  version: 2;
  type: 'hello';
  workerId: string;
  windowName: string;
  windowPid?: number;
  workspaceRoots: string[];
  models: ModelMetadata[];
  presence?: WorkerPresence;
}

export interface ModelMetadata {
  id: string;
  name: string;
  vendor: string;
  family: string;
  version: string;
  maxInputTokens: number;
}

interface WorkerEventMessage {
  version: 2;
  type: 'event';
  taskId: string;
  kind: string;
  payload: unknown;
}

interface WorkerTerminalMessage {
  version: 2;
  type: 'complete' | 'failed' | 'stopped';
  taskId: string;
  payload?: { error?: string };
}

type WorkerMessage = WorkerHello | WorkerEventMessage | WorkerTerminalMessage;

export interface WorkerStatus {
  workerId: string;
  windowName: string;
  windowPid?: number;
  workspaceRoots: string[];
  models: ModelMetadata[];
  connectedAt: string;
  activeTaskIds: string[];
  activity: WorkerActivity;
  presence: WorkerPresence;
}

export type WorkerActivity = 'idle' | 'thinking' | 'needs-input';
export interface WorkerPresence { focused: boolean; active: boolean; updatedAt: string }

export interface WorkerTurnCallbacks {
  event: (event: unknown) => void;
  terminal: (state: 'completed' | 'failed' | 'stopped', error?: string) => void;
  disconnected: () => void;
}

interface WorkerConnection extends WorkerStatus {
  socket: WebSocket;
  alive: boolean;
  tasks: Map<string, WorkerTurnCallbacks>;
  taskActivities: Map<string, Exclude<WorkerActivity, 'idle'>>;
  heartbeat: NodeJS.Timeout;
}

export class WorkerManager {
  private readonly workers = new Map<string, WorkerConnection>();

  accept(socket: WebSocket): void {
    let worker: WorkerConnection | undefined;
    let messageQueue = Promise.resolve();
    const helloTimeout = setTimeout(() => socket.close(1008, 'Worker hello required'), HELLO_TIMEOUT_MS);

    socket.on('pong', () => { if (worker) worker.alive = true; });
    socket.on('message', (data) => {
      messageQueue = messageQueue.then(async () => {
        const message = parseMessage(data.toString());
        if (!worker) {
          if (message.type !== 'hello') throw new Error('Worker hello required');
          worker = await this.register(socket, message);
          clearTimeout(helloTimeout);
          if (socket.readyState !== socket.OPEN) { this.disconnect(worker); }
          return;
        }
        if (message.type === 'hello') {
          await this.update(worker, message);
          return;
        }
        this.handle(worker, message);
      }).catch((error: unknown) => socket.close(1008, (error as Error).message.slice(0, 120)));
    });
    socket.on('close', () => {
      clearTimeout(helloTimeout);
      if (worker) this.disconnect(worker);
    });
    socket.on('error', () => { /* close handles cleanup */ });
  }

  list(): WorkerStatus[] {
    return [...this.workers.values()].map(({ workerId, windowName, windowPid, workspaceRoots, models, connectedAt, activeTaskIds, taskActivities,
      presence }) => ({ workerId, windowName, workspaceRoots, models, connectedAt, activeTaskIds: [...activeTaskIds],
        windowPid, activity: workerActivity(taskActivities), presence }));
  }

  hasWorker(repositoryPath: string): boolean {
    return [...this.workers.values()].some((worker) => worker.workspaceRoots.includes(repositoryPath));
  }

  modelsFor(repositoryPath: string): ModelMetadata[] {
    return [...this.workers.values()].find((worker) => worker.workspaceRoots.includes(repositoryPath))?.models ?? [];
  }

  dispatch(task: Task, repository: Repository, policy: string, prompt: string, history: TaskEvent[],
    callbacks: WorkerTurnCallbacks): { workerId: string; cancel: () => void; release: () => void } | undefined {
    const worker = [...this.workers.values()].find((candidate) => candidate.workspaceRoots.includes(repository.path));
    if (!worker || worker.socket.readyState !== worker.socket.OPEN) return undefined;
    worker.tasks.set(task.id, callbacks);
    worker.taskActivities.set(task.id, 'thinking');
    worker.activeTaskIds.push(task.id);
    try {
      worker.socket.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'turn', taskId: task.id,
        sessionId: task.sessionId, repositoryPath: repository.path, modelId: task.modelId,
        clientConversationId: task.clientConversationId ?? undefined, policy, prompt, history: modelHistory(history, prompt) }));
    } catch {
      this.release(worker, task.id);
      return undefined;
    }
    return { workerId: worker.workerId, cancel: () => {
      if (worker.tasks.has(task.id) && worker.socket.readyState === worker.socket.OPEN) {
        worker.socket.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'cancel', taskId: task.id }));
      }
    }, release: () => this.release(worker, task.id) };
  }

  close(): void {
    for (const worker of this.workers.values()) worker.socket.close(1001, 'Server shutting down');
  }

  private async register(socket: WebSocket, hello: WorkerHello): Promise<WorkerConnection> {
    const workspaceRoots = [...new Set(await Promise.all(hello.workspaceRoots.map((root) => realpath(root))))];
    const existing = this.workers.get(hello.workerId);
    if (existing) {
      this.disconnect(existing);
      existing.socket.close(1008, 'Worker ID reconnected');
    }
    const connectedAt = new Date().toISOString();
    const worker: WorkerConnection = { socket, workerId: hello.workerId, windowName: hello.windowName, windowPid: hello.windowPid,
      workspaceRoots, models: hello.models, connectedAt, activeTaskIds: [], presence: hello.presence ?? defaultPresence(connectedAt),
      activity: 'idle', alive: true, tasks: new Map(), taskActivities: new Map(),
      heartbeat: undefined as unknown as NodeJS.Timeout };
    worker.heartbeat = setInterval(() => {
      if (!worker.alive) { worker.socket.terminate(); return; }
      worker.alive = false;
      worker.socket.ping();
    }, HEARTBEAT_INTERVAL_MS);
    try {
      socket.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'ready', workerId: worker.workerId }));
    } catch (error) {
      clearInterval(worker.heartbeat);
      throw error;
    }
    this.workers.set(worker.workerId, worker);
    return worker;
  }

  private async update(worker: WorkerConnection, hello: WorkerHello): Promise<void> {
    if (hello.workerId !== worker.workerId) throw new Error('Worker ID cannot change');
    const roots = [...hello.workspaceRoots];
    const workspaceRoots = [...new Set(await Promise.all(roots.map((root) => realpath(root))))];
    worker.socket.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'ready', workerId: worker.workerId }));
    worker.windowName = hello.windowName;
    worker.windowPid = hello.windowPid;
    worker.workspaceRoots = workspaceRoots;
    worker.models = hello.models;
    worker.presence = hello.presence ?? worker.presence;
  }

  private handle(worker: WorkerConnection, message: Exclude<WorkerMessage, WorkerHello>): void {
    const callbacks = worker.tasks.get(message.taskId);
    if (!callbacks) return;
    if (message.type === 'event') {
      if (isInputRequest(message.kind, message.payload)) worker.taskActivities.set(message.taskId, 'needs-input');
      callbacks.event({ type: message.kind, ...recordPayload(message.payload), data: message.payload });
      return;
    }
    worker.taskActivities.delete(message.taskId);
    callbacks.terminal(message.type === 'complete' ? 'completed' : message.type, message.payload?.error);
  }

  private disconnect(worker: WorkerConnection): void {
    if (this.workers.get(worker.workerId) !== worker) return;
    clearInterval(worker.heartbeat);
    this.workers.delete(worker.workerId);
    const tasks = [...worker.tasks.values()];
    worker.tasks.clear();
    worker.taskActivities.clear();
    worker.activeTaskIds.length = 0;
    for (const callbacks of tasks) callbacks.disconnected();
  }

  private release(worker: WorkerConnection, taskId: string): void {
    worker.tasks.delete(taskId);
    worker.taskActivities.delete(taskId);
    worker.activeTaskIds = worker.activeTaskIds.filter((candidate) => candidate !== taskId);
  }
}

function workerActivity(taskActivities: Map<string, Exclude<WorkerActivity, 'idle'>>): WorkerActivity {
  return [...taskActivities.values()].includes('needs-input')
    ? 'needs-input'
    : taskActivities.size > 0 ? 'thinking' : 'idle';
}

function isInputRequest(kind: string, payload: unknown): boolean {
  const data = recordPayload(payload);
  const eventType = [kind, data.type].find((candidate): candidate is string => typeof candidate === 'string') ?? '';
  return /(?:^|[._-])(question|approval|required[_-]?input)(?:$|[._-])/i.test(eventType);
}

function parseMessage(raw: string): WorkerMessage {
  const message = JSON.parse(raw) as Partial<WorkerMessage> & Record<string, unknown>;
  if (message.version !== PROTOCOL_VERSION) throw new Error('Unsupported worker protocol version');
  if (message.type === 'hello') {
    if (!isString(message.workerId) || !isString(message.windowName) || (message.windowPid !== undefined && !isPositiveInteger(message.windowPid)) || !isStrings(message.workspaceRoots)
      || !Array.isArray(message.models) || !message.models.every(isModelMetadata)
      || (message.presence !== undefined && !isWorkerPresence(message.presence))) {
      throw new Error('Invalid worker hello');
    }
    return message as WorkerHello;
  }
  if (!isString(message.taskId) || !['event', 'complete', 'failed', 'stopped'].includes(String(message.type))) {
    throw new Error('Invalid worker message');
  }
  if (message.type === 'event' && !isString(message.kind)) {
    throw new Error('Invalid worker message');
  }
  return message as WorkerEventMessage | WorkerTerminalMessage;
}

function isString(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function isPositiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function isStrings(value: unknown): value is string[] { return Array.isArray(value) && value.every(isString); }
function isModelMetadata(value: unknown): value is ModelMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const model = value as Record<string, unknown>;
  return ['id', 'name', 'vendor', 'family', 'version'].every((key) => isString(model[key]))
    && typeof model.maxInputTokens === 'number';
}
function isWorkerPresence(value: unknown): value is WorkerPresence {
  if (typeof value !== 'object' || value === null) return false;
  const presence = value as Record<string, unknown>;
  return typeof presence.focused === 'boolean' && typeof presence.active === 'boolean' && isString(presence.updatedAt);
}
function defaultPresence(updatedAt: string): WorkerPresence { return { focused: false, active: false, updatedAt }; }
function recordPayload(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function modelHistory(events: TaskEvent[], currentPrompt: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let currentPromptIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const payload = recordPayload(event.payload);
    if (event.kind === 'user_message' && payload.text === currentPrompt) {
      currentPromptIndex = index;
      break;
    }
  }
  for (const [index, event] of events.entries()) {
    const payload = recordPayload(event.payload);
    if (index !== currentPromptIndex && event.kind === 'user_message' && typeof payload.text === 'string') {
      appendHistory(history, 'user', payload.text);
    }
    if (event.kind === 'agent_event' && payload.type === 'text' && typeof payload.text === 'string') {
      appendHistory(history, 'assistant', payload.text);
    }
    if (event.kind === 'agent_event' && payload.type === 'question' && typeof payload.prompt === 'string') {
      appendHistory(history, 'assistant', `Question for the user: ${payload.prompt}`);
    }
  }
  return history;
}
function appendHistory(history: Array<{ role: 'user' | 'assistant'; content: string }>, role: 'user' | 'assistant', content: string): void {
  const last = history[history.length - 1];
  if (last?.role === role) last.content += role === 'user' ? `\n\n${content}` : content;
  else history.push({ role, content });
}
