import type { Bus } from './bus';
import { closeFinishedParent, type IntegrateDeps } from './integrate';
import type { Store } from './store';
import type { FaroConfig } from './types';
import { realOr, type Workspaces } from './workspaces';

/** Al arrancar: cierra los padres en revisión cuyas hijas ya terminaron (p. ej. de antes de que Faro lo hiciera solo). */
export async function sweepFinishedParents(d: IntegrateDeps): Promise<void> {
  for (const parent of d.store.listTasks(['review'])) {
    const child = d.store.listTasks(['done']).find((t) => t.parentId === parent.id);
    if (child) await closeFinishedParent(d, child);
  }
}

/**
 * Borra los worktrees de Faro cuyas tareas están todas hechas o descartadas. No toca los que no son de
 * ninguna tarea conocida ni los que tienen cambios sin commitear. Devuelve las rutas borradas.
 */
export async function pruneClosedWorktrees(d: { store: Store; config: FaroConfig; workspaces: Workspaces; bus?: Bus }): Promise<string[]> {
  const removed: string[] = [];
  const tasks = d.store.listTasks();
  for (const project of d.config.projects) {
    for (const wt of await d.workspaces.listWorktrees(project)) {
      const owners = tasks.filter((t) => t.projectId === project.id && t.worktreePath && realOr(t.worktreePath) === wt);
      if (owners.length === 0 || owners.some((t) => t.state !== 'done' && t.state !== 'discarded')) continue;
      if (await d.workspaces.removeIfClean(project, wt)) removed.push(wt);
      else console.error(`[faro] no se borra ${wt}: tiene cambios sin commitear`);
    }
  }
  return removed;
}
