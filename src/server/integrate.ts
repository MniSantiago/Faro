import type { Bus } from './bus';
import { getProject, isMultiRepo } from './config';
import { gitOk } from './exec';
import { integrateMulti, integrationScope, pushFailureMessage, pushTaskProject } from './integrate-multi';
import { isIntegrating, withIntegrationLock, withProjectIntegrationLock } from './locks';
import { decide } from './policy';
import type { Releases } from './releases';
import type { Store } from './store';
import { cleanupTask, diffTask } from './task-workspace';
import type { FaroConfig, Level, Task, TaskState } from './types';
import type { GitHub } from './github';
import type { Workspaces } from './workspaces';

export interface IntegrateDeps {
  store: Store;
  config: FaroConfig;
  workspaces: Workspaces;
  bus: Bus;
  releases?: Pick<Releases, 'afterIntegrate'>;
  /** CLI de GitHub: con `github.prs` en el proyecto, cada tarea se integra por PR. */
  github?: GitHub;
  /** Pone una tarea en cola (el orquestador). Sin él, la tarea de conflicto se queda en borrador. */
  enqueue?: (taskId: string, nextPrompt?: string | null) => void;
}

/** Veces que una tarea de conflicto se reencola sola porque la rama base volvió a cambiar. */
export const MAX_CONFLICT_RETRIES = 3;
export const RETRY_MARK = 'La rama base ha vuelto a cambiar';
const OPEN_STATES: TaskState[] = ['draft', 'queued', 'working', 'blocked', 'review', 'pr', 'idle'];

export type IntegrateResult =
  | { status: 'merged'; pushed: boolean }
  | { status: 'nothing' }
  | { status: 'conflict'; followUpTaskId: string }
  | { status: 'pr'; number: number; url: string }
  | { status: 'failed'; message: string };

/** Las tareas de conflicto son las únicas que trabajan sobre la misma rama que su padre. */
export function isConflictTask(store: Pick<Store, 'findTask'>, task: Task): boolean {
  if (!task.parentId || !task.branch) return false;
  return store.findTask(task.parentId)?.branch === task.branch;
}

function conflictDescription(parentId: string, branch: string, base: string, output: string): string {
  return [
    `Al integrar ${parentId} (rama ${branch}) con ${base} hubo conflictos.`,
    `Antes de lanzarte, Faro hace merge de ${base} en esta rama y deja los marcadores de conflicto ` +
      '(<<<<<<<, =======, >>>>>>>) en los archivos afectados.',
    'Tu trabajo: edita esos archivos para resolver cada conflicto conservando la intención de ambos lados y ' +
      'quita todos los marcadores. No ejecutes git merge, git add ni git commit: al terminar, Faro cierra el merge, ' +
      'lo commitea y lo integra.',
    '',
    `Salida de git:\n${output}`,
  ].join('\n');
}

/** Tarea abierta que ya está resolviendo el conflicto de `task` (misma rama), si la hay. */
export function resolvingConflictTask(store: Pick<Store, 'listTasks' | 'findTask'>, task: Task): Task | undefined {
  return store.listTasks(OPEN_STATES)
    .find((o) => o.parentId === task.id && o.branch === task.branch && isConflictTask(store, o));
}

/**
 * Integra la tarea con su lock (rechaza si ya se integra) y el del proyecto (espera a las demás integraciones y
 * push del proyecto). Lo que corre dentro no vuelve a pedir el del proyecto: no es reentrante.
 */
export function integrate(d: IntegrateDeps, taskId: string, opts: { userApproved: boolean }): Promise<IntegrateResult> {
  return withIntegrationLock(taskId, () =>
    withProjectIntegrationLock(d.store.getTask(taskId).projectId, () => integrateLocked(d, taskId, opts)));
}

async function integrateLocked(d: IntegrateDeps, taskId: string, opts: { userApproved: boolean }): Promise<IntegrateResult> {
  const { store, bus, workspaces } = d;
  const task = store.getTask(taskId);
  if (task.state !== 'review') throw new Error(`${taskId} no está en revisión`);
  const project = getProject(d.config, task.projectId);
  if (isMultiRepo(project)) return integrateMulti(d, task, opts);

  const diff = await workspaces.diff(project, task);
  if (diff.files.length === 0) {
    try {
      await cleanupTask(workspaces, project, task);
    } catch (e) {
      store.addComment(taskId, 'faro', `Sin cambios que integrar, pero no se pudo borrar el worktree: ${(e as Error).message}`);
    }
    bus.emitTask(store.setState(taskId, 'done'));
    await closeFinishedParent(d, store.getTask(taskId));
    return { status: 'nothing' };
  }

  // Ya hay una tarea resolviendo el conflicto de esta: integrar otra vez solo crearía un duplicado.
  const resolving = resolvingConflictTask(store, task);
  if (resolving) {
    const message = `${resolving.id} ya está resolviendo el conflicto de esta tarea; cuando se integre, esta quedará hecha.`;
    return { status: 'failed', message };
  }

  const viaPr = !!(d.github && project.github?.prs);
  if (viaPr) {
    // Con PR, la verdad está en GitHub: se parte de lo último de origin.
    const sync = await workspaces.syncBase(project);
    if (!sync.ok) console.error(`[faro] no se pudo avanzar ${project.baseBranch} hasta ${project.remote}: ${sync.output}`);
  }
  const merged = viaPr ? await workspaces.updateBranch(project, task) : await workspaces.merge(project, task);
  if (!merged.ok && merged.conflict && isConflictTask(store, task)) {
    // Una tarea de conflicto que vuelve a chocar no crea otra anidada: se reencola y Faro rehace el merge.
    const retries = store.listComments(taskId).filter((c) => c.author === 'faro' && c.body.startsWith(RETRY_MARK)).length;
    if (d.enqueue && retries < MAX_CONFLICT_RETRIES) {
      store.addComment(taskId, 'faro',
        `${RETRY_MARK} (${project.baseBranch}, intento ${retries + 1} de ${MAX_CONFLICT_RETRIES}): ` +
        `la pongo otra vez en cola y hago el merge antes de lanzar al agente.\n\nSalida de git:\n${merged.output}`);
      d.enqueue(taskId,
        `${project.baseBranch} ha vuelto a cambiar mientras resolvías el conflicto. Resuelve los conflictos nuevos igual que antes.`);
      return { status: 'conflict', followUpTaskId: taskId };
    }
    const message = `${project.baseBranch} ha vuelto a cambiar y hay conflictos nuevos al integrar` +
      (d.enqueue ? ` (ya lo he reintentado ${MAX_CONFLICT_RETRIES} veces). ` : '. ') +
      `Reenvíala a la cola (por ejemplo, con un mensaje) y Faro volverá a hacer el merge antes de lanzar al agente.`;
    store.addComment(taskId, 'faro', `${message}\n\nSalida de git:\n${merged.output}`);
    bus.emitTask(store.setState(taskId, 'blocked', { blockedReason: message, attempts: 0 }));
    return { status: 'failed', message };
  }
  if (!merged.ok && merged.conflict) {
    const follow = store.createTask(project, {
      title: `Resolver conflicto: ${task.title}`,
      description: conflictDescription(task.id, task.branch!, project.baseBranch, merged.output),
      profileId: task.profileId,
      // Nivel 2 como mínimo: si las comprobaciones pasan, se integra sola sin pedirte aprobación.
      level: Math.max(task.level, 2) as Level,
      parentId: task.id,
      release: task.release,
    });
    const shared = store.updateTask(follow.id, { branch: task.branch, worktreePath: task.worktreePath });
    store.addComment(taskId, 'faro', d.enqueue
      ? `Conflicto al integrar. He creado ${follow.id} y la he puesto en cola para resolverlo.`
      : `Conflicto al integrar. He creado ${follow.id} (borrador) para resolverlo.`);
    bus.emitTask(shared);
    bus.emitTask(store.getTask(taskId));
    d.enqueue?.(follow.id);
    return { status: 'conflict', followUpTaskId: follow.id };
  }
  if (!merged.ok) {
    const message = `No se pudo integrar en ${project.baseBranch}: ${merged.output}`;
    store.addComment(taskId, 'faro', message);
    bus.emitTask(store.getTask(taskId));
    return { status: 'failed', message };
  }

  if (viaPr) return openPr(d, task, opts);
  const commit = (await gitOk(project.repoPath, ['rev-parse', project.baseBranch])).trim();
  const pushed = await finishIntegrated(d, task, { userApproved: opts.userApproved, commit, viaGithub: false });
  return { status: 'merged', pushed };
}

/** Lo que Faro recuerda del PR de una tarea mientras espera al CI. */
export interface PrMeta { number: number; url: string; userApproved: boolean; openedAt: string; ciFailures: number }
export const prMetaKey = (taskId: string) => `github.pr.${taskId}`;

/** Título del PR y asunto del squash: el de la tarea, o el de su original si es una tarea de conflicto. */
export function prTitle(store: Pick<Store, 'findTask'>, task: Task): string {
  const root = isConflictTask(store, task) ? store.findTask(task.parentId!) ?? task : task;
  return `${root.id}: ${root.title}`;
}

/** Sube la rama, abre su PR (o reutiliza el abierto) y deja la tarea esperando al CI. */
async function openPr(d: IntegrateDeps, task: Task, opts: { userApproved: boolean }): Promise<IntegrateResult> {
  const { store, bus, workspaces } = d;
  const project = getProject(d.config, task.projectId);
  const gh = d.github!;
  try {
    await workspaces.pushBranch(project, task);
    const existing = await gh.openPrFor(project, task.branch!);
    const body = [task.summary || task.title, '', `Tarea de Faro: ${task.id}. Faro lo fusiona por squash cuando pasa el CI.`].join('\n');
    const pr = existing ?? await gh.createPr(project, { branch: task.branch!, title: prTitle(store, task), body });
    const prev = store.getMeta<PrMeta>(prMetaKey(task.id));
    store.setMeta(prMetaKey(task.id), {
      number: pr.number, url: pr.url, userApproved: opts.userApproved || !!prev?.userApproved,
      openedAt: prev?.number === pr.number ? prev.openedAt : new Date().toISOString(), ciFailures: prev?.ciFailures ?? 0,
    } satisfies PrMeta);
    store.addComment(task.id, 'faro', existing
      ? `Rama actualizada en el PR #${pr.number} (${pr.url}). Espero al CI para fusionarlo.`
      : `PR #${pr.number} abierto: ${pr.url}. Lo fusiono por squash cuando pase el CI.`);
    bus.emitTask(store.setState(task.id, 'pr'));
    return { status: 'pr', number: pr.number, url: pr.url };
  } catch (e) {
    const message = `No se pudo abrir el PR: ${(e as Error).message}`;
    store.addComment(task.id, 'faro', message);
    bus.emitTask(store.getTask(task.id));
    return { status: 'failed', message };
  }
}

/**
 * La tarea ya está en la rama base (por merge local o porque GitHub fusionó su PR): aprobaciones, push,
 * cierre de su padre de conflicto y de las demás tareas de conflicto, limpieza del worktree, lanzamiento y
 * cierre de padres. Devuelve si se hizo push a la rama base.
 */
export async function finishIntegrated(
  d: IntegrateDeps, task: Task, o: { userApproved: boolean; commit: string; viaGithub: boolean; releaseCommit?: string | null },
): Promise<boolean> {
  const { store, bus, workspaces } = d;
  const taskId = task.id;
  const project = getProject(d.config, task.projectId);
  const commit = o.commit;
  store.addApproval(taskId, 'merge', o.userApproved ? 'approved' : 'auto');
  let pushed = false;
  if (o.viaGithub) {
    // El PR lo fusionó GitHub: la rama base del remoto ya lo tiene.
    store.addApproval(taskId, 'push', 'auto');
    pushed = true;
  } else if (decide(task.level, 'push') === 'auto' && isMultiRepo(project)) {
    // Ya dentro del lock del proyecto (integrate): se sube directamente, sin volver a pedirlo.
    const r = await pushTaskProject(workspaces, project);
    if (r.failed.length) {
      store.addComment(taskId, 'faro', `Integrada, pero el push no se completó. ${pushFailureMessage(r)}`);
      store.addApproval(taskId, 'push', 'pending');
    } else {
      store.addApproval(taskId, 'push', 'auto');
      pushed = true;
    }
  } else if (decide(task.level, 'push') === 'auto') {
    try {
      await workspaces.push(project);
      store.addApproval(taskId, 'push', 'auto');
      pushed = true;
    } catch (e) {
      store.addComment(taskId, 'faro', `Integrada, pero el push falló: ${(e as Error).message}`);
      store.addApproval(taskId, 'push', 'pending');
    }
  } else {
    store.addApproval(taskId, 'push', 'pending');
  }
  bus.emitTask(store.setState(taskId, 'done'));
  if (isConflictTask(store, task)) {
    // La tarea de conflicto lleva dentro el trabajo del padre: al integrarla, el padre queda hecho
    // y sobran las demás tareas de conflicto que quedaran sobre la misma rama.
    const parent = store.findTask(task.parentId!);
    if (parent?.state === 'review' || parent?.state === 'pr') {
      store.addComment(parent.id, 'faro', `Integrada en ${project.baseBranch} a través de ${taskId}, que resolvió el conflicto.`);
      bus.emitTask(store.setState(parent.id, 'done'));
    }
    for (const o of store.listTasks(['draft', 'queued', 'blocked', 'review'])) {
      if (o.id === taskId || o.branch !== task.branch || !isConflictTask(store, o)) continue;
      store.addComment(o.id, 'faro', `Ya no hace falta: ${taskId} resolvió el conflicto y la rama está integrada en ${project.baseBranch}.`);
      bus.emitTask(store.setState(o.id, 'discarded'));
    }
  }
  // Si otra tarea abierta sigue usando la rama, el worktree se queda para ella.
  const sharers = store.listTasks(OPEN_STATES).filter((o) => o.id !== taskId && o.branch === task.branch);
  if (!sharers.length) {
    try {
      // Una tarea de conflicto multi-repo se lleva también los worktrees de los repos del padre.
      await cleanupTask(workspaces, project, integrationScope(store, project, task));
    } catch (e) {
      store.addComment(taskId, 'faro', `Integrada, pero no se pudo borrar el worktree: ${(e as Error).message}`);
    }
  }
  try {
    // releaseCommit: sha integrado del repo que se publica; null = la tarea no lo incluye (Faro no lanza el build).
    if (o.releaseCommit === null) {
      if (task.release !== 'none') {
        store.addComment(taskId, 'faro', 'Pediste un lanzamiento, pero esta tarea no incluye el repo que se publica: no se lanza ningún build.');
        bus.emitTask(store.getTask(taskId));
      }
    } else {
      d.releases?.afterIntegrate(taskId, o.releaseCommit ?? commit);
    }
  } catch (e) {
    store.addComment(taskId, 'faro', `Integrada, pero no se pudo preparar el lanzamiento: ${(e as Error).message}`);
    bus.emitTask(store.getTask(taskId));
  }
  await closeFinishedParent(d, store.getTask(taskId));
  return pushed;
}

const FINISHED: TaskState[] = ['done', 'discarded'];
const OWN_CHANGES_NOTE = 'Todas sus subtareas han terminado, pero esta tarea tiene cambios propios que revisar.';

/**
 * Cuando la última hija de una tarea en revisión queda hecha o descartada (y al menos una se hizo), el padre
 * se cierra solo si no tiene cambios propios; si los tiene, sigue en revisión con un aviso (una sola vez).
 * Sube por la cadena: el abuelo puede quedar terminado a su vez.
 */
export async function closeFinishedParent(d: IntegrateDeps, child: Task): Promise<void> {
  const { store, bus, workspaces } = d;
  if (!child.parentId || !FINISHED.includes(child.state)) return;
  const parent = store.findTask(child.parentId);
  if (!parent || parent.kind !== 'task' || parent.state !== 'review' || isIntegrating(parent.id)) return;
  const kids = store.listTasks().filter((o) => o.parentId === parent.id);
  if (!kids.every((k) => FINISHED.includes(k.state)) || !kids.some((k) => k.state === 'done')) return;
  const project = getProject(d.config, parent.projectId);
  const files = parent.branch ? (await diffTask(workspaces, project, parent)).files : [];
  if (files.length > 0) {
    if (!store.listComments(parent.id).some((c) => c.author === 'faro' && c.body === OWN_CHANGES_NOTE)) {
      store.addComment(parent.id, 'faro', OWN_CHANGES_NOTE);
      bus.emitTask(store.getTask(parent.id));
    }
    return;
  }
  const sharers = store.listTasks(OPEN_STATES).filter((o) => o.id !== parent.id && parent.branch && o.branch === parent.branch);
  if (!sharers.length) {
    try {
      await cleanupTask(workspaces, project, parent);
    } catch (e) {
      store.addComment(parent.id, 'faro', `No se pudo borrar el worktree: ${(e as Error).message}`);
    }
  }
  store.addComment(parent.id, 'faro', 'Cerrada sola: todas sus subtareas han terminado y no tiene cambios propios.');
  bus.emitTask(store.setState(parent.id, 'done'));
  await closeFinishedParent(d, store.getTask(parent.id));
}
