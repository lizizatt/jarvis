import { EventEmitter } from 'node:events';
import type { TaskEvent } from './types.js';

export class EventHub extends EventEmitter {
  publish(event: TaskEvent): void { this.emit('task-event', event); }
}
