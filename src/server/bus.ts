import { EventEmitter } from 'node:events';
import type { BusMessage, EventRow, QueueState, Task, TaskStats } from './types';

export class Bus {
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(100);
  }

  emit(m: BusMessage): void {
    for (const fn of this.ee.listeners('msg')) {
      try {
        (fn as (m: BusMessage) => void)(m);
      } catch (err) {
        console.error('[faro] suscriptor del bus falló', err);
      }
    }
  }

  emitTask(task: Task): void {
    this.emit({ type: 'task', task });
  }

  emitEvent(taskId: string, event: EventRow): void {
    this.emit({ type: 'event', taskId, event });
  }

  emitQueue(queue: QueueState): void {
    this.emit({ type: 'queue', queue });
  }

  emitStats(taskId: string, stats: TaskStats): void {
    this.emit({ type: 'stats', taskId, stats });
  }

  subscribe(fn: (m: BusMessage) => void): () => void {
    this.ee.on('msg', fn);
    return () => this.ee.off('msg', fn);
  }
}
