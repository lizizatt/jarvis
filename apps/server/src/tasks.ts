import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Store } from './database.js';
import type { EventHub } from './events.js';
import type { PushService } from './push.js';
import { ACTIVE_TASK_STATES, type Repository, type ServerConfig, type Task, type TaskEvent } from './types.js';
import type { WorkerManager } from './workers.js';

interface RunningTurn {
  backend: 'cli' | 'worker';
  child?: ChildProcess;
  cancel?: () => void;
  release?: () => void;
  timeout?: NodeJS.Timeout;
  timeoutHandler?: () => void;
  taskId: string;
  stopRequested: boolean;
  shutdownRequested: boolean;
  replacement?: { repository: Repository; prompt: string };
  close: Promise<void>;
}

export class TaskManager {
  private readonly running = new Map<string, RunningTurn>();

  constructor(private readonly store: Store, private readonly hub: EventHub,
    private readonly push: PushService, private readonly config: ServerConfig,
    private readonly workers?: WorkerManager) {}

  create(repository: Repository, prompt: string, modelId = 'auto'): Task {
    this.assertBackendAvailable(repository);
    this.assertModelAvailable(repository, modelId);
    const now = new Date().toISOString();
    const task: Task = { id: randomUUID(), repositoryId: repository.id, sessionId: randomUUID(), state: 'starting',
      createdAt: now, updatedAt: now, stoppedBy: null, stoppedAt: null, exitCode: null, modelId };
    this.store.insertTask(task);
    this.emit(task.id, 'user_message', { text: prompt });
    try { this.launch(task, repository, prompt); }
    catch (error) {
      this.store.setTaskState(task.id, 'interrupted');
      this.emit(task.id, 'lifecycle', { state: 'interrupted', reason: (error as Error).message });
      throw error;
    }
    return this.store.getTask(task.id)!;
  }

  async followUp(task: Task, repository: Repository, prompt: string,
    metadata: { kind?: string; questionId?: string } = {}): Promise<Task> {
    const conflicting = this.store.listTasks(repository.id).find((candidate) => candidate.id !== task.id && ACTIVE_TASK_STATES.includes(candidate.state));
    if (conflicting) throw conflict('Repository already has an active task');
    if (ACTIVE_TASK_STATES.includes(task.state)) {
      const turn = this.running.get(task.id);
      if (!turn || turn.stopRequested || turn.shutdownRequested) throw new Error('Task turn cannot accept a follow-up');
      if (turn.replacement) throw conflict('Task already has a follow-up pending');
      turn.replacement = { repository, prompt };
      this.emit(task.id, 'user_message', { text: prompt, followUp: true, ...metadata });
      this.emit(task.id, 'lifecycle', { state: 'starting', reason: 'follow_up' });
      try { this.cancel(turn); }
      catch (error) { turn.replacement = undefined; throw error; }
      await turn.close;
      return this.store.getTask(task.id)!;
    }
    this.assertBackendAvailable(repository);
    this.assertModelAvailable(repository, task.modelId);
    this.emit(task.id, 'user_message', { text: prompt, followUp: true, ...metadata });
    this.store.setTaskState(task.id, 'starting');
    try { this.launch(this.store.getTask(task.id)!, repository, prompt); }
    catch (error) {
      this.store.setTaskState(task.id, 'interrupted');
      this.emit(task.id, 'lifecycle', { state: 'interrupted', reason: (error as Error).message });
      throw error;
    }
    return this.store.getTask(task.id)!;
  }

  async stop(taskId: string, stoppedBy: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error('Task not found');
    if (task.state === 'stopped' || task.state === 'stopping') {
      const running = this.running.get(taskId);
      if (running) await running.close;
      return this.store.getTask(taskId)!;
    }
    if (!ACTIVE_TASK_STATES.includes(task.state)) return task;
    const turn = this.running.get(taskId);
    if (!turn) {
      this.store.setTaskState(taskId, 'interrupted', { stoppedBy });
      this.emit(taskId, 'lifecycle', { state: 'interrupted', stoppedBy });
      return this.store.getTask(taskId)!;
    }
    turn.stopRequested = true;
    this.store.setTaskState(taskId, 'stopping', { stoppedBy });
    this.emit(taskId, 'lifecycle', { state: 'stopping', stoppedBy });
    try { this.cancel(turn); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        this.running.delete(taskId);
        this.store.setTaskState(taskId, 'interrupted', { stoppedBy });
        this.emit(taskId, 'lifecycle', { state: 'interrupted', stoppedBy });
        return this.store.getTask(taskId)!;
      }
    }
    await turn.close;
    return this.store.getTask(taskId)!;
  }

  async shutdown(): Promise<void> {
    const turns = [...this.running.values()];
    for (const turn of turns) {
      turn.shutdownRequested = true;
      this.cancel(turn);
    }
    await Promise.all(turns.map((turn) => turn.close));
  }

  private launch(task: Task, repository: Repository, prompt: string): void {
    if (this.config.agentBackend !== 'cli' && this.launchWorker(task, repository, prompt)) return;
    if (this.config.agentBackend === 'worker') throw new Error(`No connected VS Code worker for ${repository.path}`);
    const effectivePrompt = [this.config.policy, prompt].filter(Boolean).join('\n\n');
    const args = ['-C', repository.path, '--session-id', task.sessionId, '-p', effectivePrompt, '--allow-all',
      '--output-format', 'json', '--stream', 'on', '--no-color', '--no-auto-update', '--no-remote-export',
      ...(task.modelId === 'auto' ? [] : ['--model', task.modelId])];
    const child = spawn(this.config.agentExecutable, args, {
      cwd: repository.path,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    let resolveClose!: () => void;
    const close = new Promise<void>((resolve) => { resolveClose = resolve; });
    const turn: RunningTurn = { backend: 'cli', child, taskId: task.id, stopRequested: false, shutdownRequested: false, close };
    this.running.set(task.id, turn);
    this.store.setTaskState(task.id, 'running');
    this.emit(task.id, 'lifecycle', { state: 'running', pid: child.pid, executable: this.config.agentExecutable, args });

    const parser = new JsonLineParser(this.config.maxJsonLineBytes, (value) => this.handleJson(task.id, value));
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout?.on('data', (chunk: Buffer) => parser.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.handleStderr(task.id, stderrDecoder.write(chunk)));
    child.on('error', (error) => this.emit(task.id, 'process_error', { message: error.message, code: (error as NodeJS.ErrnoException).code }));
    child.on('close', (code, signal) => {
      parser.end();
      const trailingStderr = stderrDecoder.end();
      if (trailingStderr) this.handleStderr(task.id, trailingStderr);
      this.running.delete(task.id);
      if (turn.replacement && !turn.stopRequested && !turn.shutdownRequested) {
        this.store.setTaskState(task.id, 'starting');
        try {
          this.launch(this.store.getTask(task.id)!, turn.replacement.repository, turn.replacement.prompt);
        } catch (error) {
          this.store.setTaskState(task.id, 'interrupted');
          this.emit(task.id, 'lifecycle', { state: 'interrupted', reason: (error as Error).message });
        }
        resolveClose();
        return;
      }
      const state = turn.shutdownRequested ? 'interrupted' : turn.stopRequested ? 'stopped' : code === 0 ? 'completed' : 'failed';
      this.store.setTaskState(task.id, state, { exitCode: code });
      this.emit(task.id, 'lifecycle', { state, exitCode: code, signal });
      void this.push.send({ title: `Agent ${state}`, body: repository.name, url: `/repositories/${repository.id}?task=${task.id}` });
      resolveClose();
    });
  }

  private assertBackendAvailable(repository: Repository): void {
    if (this.config.agentBackend === 'worker' && !this.workers?.hasWorker(repository.path)) {
      throw new Error(`No connected VS Code worker for ${repository.path}. Open that repository in VS Code and connect Jarvis Copilot Worker.`);
    }
  }

  private assertModelAvailable(repository: Repository, modelId: string): void {
    if (this.config.agentBackend === 'cli') return;
    const models = this.workers?.modelsFor(repository.path) ?? [];
    if (this.config.agentBackend === 'worker' && models.length === 0) {
      throw new Error(`No Copilot model is available for ${repository.path}`);
    }
    if (modelId !== 'auto' && models.length > 0 && !models.some((model) => model.id === modelId)) {
      throw new Error(`Model ${modelId} is not available for ${repository.path}`);
    }
  }

  private launchWorker(task: Task, repository: Repository, prompt: string): boolean {
    if (!this.workers) return false;
    let resolveClose!: () => void;
    const close = new Promise<void>((resolve) => { resolveClose = resolve; });
    const turn: RunningTurn = { backend: 'worker', taskId: task.id, stopRequested: false,
      shutdownRequested: false, close };
    turn.timeoutHandler = () => this.finishWorker(turn, repository, 'interrupted',
      'Worker cancellation timed out', resolveClose);
    const dispatched = this.workers.dispatch(task, repository, this.config.policy, prompt,
      this.store.listEvents(task.id), {
        event: (event) => this.handleJson(task.id, event),
        terminal: (state, error) => this.finishWorker(turn, repository, state, error, resolveClose),
        disconnected: () => this.finishWorker(turn, repository, 'interrupted', 'Worker disconnected', resolveClose),
      });
    if (!dispatched) return false;
    turn.cancel = dispatched.cancel;
    turn.release = dispatched.release;
    this.running.set(task.id, turn);
    this.store.setTaskState(task.id, 'running');
    this.emit(task.id, 'lifecycle', { state: 'running', backend: 'vscode-worker', workerId: dispatched.workerId });
    return true;
  }

  private finishWorker(turn: RunningTurn, repository: Repository,
    outcome: 'completed' | 'failed' | 'stopped' | 'interrupted', error: string | undefined, resolveClose: () => void): void {
    if (this.running.get(turn.taskId) !== turn) return;
    if (turn.timeout) clearTimeout(turn.timeout);
    turn.release?.();
    this.running.delete(turn.taskId);
    if (turn.replacement && !turn.stopRequested && !turn.shutdownRequested) {
      this.store.setTaskState(turn.taskId, 'starting');
      try {
        this.launch(this.store.getTask(turn.taskId)!, turn.replacement.repository, turn.replacement.prompt);
      } catch (error) {
        this.store.setTaskState(turn.taskId, 'interrupted');
        this.emit(turn.taskId, 'lifecycle', { state: 'interrupted', reason: (error as Error).message });
      }
      resolveClose();
      return;
    }
    const state = turn.shutdownRequested ? 'interrupted' : turn.stopRequested ? 'stopped' : outcome;
    if (error) this.emit(turn.taskId, 'process_error', { message: error, backend: 'vscode-worker' });
    this.store.setTaskState(turn.taskId, state);
    this.emit(turn.taskId, 'lifecycle', { state, backend: 'vscode-worker' });
    void this.push.send({ title: `Agent ${state}`, body: repository.name,
      url: `/repositories/${repository.id}?task=${turn.taskId}` });
    resolveClose();
  }

  private cancel(turn: RunningTurn): void {
    if (turn.backend === 'worker') {
      turn.cancel?.();
      if (!turn.timeout) {
        turn.timeout = setTimeout(turn.timeoutHandler!, 5_000);
      }
      return;
    }
    if (!turn.child?.pid) return;
    try { process.kill(-turn.child.pid, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  private handleJson(taskId: string, value: unknown): void {
    this.emit(taskId, 'agent_event', value);
    if (requiresUserInput(value)) {
      const task = this.store.getTask(taskId);
      void this.push.send({ title: 'Agent needs input', body: 'Open Jarvis to respond',
        url: task ? `/repositories/${task.repositoryId}?task=${taskId}` : '/' });
    }
  }

  private handleStderr(taskId: string, text: string): void {
    for (let offset = 0; offset < text.length; offset += this.config.maxStderrChunkBytes) {
      const slice = text.slice(offset, offset + this.config.maxStderrChunkBytes);
      this.emit(taskId, 'stderr', { text: slice });
      this.diagnosePolicy(taskId, slice);
    }
  }

  private diagnosePolicy(taskId: string, text: string): void {
    if (/permission denied|not allowed|policy (?:denied|violation)|requires? (?:approval|permission)/i.test(text)) {
      this.emit(taskId, 'policy_denial', { diagnosis: 'The agent reported a permission or policy denial.', excerpt: text.slice(0, 1000) });
    }
  }

  private emit(taskId: string, kind: string, payload: unknown): TaskEvent {
    const event = this.store.appendEvent(taskId, kind, payload);
    this.hub.publish(event);
    return event;
  }
}

function conflict(message: string): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 409;
  return error;
}

function requiresUserInput(value: unknown): boolean {
  const event = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const data = typeof event.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : {};
  const eventType = [event.type, data.type].find((candidate): candidate is string => typeof candidate === 'string') ?? '';
  return /(?:^|[._-])(question|approval|required[_-]?input)(?:$|[._-])/i.test(eventType);
}

export class JsonLineParser {
  private buffer = Buffer.alloc(0);
  private discardingOversizedLine = false;
  constructor(private readonly maximumBytes: number, private readonly onValue: (value: unknown) => void) {}

  write(chunk: Buffer): void {
    if (this.discardingOversizedLine) {
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) return;
      this.discardingOversizedLine = false;
      chunk = chunk.subarray(newline + 1);
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      this.parse(line);
    }
    if (this.buffer.length > this.maximumBytes) {
      this.onValue({ type: 'parse_error', reason: 'line_too_large', bytes: this.buffer.length });
      this.buffer = Buffer.alloc(0);
      this.discardingOversizedLine = true;
    }
  }

  end(): void {
    if (!this.discardingOversizedLine && this.buffer.length) this.parse(this.buffer);
    this.buffer = Buffer.alloc(0);
    this.discardingOversizedLine = false;
  }

  private parse(line: Buffer): void {
    if (!line.length) return;
    if (line.length > this.maximumBytes) {
      this.onValue({ type: 'parse_error', reason: 'line_too_large', bytes: line.length });
      return;
    }
    const raw = line.toString('utf8');
    try { this.onValue(JSON.parse(raw) as unknown); }
    catch { this.onValue({ type: 'raw_stdout', text: raw }); }
  }
}
