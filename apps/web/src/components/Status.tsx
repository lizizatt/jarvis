import { CircleCheck, CircleDot, CircleStop, LoaderCircle, OctagonX, PauseCircle } from 'lucide-react';
import type { TaskStatus } from '../types';

const icons = { ready: CircleDot, queued: CircleDot, starting: LoaderCircle, running: CircleDot, stopping: LoaderCircle, completed: CircleCheck, failed: OctagonX, stopped: CircleStop, interrupted: PauseCircle };

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const Icon = icons[status];
  return <span className={`status status-${status}`} data-testid="task-status"><Icon size={14} />{status}</span>;
}
