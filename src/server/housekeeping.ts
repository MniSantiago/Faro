import path from 'node:path';
import type { Bus } from './bus';
import { isMultiRepo } from './config';
import { closeFinishedParent, type IntegrateDeps } from './integrate';
import type { Store } from './store';
import { repoView } from './task-repos';
import { removeFolderIfLeftover } from './task-workspace';
import type { FaroConfig, Task } from './types';
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
 * ninguna tarea conocida ni los que tienen cambios sin commitear. Multi-repo: el dueño de `<carpeta>/<repo>` es la
 * tarea cuyo worktreePath es `<carpeta>`; tras borrar sus worktrees se borra la carpeta (si no queda nada más).
 * Devuelve las rutas borradas.
 */
export async function pruneClosedWorktrees(d: { store: Store; config: FaroConfig; workspaces: Workspaces; bus?: Bus }): Promise<string[]> {
  const removed: string[] = [];
  const tasks = d.store.listTasks();
  const closed = (owners: Task[]) => owners.length > 0 && owners.every((t) => t.state === 'done' || t.state === 'discarded');
  for (const project of d.config.projects) {
    const mine = tasks.filter((t) => t.projectId === project.id && t.worktreePath);
    if (!isMultiRepo(project)) {
      for (const wt of await d.workspaces.listWorktrees(project)) {
        if (!closed(mine.filter((t) => realOr(t.worktreePath!) === wt))) continue;
        if (await d.workspaces.removeIfClean(project, wt)) removed.push(wt);
        else console.error(`[faro] no se borra ${wt}: tiene cambios sin commitear`);
      }
      continue;
    }
    const folders = new Set<string>();
    for (const repo of project.repos!) {
      const view = repoView(project, repo);
      for (const wt of await d.workspaces.listWorktrees(view)) {
        if (path.basename(wt) !== repo.id) continue;
        const folder = path.dirname(wt);
        if (!closed(mine.filter((t) => realOr(t.worktreePath!) === folder))) continue;
        if (await d.workspaces.removeIfClean(view, wt)) {
          removed.push(wt);
          folders.add(folder);
        } else console.error(`[faro] no se borra ${wt}: tiene cambios sin commitear`);
      }
    }
    for (const folder of folders) await removeFolderIfLeftover(folder).catch((e: Error) => console.error(`[faro] no se borra ${folder}: ${e.message}`));
  }
  return removed;
}
