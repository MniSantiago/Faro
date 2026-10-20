import type { FaroConfig } from './types';

const DEFAULT_WINDOW = 200000;

/** Ventana de contexto por defecto de una tarea: la del proyecto (por el prefijo del id) o 200000. */
export function defaultWindow(config: FaroConfig, taskId: string): number {
  const prefix = taskId.slice(0, taskId.lastIndexOf('-'));
  const project = config.projects.find((p) => p.prefix === prefix);
  return project?.contextWindow ?? DEFAULT_WINDOW;
}
