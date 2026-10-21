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

/** Cola de integraciones y push por proyecto: la cola de la última operación de cada proyecto. */
const projectQueues = new Map<string, Promise<void>>();

/**
 * Ejecuta `fn` cuando terminen las integraciones y push anteriores del mismo proyecto (en serie; no rechaza,
 * espera). No es reentrante: llamarlo otra vez para el mismo proyecto desde dentro de `fn` se bloquea para
 * siempre; lo que corre dentro (p. ej. el push automático de finishIntegrated) no vuelve a pedirlo.
 */
export function withProjectIntegrationLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = projectQueues.get(projectId) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(() => {}, () => {});
  projectQueues.set(projectId, tail);
  void tail.then(() => {
    if (projectQueues.get(projectId) === tail) projectQueues.delete(projectId);
  });
  return run;
}
