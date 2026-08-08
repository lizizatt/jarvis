export type TaskStatus = 'ready' | 'queued' | 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted';

export interface TaskSummary {
  id: string;
  status: TaskStatus;
  title?: string;
  latestAction?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  nativeSessionId?: string;
}

export interface RepositoryStatus {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export interface Repository {
  id: string;
  name: string;
  path: string;
  defaultBranch?: string;
  previewUrl?: string;
  status?: RepositoryStatus;
  activeTask?: TaskSummary;
}

export interface TaskEvent {
  id?: string;
  sequence: number;
  kind?: string;
  type: string;
  timestamp: string;
  createdAt?: string;
  message?: string;
  summary?: string;
  stream?: 'stdout' | 'stderr';
  raw?: string;
  data?: Record<string, unknown>;
}

export interface PullRequest {
  number?: number;
  title?: string;
  state: string;
  url?: string;
  checks?: Array<{ name: string; state: string }>;
}

export interface DiffResult { mode: 'worktree' | 'staged'; diff: string }
export interface TerminalSession { id: string; name?: string; status?: 'new' | 'running' | 'exited'; columns?: number; rows?: number }
