import type { TaskState } from './types';

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  draft: ['queued', 'discarded'],
  queued: ['working', 'blocked', 'discarded'],
  working: ['blocked', 'review', 'queued', 'idle'],
  blocked: ['queued', 'discarded'],
  // review → blocked: una tarea de conflicto que vuelve a chocar al integrar.
  review: ['queued', 'done', 'discarded', 'blocked', 'pr'],
  // Con integración por PR: esperando al CI de GitHub para fusionar.
  pr: ['done', 'queued', 'review', 'blocked', 'discarded'],
  done: [],
  discarded: [],
  // Solo los chats: el Coordinador respondió y espera tu siguiente mensaje.
  idle: ['queued', 'discarded'],
};

export class InvalidTransitionError extends Error {
  constructor(readonly from: TaskState, readonly to: TaskState) {
    super(`Transición no permitida: ${from} → ${to}`);
  }
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
