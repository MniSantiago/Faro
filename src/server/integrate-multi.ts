import { existsSync } from 'node:fs';
import { getProject, isMultiRepo } from './config';
import { git, gitOk } from './exec';
import {
  closeFinishedParent, finishIntegrated, isConflictTask, MAX_CONFLICT_RETRIES, resolvingConflictTask, RETRY_MARK,
  type IntegrateDeps, type IntegrateResult,
} from './integrate';
import type { Store } from './store';
import { releaseRepo, repoView, taskRepos, type TaskRepo } from './task-repos';
import { cleanupTask, diffTask } from './task-workspace';
import type { Level, ProjectConfig, Task } from './types';
import { worktreeFor, type Workspaces } from './workspaces';

/*
 * Integración local de una tarea multi-repo: o avanzan las ramas base de todos sus repos o ninguna. Sin PR:
 * la config no admite github.prs/ci con varios repos.
 */

/** Ids en el orden del proyecto. */
function inProjectOrder(project: ProjectConfig, ids: Iterable<string>): string[] {
  const set = new Set(ids);
  return project.repos!.map((r) => r.id).filter((id) => set.has(id));
}

/**
 * La tarea con los repos que hay que integrar. Una tarea de conflicto solo resolvió algunos repos, pero su rama
 * lleva el trabajo del padre en todos los suyos: se integran los del padre más los de ella.
 */
export function integrationScope(store: Pick<Store, 'findTask'>, project: ProjectConfig, task: Task): Task {
  if (!isMultiRepo(project) || !isConflictTask(store, task)) return task;
  const parent = store.findTask(task.parentId!)!;
  if (task.repos === null || parent.repos === null) return { ...task, repos: null };
  return { ...task, repos: inProjectOrder(project, [...parent.repos, ...task.repos]) };
}

function conflictDescription(parentId: string, branch: string, hits: { tr: TaskRepo; output: string }[]): string {
  const where = hits.map((h) => `${h.tr.repo.id} (${h.tr.repo.baseBranch})`).join(', ');
  return [
    `Al integrar ${parentId} (rama ${branch}) hubo conflictos con la rama base de: ${where}.`,
    'Antes de lanzarte, Faro hace merge de la rama base de cada uno de esos repos en esta rama y deja los marcadores ' +
      'de conflicto (<<<<<<<, =======, >>>>>>>) en los archivos afectados.',
    'Tu trabajo: edita esos archivos para resolver cada conflicto conservando la intención de ambos lados y ' +
      'quita todos los marcadores. No ejecutes git merge, git add ni git commit: al terminar, Faro cierra el merge, ' +
      'lo commitea y lo integra.',
    '',
    ...hits.map((h) => `Salida de git (${h.tr.repo.id}):\n${h.output}`),
  ].join('\n');
}

type Advanced = { tr: TaskRepo; old: string; next: string; checkout: string | null };

/** Avanza la rama base del repo hasta la de la tarea (como `merge()`: en su checkout si lo tiene). */
async function advanceBase(tr: TaskRepo): Promise<{ ok: true; adv: Advanced } | { ok: false; output: string }> {
  const { path: repo, baseBranch } = tr.repo;
  const branch = tr.task.branch!;
  const old = (await gitOk(repo, ['rev-parse', `refs/heads/${baseBranch}`])).trim();
  const checkout = worktreeFor(await gitOk(repo, ['worktree', 'list', '--porcelain']), baseBranch);
  const r = checkout
    ? await git(checkout, ['merge', '--ff-only', branch])
    : await git(repo, ['fetch', '.', `${branch}:${baseBranch}`]);
  if (r.code !== 0) return { ok: false, output: (r.stdout + r.stderr).trim() || 'git falló sin salida' };
  const next = (await gitOk(repo, ['rev-parse', `refs/heads/${baseBranch}`])).trim();
  return { ok: true, adv: { tr, old, next, checkout } };
}

/** Deshace un avance (sin pisar cambios sin commitear en su checkout); devuelve el error si no pudo. */
async function rollbackBase(a: Advanced): Promise<string | null> {
  const { path: repo, baseBranch } = a.tr.repo;
  const r = a.checkout
    ? await git(a.checkout, ['reset', '-q', '--keep', a.old])
    : await git(repo, ['update-ref', `refs/heads/${baseBranch}`, a.old, a.next]);
  return r.code === 0 ? null : (r.stdout + r.stderr).trim() || 'git falló sin salida';
}

export async function integrateMulti(d: IntegrateDeps, task: Task, opts: { userApproved: boolean }): Promise<IntegrateResult> {
  const { store, bus, workspaces: ws } = d;
  const taskId = task.id;
  const project = getProject(d.config, task.projectId);
  const scope = integrationScope(store, project, task);

  const diff = await diffTask(ws, project, scope);
  if (diff.files.length === 0) {
    try {
      await cleanupTask(ws, project, task);
    } catch (e) {
      store.addComment(taskId, 'faro', `Sin cambios que integrar, pero no se pudo borrar el worktree: ${(e as Error).message}`);
    }
    bus.emitTask(store.setState(taskId, 'done'));
    await closeFinishedParent(d, store.getTask(taskId));
    return { status: 'nothing' };
  }

  const resolving = resolvingConflictTask(store, task);
  if (resolving) {
    return { status: 'failed', message: `${resolving.id} ya está resolviendo el conflicto de esta tarea; cuando se integre, esta quedará hecha.` };
  }

  const repos = taskRepos(project, scope);
  // P. ej. el worktree de un repo del padre que no tocaba la tarea de conflicto y alguien borró.
  for (const tr of repos) if (tr.task.worktreePath && !existsSync(tr.task.worktreePath)) await ws.restore(tr.project, tr.task);
  for (const tr of repos) {
    const r = await ws.syncBase(tr.project).catch((e: Error) => ({ ok: false, output: e.message }));
    if (!r.ok) console.error(`[faro] ${project.id}/${tr.repo.id}: no se pudo avanzar ${tr.repo.baseBranch} hasta ${tr.repo.remote}: ${r.output}`);
  }

  const conflicts: { tr: TaskRepo; output: string }[] = [];
  const errors: { tr: TaskRepo; output: string }[] = [];
  for (const tr of repos) {
    const r = await ws.updateBranch(tr.project, tr.task);
    if (!r.ok) (r.conflict ? conflicts : errors).push({ tr, output: r.output });
  }
  const gitOutput = (hits: { tr: TaskRepo; output: string }[]) => hits.map((h) => `${h.tr.repo.id}:\n${h.output}`).join('\n\n');

  if (errors.length) {
    const message = `No se pudo integrar (no ha avanzado ningún repo): ${errors.map((e) => `${e.tr.repo.id}: ${e.output}`).join('; ')}`;
    store.addComment(taskId, 'faro', message);
    bus.emitTask(store.getTask(taskId));
    return { status: 'failed', message };
  }

  if (conflicts.length && isConflictTask(store, task)) {
    const where = conflicts.map((c) => `${c.tr.repo.id}: ${c.tr.repo.baseBranch}`).join(', ');
    const retries = store.listComments(taskId).filter((c) => c.author === 'faro' && c.body.startsWith(RETRY_MARK)).length;
    if (d.enqueue && retries < MAX_CONFLICT_RETRIES) {
      // Puede chocar un repo que esta tarea no tenía (uno del padre): pasa a ser suyo para que Faro haga su merge.
      if (task.repos !== null) {
        const wider = inProjectOrder(project, [...task.repos, ...conflicts.map((c) => c.tr.repo.id)]);
        if (wider.length !== task.repos.length) store.updateTask(taskId, { repos: wider });
      }
      store.addComment(taskId, 'faro',
        `${RETRY_MARK} (${where}, intento ${retries + 1} de ${MAX_CONFLICT_RETRIES}): ` +
        `la pongo otra vez en cola y hago el merge antes de lanzar al agente.\n\nSalida de git:\n${gitOutput(conflicts)}`);
      d.enqueue(taskId, `La rama base ha vuelto a cambiar (${where}) mientras resolvías el conflicto. Resuelve los conflictos nuevos igual que antes.`);
      return { status: 'conflict', followUpTaskId: taskId };
    }
    const message = `La rama base ha vuelto a cambiar (${where}) y hay conflictos nuevos al integrar` +
      (d.enqueue ? ` (ya lo he reintentado ${MAX_CONFLICT_RETRIES} veces). ` : '. ') +
      'Reenvíala a la cola (por ejemplo, con un mensaje) y Faro volverá a hacer el merge antes de lanzar al agente.';
    store.addComment(taskId, 'faro', `${message}\n\nSalida de git:\n${gitOutput(conflicts)}`);
    bus.emitTask(store.setState(taskId, 'blocked', { blockedReason: message, attempts: 0 }));
    return { status: 'failed', message };
  }

  if (conflicts.length) {
    const follow = store.createTask(project, {
      title: `Resolver conflicto: ${task.title}`,
      description: conflictDescription(taskId, task.branch!, conflicts),
      profileId: task.profileId,
      level: Math.max(task.level, 2) as Level,
      parentId: taskId,
      release: task.release,
      // Solo los repos que chocan; la carpeta y la rama son las del padre.
      repos: conflicts.map((c) => c.tr.repo.id),
    });
    const shared = store.updateTask(follow.id, { branch: task.branch, worktreePath: task.worktreePath });
    const where = conflicts.map((c) => c.tr.repo.id).join(', ');
    store.addComment(taskId, 'faro', d.enqueue
      ? `Conflicto al integrar (${where}); no se ha integrado ningún repo. He creado ${follow.id} y la he puesto en cola para resolverlo.`
      : `Conflicto al integrar (${where}); no se ha integrado ningún repo. He creado ${follow.id} (borrador) para resolverlo.`);
    bus.emitTask(shared);
    bus.emitTask(store.getTask(taskId));
    d.enqueue?.(follow.id);
    return { status: 'conflict', followUpTaskId: follow.id };
  }

  // Todas las bases tienen que estar ya en la rama: entonces cada avance es un fast-forward.
  const behind: string[] = [];
  for (const tr of repos) {
    const r = await git(tr.repo.path, ['merge-base', '--is-ancestor', tr.repo.baseBranch, tr.task.branch!]);
    if (r.code !== 0) behind.push(tr.repo.id);
  }
  if (behind.length) {
    const message = `No se pudo integrar: la rama base de ${behind.join(', ')} ha cambiado mientras tanto (no ha avanzado ningún repo). Vuelve a intentarlo.`;
    store.addComment(taskId, 'faro', message);
    bus.emitTask(store.getTask(taskId));
    return { status: 'failed', message };
  }

  const advanced: Advanced[] = [];
  for (const tr of repos) {
    const r = await advanceBase(tr).catch((e: Error) => ({ ok: false as const, output: e.message }));
    if (r.ok) {
      advanced.push(r.adv);
      continue;
    }
    const stuck: string[] = [];
    for (const a of advanced.reverse()) {
      const err = await rollbackBase(a);
      if (err) stuck.push(`${a.tr.repo.id} (${err})`);
    }
    const message = `No se pudo integrar en ${tr.repo.id} (${tr.repo.baseBranch}): ${r.output}` +
      (stuck.length ? `. No se pudo deshacer el avance de ${stuck.join(', ')}: revísalo a mano.` : '. No ha avanzado ningún repo.');
    store.addComment(taskId, 'faro', message);
    bus.emitTask(store.getTask(taskId));
    return { status: 'failed', message };
  }

  const main = project.repos![0];
  const commit = (await gitOk(main.path, ['rev-parse', main.baseBranch])).trim();
  // El build sale del repo con `release`: su sha integrado, no el de repos[0]. null = esta tarea no lo toca.
  const rr = releaseRepo(project);
  const releaseCommit = !rr ? undefined
    : repos.some((tr) => tr.repo.id === rr.id) ? (await gitOk(rr.path, ['rev-parse', rr.baseBranch])).trim() : null;
  const pushed = await finishIntegrated(d, task, { userApproved: opts.userApproved, commit, viaGithub: false, releaseCommit });
  return { status: 'merged', pushed };
}

export interface PushReport { pushed: string[]; failed: { repo: string; error: string }[] }

/**
 * Sube la rama base de cada repo del proyecto que va por delante del remoto, en orden; sigue con los demás aunque
 * falle uno. Los que están al día se saltan: un push sin nada que subir podría chocar con lo nuevo del remoto.
 */
export async function pushTaskProject(ws: Pick<Workspaces, 'push' | 'ahead'>, project: ProjectConfig): Promise<PushReport> {
  const out: PushReport = { pushed: [], failed: [] };
  for (const repo of project.repos!) {
    const view = repoView(project, repo);
    try {
      if ((await ws.ahead(view)) === 0) continue;
      await ws.push(view);
      out.pushed.push(repo.id);
    } catch (e) {
      out.failed.push({ repo: repo.id, error: (e as Error).message.trim() });
    }
  }
  return out;
}

/** «Subidos: a. Falta: b (motivo). Reintenta para subir lo que falta.» */
export function pushFailureMessage(r: PushReport): string {
  const missing = r.failed.map((f) => `${f.repo} (${f.error})`).join(', ');
  const done = r.pushed.length ? `Subidos: ${r.pushed.join(', ')}.` : 'No se ha subido ninguno.';
  return `${done} Falta: ${missing}. Reintenta para subir lo que falta.`;
}

/** Commits sin subir del proyecto: con varios repos, la suma de los de cada uno. */
export async function aheadTaskProject(ws: Pick<Workspaces, 'ahead'>, project: ProjectConfig): Promise<number> {
  if (!isMultiRepo(project)) return ws.ahead(project);
  let n = 0;
  for (const repo of project.repos!) n += await ws.ahead(repoView(project, repo));
  return n;
}
