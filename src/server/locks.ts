import { ActionError } from './errors';

/**
 * Tareas que Faro está integrando ahora mismo (merge, push, borrado del worktree). Lo comparten
 * la integración automática del orquestador y las acciones del usuario, para que un mensaje o un
 * descarte no cambien el estado de la tarea a mitad de la integración.
 */
const integrating = new Set<string>();

export function isIntegrating(taskId: string): boolean {
  return integrating.has(taskId);
}

export async function withIntegrationLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  if (integrating.has(taskId)) throw new ActionError(`${taskId} ya se está integrando`);
  integrating.add(taskId);
  try {
    return await fn();
  } finally {
    integrating.delete(taskId);
  }
}

/** Rechaza (409) una acción del usuario mientras la tarea se está integrando. */
export function assertNotIntegrating(taskId: string): void {
  if (integrating.has(taskId)) throw new ActionError('Se está integrando; espera un momento');
}
