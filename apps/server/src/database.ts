import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PushSubscription } from 'web-push';
import { ACTIVE_TASK_STATES, type Repository, type Task, type TaskEvent, type TaskState } from './types.js';

const migrations = [
  `
  CREATE TABLE repositories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    default_branch TEXT,
    instructions TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    stopped_by TEXT,
    stopped_at TEXT,
    exit_code INTEGER
  );
  CREATE UNIQUE INDEX one_active_task_per_repository
    ON tasks(repository_id) WHERE state IN ('starting', 'running', 'stopping');
  CREATE TABLE task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(task_id, sequence)
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    subscription TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE terminal_sessions (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(repository_id, name)
  );
  `,
  `ALTER TABLE terminal_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'new';`,
  `ALTER TABLE repositories DROP COLUMN instructions;`,
  `ALTER TABLE tasks ADD COLUMN model_id TEXT NOT NULL DEFAULT 'auto';`,
];

interface RepositoryRow {
  id: string; name: string; path: string; default_branch: string | null;
  created_at: string; updated_at: string;
}

interface TaskRow {
  id: string; repository_id: string; session_id: string; state: TaskState; created_at: string;
  updated_at: string; stopped_by: string | null; stopped_at: string | null; exit_code: number | null;
  model_id: string;
}

interface EventRow {
  id: number; task_id: string; sequence: number; kind: string; payload: string; created_at: string;
}

export class Store {
  readonly db: Database.Database;

  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    for (let index = version; index < migrations.length; index += 1) {
      this.db.transaction(() => {
        this.db.exec(migrations[index]);
        this.db.pragma(`user_version = ${index + 1}`);
      })();
    }
  }

  close(): void { this.db.close(); }

  listRepositories(): Repository[] {
    return (this.db.prepare('SELECT * FROM repositories ORDER BY name').all() as RepositoryRow[]).map(mapRepository);
  }

  getRepository(id: string): Repository | undefined {
    const row = this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as RepositoryRow | undefined;
    return row && mapRepository(row);
  }

  insertRepository(repository: Repository): Repository {
    this.db.prepare(`INSERT INTO repositories
      (id, name, path, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(repository.id, repository.name, repository.path, repository.defaultBranch, repository.createdAt, repository.updatedAt);
    return repository;
  }

  updateRepository(id: string, values: Pick<Repository, 'name' | 'defaultBranch'>): Repository | undefined {
    this.db.prepare(`UPDATE repositories SET name = ?, default_branch = ?, updated_at = ? WHERE id = ?`)
      .run(values.name, values.defaultBranch, new Date().toISOString(), id);
    return this.getRepository(id);
  }

  deleteRepository(id: string): boolean {
    return this.db.prepare('DELETE FROM repositories WHERE id = ?').run(id).changes > 0;
  }

  insertTask(task: Task): Task {
    this.db.prepare(`INSERT INTO tasks
      (id, repository_id, session_id, state, created_at, updated_at, stopped_by, stopped_at, exit_code, model_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.id, task.repositoryId, task.sessionId, task.state, task.createdAt, task.updatedAt,
        task.stoppedBy, task.stoppedAt, task.exitCode, task.modelId);
    return task;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row && mapTask(row);
  }

  listTasks(repositoryId?: string): Task[] {
    const rows = repositoryId
      ? this.db.prepare('SELECT * FROM tasks WHERE repository_id = ? ORDER BY created_at DESC').all(repositoryId)
      : this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
    return (rows as TaskRow[]).map(mapTask);
  }

  setTaskState(id: string, state: TaskState, extra: { stoppedBy?: string; exitCode?: number | null } = {}): Task | undefined {
    const now = new Date().toISOString();
    // Transitioning back to an active state clears stale stop fields from a prior stop
    if (state === 'starting' || state === 'running') {
      this.db.prepare(`UPDATE tasks SET state = ?, updated_at = ?, stopped_by = NULL, stopped_at = NULL, exit_code = NULL WHERE id = ?`)
        .run(state, now, id);
    } else {
      const stoppedAt = state === 'stopped' ? now : null;
      this.db.prepare(`UPDATE tasks SET state = ?, updated_at = ?, stopped_by = COALESCE(?, stopped_by),
      stopped_at = COALESCE(?, stopped_at), exit_code = COALESCE(?, exit_code) WHERE id = ?`)
        .run(state, now, extra.stoppedBy ?? null, stoppedAt, extra.exitCode ?? null, id);
    }
    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    return this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
  }

  interruptActiveTasks(): number {
    const placeholders = ACTIVE_TASK_STATES.map(() => '?').join(',');
    return this.db.prepare(`UPDATE tasks SET state = 'interrupted', updated_at = ? WHERE state IN (${placeholders})`)
      .run(new Date().toISOString(), ...ACTIVE_TASK_STATES).changes;
  }

  appendEvent(taskId: string, kind: string, payload: unknown): TaskEvent {
    return this.db.transaction(() => {
      const sequence = (this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM task_events WHERE task_id = ?')
        .get(taskId) as { value: number }).value;
      const createdAt = new Date().toISOString();
      const result = this.db.prepare('INSERT INTO task_events (task_id, sequence, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(taskId, sequence, kind, JSON.stringify(payload), createdAt);
      return { id: Number(result.lastInsertRowid), taskId, sequence, kind, payload, createdAt };
    })();
  }

  listEvents(taskId: string, after = 0): TaskEvent[] {
    return (this.db.prepare('SELECT * FROM task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence')
      .all(taskId, after) as EventRow[]).map((row) => ({ id: row.id, taskId: row.task_id,
      sequence: row.sequence, kind: row.kind, payload: JSON.parse(row.payload) as unknown, createdAt: row.created_at }));
  }

  getSetting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  savePushSubscription(subscription: PushSubscription): void {
    this.db.prepare(`INSERT INTO push_subscriptions (endpoint, subscription, created_at) VALUES (?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription`)
      .run(subscription.endpoint, JSON.stringify(subscription), new Date().toISOString());
  }

  deletePushSubscription(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  listPushSubscriptions(): PushSubscription[] {
    return (this.db.prepare('SELECT subscription FROM push_subscriptions').all() as { subscription: string }[])
      .map((row) => JSON.parse(row.subscription) as PushSubscription);
  }

  createTerminal(id: string, repositoryId: string, name: string): TerminalRecord {
    const createdAt = new Date().toISOString();
    this.db.prepare('INSERT INTO terminal_sessions (id, repository_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run(id, repositoryId, name, createdAt);
    return { id, repositoryId, name, createdAt, status: 'new' };
  }

  setTerminalStatus(id: string, status: TerminalStatus): void {
    this.db.prepare('UPDATE terminal_sessions SET status = ? WHERE id = ?').run(status, id);
  }

  listTerminals(repositoryId: string): TerminalRecord[] {
    return (this.db.prepare('SELECT * FROM terminal_sessions WHERE repository_id = ? ORDER BY created_at').all(repositoryId) as
      TerminalRow[]).map(mapTerminal);
  }

  getTerminal(id: string): TerminalRecord | undefined {
    const row = this.db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get(id) as TerminalRow | undefined;
    return row && mapTerminal(row);
  }
}

type TerminalStatus = 'new' | 'running' | 'exited';
interface TerminalRecord { id: string; repositoryId: string; name: string; createdAt: string; status: TerminalStatus }
interface TerminalRow { id: string; repository_id: string; name: string; created_at: string; status: TerminalStatus }
function mapTerminal(row: TerminalRow): TerminalRecord {
  return { id: row.id, repositoryId: row.repository_id, name: row.name, createdAt: row.created_at, status: row.status };
}

function mapRepository(row: RepositoryRow): Repository {
  return { id: row.id, name: row.name, path: row.path, defaultBranch: row.default_branch,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapTask(row: TaskRow): Task {
  return { id: row.id, repositoryId: row.repository_id, sessionId: row.session_id, state: row.state,
    createdAt: row.created_at, updatedAt: row.updated_at, stoppedBy: row.stopped_by,
    stoppedAt: row.stopped_at, exitCode: row.exit_code, modelId: row.model_id };
}
