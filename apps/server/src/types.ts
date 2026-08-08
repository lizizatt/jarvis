export type TaskState = 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted';

export interface Repository {
  id: string;
  name: string;
  path: string;
  defaultBranch: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  repositoryId: string;
  sessionId: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  stoppedBy: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  modelId: string;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  sequence: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export interface ServerConfig {
  dataDir: string;
  host: string;
  port: number;
  agentExecutable: string;
  agentBackend: 'auto' | 'worker' | 'cli';
  policy: string;
  webRoot?: string;
  terminalHostScript?: string;
  terminalHostExternal?: boolean;
  maxJsonLineBytes: number;
  maxStderrChunkBytes: number;
}

export const ACTIVE_TASK_STATES: TaskState[] = ['starting', 'running', 'stopping'];
