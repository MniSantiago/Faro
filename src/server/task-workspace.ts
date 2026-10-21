import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { isMultiRepo } from './config';
import { git } from './exec';
import { taskRepos, type TaskRepo } from './task-repos';
import type { ProjectConfig, Task } from './types';
import { slugify, type Workspaces, type WorktreeRef } from './workspaces';

/*
 * Espacio de trabajo de una tarea sobre los repos que usa. Con un repo todo delega 1:1 en `Workspaces` (lo de
 * siempre). Multi-repo: carpeta worktreesDir/<rama>/ con un worktree por repo en <carpeta>/<repo.id> (misma rama
 * en todos) y, con `copyRootClaudeMd`, una copia del CLAUDE.md de rootPath.
 */

/** Lo que puede quedar en la carpeta multi-repo sin que sea trabajo de nadie (CLAUDE.md también por las carpetas de antes). */
const FOLDER_LEFTOVERS = new Set(['CLAUDE.md', '.faro']);

/** Copia rootPath/CLAUDE.md a la carpeta solo si el proyecto lo pide (`copyRootClaudeMd`). */
async function copyRootInstructions(project: ProjectConfig, folder: string): Promise<void> {
  if (project.copyRootClaudeMd !== true) return;
  const src = project.rootPath ? join(project.rootPath, 'CLAUDE.md') : null;
  if (src && existsSync(src)) await fs.copyFile(src, join(folder, 'CLAUDE.md'));
}

/** Borra la carpeta multi-repo si está vacía o solo tiene CLAUDE.md/.faro; con cualquier otra cosa la deja. */
export async function removeFolderIfLeftover(folder: string): Promise<void> {
  if (!existsSync(folder)) return;
  const entries = await fs.readdir(folder);
  if (entries.every((e) => FOLDER_LEFTOVERS.has(e))) await fs.rm(folder, { recursive: true, force: true });
}

/** Deshace un worktree recién creado y su rama (como GitWorkspaces.create cuando falla la preparación). */
async function undoCreated(ws: Workspaces, tr: TaskRepo, wtPath: string, branch: string): Promise<void> {
  await ws.removeWorktree(tr.project, wtPath).catch(() => {});
  await git(tr.repo.path, ['branch', '-D', branch]);
}

function requirePath(task: Task): string {
  if (!task.worktreePath) throw new Error(`La tarea ${task.id} no tiene worktree`);
  return task.worktreePath;
}

/** Crea los worktrees de la tarea. Un repo: igual que ws.create. Multi: carpeta worktreesDir/<rama>/ con un worktree por repo
 *  y, con copyRootClaudeMd y rootPath/CLAUDE.md, lo copia a la carpeta. Si falla un repo, deshace los ya creados. Devuelve { path, branch }. */
export async function createTaskWorkspace(ws: Workspaces, project: ProjectConfig, task: Task): Promise<WorktreeRef> {
  if (!isMultiRepo(project)) return ws.create(project, task);
  const repos = taskRepos(project, task);
  const branch = `${task.id}-${slugify(task.title)}`;
  const folder = join(project.worktreesDir, branch);
  for (const tr of repos) {
    // Que la tarea parta de lo último del remoto; si no se puede (sin red, sin remoto…), se sigue con la base local.
    const r = await ws.syncBase(tr.project).catch((e: Error) => ({ ok: false, output: e.message }));
    if (!r.ok) console.error(`[faro] ${project.id}/${tr.repo.id}: no se pudo actualizar ${tr.repo.baseBranch}: ${r.output}`);
  }
  const done: [TaskRepo, string][] = [];
  try {
    await fs.mkdir(folder, { recursive: true });
    for (const tr of repos) {
      const at = join(folder, tr.repo.id);
      await ws.create(tr.project, task, at);
      done.push([tr, at]);
    }
    await copyRootInstructions(project, folder);
  } catch (err) {
    for (const [tr, at] of done.reverse()) await undoCreated(ws, tr, at, branch);
    await removeFolderIfLeftover(folder);
    throw err;
  }
  return { path: folder, branch };
}

/** Rehace los worktrees que falten (ws.restore por repo). */
export async function restoreTaskWorkspace(ws: Workspaces, project: ProjectConfig, task: Task): Promise<void> {
  if (!isMultiRepo(project)) return ws.restore(project, task);
  const folder = requirePath(task);
  await fs.mkdir(folder, { recursive: true });
  for (const tr of taskRepos(project, task)) {
    if (!existsSync(tr.task.worktreePath!)) await ws.restore(tr.project, tr.task);
  }
  if (!existsSync(join(folder, 'CLAUDE.md'))) await copyRootInstructions(project, folder);
}

/** Chat: carpeta `${task.id}-chat` con un detached por repo (multi) o un detached (un repo). Devuelve la ruta. */
export async function createChatWorkspace(ws: Workspaces, project: ProjectConfig, task: Task): Promise<string> {
  const name = `${task.id}-chat`;
  if (!isMultiRepo(project)) return ws.createDetached(project, name);
  const folder = join(project.worktreesDir, name);
  const done: [TaskRepo, string][] = [];
  try {
    await fs.mkdir(folder, { recursive: true });
    for (const tr of taskRepos(project, task)) done.push([tr, await ws.createDetached(tr.project, `${name}/${tr.repo.id}`)]);
    await copyRootInstructions(project, folder);
  } catch (err) {
    for (const [tr, p] of done.reverse()) await ws.removeWorktree(tr.project, p).catch(() => {});
    await removeFolderIfLeftover(folder);
    throw err;
  }
  return folder;
}

/** Pone los worktrees del chat en la punta actual de la rama base de cada repo. */
export async function refreshChatWorkspace(ws: Workspaces, project: ProjectConfig, task: Task): Promise<void> {
  if (!isMultiRepo(project)) return ws.refreshDetached(project, requirePath(task));
  for (const tr of taskRepos(project, task)) await ws.refreshDetached(tr.project, requirePath(tr.task));
}

/** Commitea en cada repo de la tarea; true si alguno commiteó. */
export async function commitTask(ws: Workspaces, project: ProjectConfig, task: Task, message: string): Promise<boolean> {
  if (!isMultiRepo(project)) return ws.commitAll(requirePath(task), message);
  let any = false;
  for (const tr of taskRepos(project, task)) {
    if (await ws.commitAll(requirePath(tr.task), message)) any = true;
  }
  return any;
}

/**
 * Al descartar: commitea lo sin commitear en cada worktree que exista, cada repo por su cuenta (uno que falte o
 * falle no impide guardar los demás). Devuelve los avisos para el comentario de Faro.
 */
export async function saveTaskWork(ws: Workspaces, project: ProjectConfig, task: Task, message: string): Promise<string[]> {
  const notes: string[] = [];
  for (const tr of taskRepos(project, task)) {
    const label = tr.repo.name ?? tr.repo.id;
    if (!tr.task.worktreePath || !existsSync(tr.task.worktreePath)) {
      notes.push(`${label}: no estaba su worktree, su rama se archiva tal cual`);
      continue;
    }
    await ws.commitAll(tr.task.worktreePath, message).catch((e: Error) => {
      notes.push(`${label}: no se pudo guardar lo sin commitear: ${e.message}`);
    });
  }
  return notes;
}

/** Diff de la tarea contra la base de cada repo: archivos y patch con el prefijo del repo; byRepo sin prefijo. */
export async function diffTask(
  ws: Workspaces, project: ProjectConfig, task: Task,
): Promise<{ patch: string; files: string[]; byRepo: Record<string, string[]> }> {
  if (!isMultiRepo(project)) {
    const d = await ws.diff(project, task);
    return { ...d, byRepo: { [project.repos![0].id]: d.files } };
  }
  const patches: string[] = [];
  const files: string[] = [];
  const byRepo: Record<string, string[]> = {};
  for (const tr of taskRepos(project, task)) {
    const d = await ws.diff(tr.project, tr.task, { prefix: tr.prefix });
    if (d.patch) patches.push(d.patch);
    files.push(...d.files);
    byRepo[tr.repo.id] = d.files.map((f) => f.slice(tr.prefix.length));
  }
  return { patch: patches.join(''), files, byRepo };
}

/** Archivos que aún tienen marcadores de conflicto, con el prefijo del repo. */
export async function unresolvedTask(ws: Workspaces, project: ProjectConfig, task: Task): Promise<string[]> {
  if (!isMultiRepo(project)) return ws.unresolvedConflicts(requirePath(task));
  const left: string[] = [];
  for (const tr of taskRepos(project, task)) {
    left.push(...(await ws.unresolvedConflicts(requirePath(tr.task))).map((f) => tr.prefix + f));
  }
  return left;
}

/** Borra los worktrees (conserva las ramas). Multi: además la carpeta si queda vacía (o solo con CLAUDE.md/.faro). */
export async function cleanupTask(ws: Workspaces, project: ProjectConfig, task: Task): Promise<void> {
  if (!isMultiRepo(project)) return ws.cleanup(project, task);
  for (const tr of taskRepos(project, task)) await ws.cleanup(tr.project, tr.task);
  if (task.worktreePath) await removeFolderIfLeftover(task.worktreePath);
}

/** Borra los worktrees y archiva la rama en cada repo. Multi: además la carpeta, como cleanupTask. */
export async function discardTask(ws: Workspaces, project: ProjectConfig, task: Task): Promise<void> {
  if (!isMultiRepo(project)) return ws.discard(project, task);
  for (const tr of taskRepos(project, task)) await ws.discard(tr.project, tr.task);
  if (task.worktreePath) await removeFolderIfLeftover(task.worktreePath);
}

/** ¿Existen todas las rutas de repo de la tarea? */
export function taskWorkspaceExists(project: ProjectConfig, task: Task): boolean {
  if (!task.worktreePath) return false;
  return taskRepos(project, task).every((tr) => existsSync(tr.task.worktreePath!));
}
