import type { ModelMetadata, PreviewFile, PullRequest, Repository, RepositoryStatus, RepositoryStatusFile, TaskEvent, TaskSummary, TerminalSession } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function requestText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(await response.text() || `${response.status} ${response.statusText}`);
  return response.text();
}

function collection<T>(value: T[] | { items?: T[]; repositories?: T[]; tasks?: T[]; events?: T[] }): T[] {
  if (Array.isArray(value)) return value;
  return value.items ?? value.repositories ?? value.tasks ?? value.events ?? [];
}

type WireTask = TaskSummary & { state?: TaskSummary['status']; initialPrompt?: string; endedAt?: string | null };
type WireRepositoryStatus = {
  repository: Repository;
  git?: { branch?: string | null; isDirty?: boolean; ahead?: number; behind?: number } | null;
  activeTask?: WireTask | null;
  latestTaskEvent?: { summary?: string; text?: string; command?: string; toolName?: string } | null;
};

function task(value: WireTask): TaskSummary {
  return { ...value, status: value.status ?? value.state ?? 'ready', title: value.title ?? value.initialPrompt,
    nativeSessionId: value.nativeSessionId ?? (value as WireTask & { sessionId?: string }).sessionId,
    modelId: value.modelId ?? 'auto',
    finishedAt: value.finishedAt ?? value.endedAt ?? undefined };
}

function repository(value: Repository | WireRepositoryStatus): Repository {
  if (!('repository' in value)) {
    const direct = value as Repository & { activeTask?: WireTask | null };
    return { ...direct, activeTask: direct.activeTask ? task(direct.activeTask) : undefined };
  }
  const latest = value.latestTaskEvent;
  const activeTask = value.activeTask ? task(value.activeTask) : undefined;
  if (activeTask && latest) activeTask.latestAction = latest.summary ?? latest.text ?? latest.command ?? latest.toolName;
  return {
    ...value.repository,
    status: value.git ? { branch: value.git.branch ?? 'detached', dirty: value.git.isDirty ?? false, ahead: value.git.ahead ?? 0, behind: value.git.behind ?? 0 } : undefined,
    activeTask
  };
}

function unwrap<T>(value: T | Record<string, T>, key: string): T {
  return typeof value === 'object' && value !== null && key in value ? (value as Record<string, T>)[key] : value as T;
}

export const api = {
  repositories: async () => Promise.all(collection(await request<Array<Repository | WireRepositoryStatus> | { repositories: Array<Repository | WireRepositoryStatus> }>('/api/repositories')).map(async (value) => {
    const normalized = repository(value);
    try { return { ...normalized, status: await api.status(normalized.id) }; }
    catch { return normalized; }
  })),
  repository: async (id: string) => {
    const value = await request<Repository | WireRepositoryStatus | { repository: Repository }>(`/api/repositories/${id}`);
    const normalized = 'repository' in value && !('git' in value) && !('activeTask' in value)
      ? repository(value.repository) : repository(value as Repository | WireRepositoryStatus);
    try { return { ...normalized, status: await api.status(id) }; }
    catch { return normalized; }
  },
  status: async (id: string) => {
    const value = await request<{ branch?: string | null; dirty?: boolean; ahead?: number; behind?: number }>(`/api/repositories/${id}/status`);
    return { branch: value.branch ?? 'detached', dirty: value.dirty ?? false, ahead: value.ahead ?? 0, behind: value.behind ?? 0 } as RepositoryStatus;
  },
  tasks: async (repositoryId: string) => collection(await request<WireTask[] | { tasks: WireTask[] }>(`/api/repositories/${repositoryId}/tasks`)).map(task),
  models: (repositoryId: string) => request<ModelMetadata[]>(`/api/repositories/${repositoryId}/models`),
  task: async (id: string) => task(unwrap(await request<WireTask | { task: WireTask }>(`/api/tasks/${id}`), 'task')),
  startTask: async (repositoryId: string, message: string, modelId: string) => task(unwrap(await request<WireTask | { task: WireTask }>(`/api/repositories/${repositoryId}/tasks`, { method: 'POST', body: JSON.stringify({ repositoryId, prompt: message, modelId }) }), 'task')),
  events: async (taskId: string, after = 0) => collection(await request<TaskEvent[] | { events: TaskEvent[] }>(`/api/tasks/${taskId}/events?after=${after}`)),
  message: async (taskId: string, message: string, kind: 'follow_up' | 'answer' | 'approval' = 'follow_up', questionId?: string) =>
    task(await request<WireTask>(`/api/tasks/${taskId}/messages`, { method: 'POST', body: JSON.stringify({ prompt: message, kind, questionId }) })),
  stop: async (taskId: string) => task(await request<WireTask>(`/api/tasks/${taskId}/stop`, { method: 'POST', body: JSON.stringify({ confirmed: true, stoppedBy: 'pwa' }) })),
  deleteTask: (taskId: string) => request<void>(`/api/tasks/${taskId}`, { method: 'DELETE' }),
  diff: (id: string, mode: 'worktree' | 'staged') => requestText(`/api/repositories/${id}/diff?staged=${mode === 'staged'}`),
  statusFiles: (id: string) => request<RepositoryStatusFile[]>(`/api/repositories/${id}/status-files`),
  previewFiles: (id: string) => request<PreviewFile[]>(`/api/repositories/${id}/preview-files`),
  pullRequest: async (id: string) => {
    const value = await request<PullRequest | { available: boolean; pullRequest: PullRequest | null } | null>(`/api/repositories/${id}/pull-request`);
    return value && 'available' in value ? value.pullRequest : value;
  },
  terminals: async (id: string) => {
    const value = await request<TerminalSession[] | { items?: TerminalSession[]; sessions?: TerminalSession[] }>(`/api/repositories/${id}/terminals`);
    return Array.isArray(value) ? value : value.sessions ?? value.items ?? [];
  },
  createTerminal: async (id: string, name = 'shell') => unwrap(await request<TerminalSession | { session: TerminalSession }>(`/api/repositories/${id}/terminals`, { method: 'POST', body: JSON.stringify({ name }) }), 'session'),
  vapidKey: async () => ({ publicKey: (await request<{ vapidPublicKey: string }>('/api/config')).vapidPublicKey }),
  subscribePush: (subscription: PushSubscriptionJSON) => request<void>('/api/push/subscriptions', { method: 'POST', body: JSON.stringify(subscription) }),
  unsubscribePush: (endpoint: string) => request<void>('/api/push/subscriptions', { method: 'DELETE', body: JSON.stringify({ endpoint }) })
};
