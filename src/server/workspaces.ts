import { existsSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitOk, sh } from './exec';
import { isInside } from './paths';
import type { ProjectConfig, Task } from './types';

export interface WorktreeRef {
  path: string;
  branch: string;
}

export type MergeResult = { ok: true } | { ok: false; conflict: boolean; output: string };

/** Estado del worktree tras `mergeBaseInto`: limpio (merge hecho y commiteado) o a medias con estos archivos en conflicto. */
export type BaseMergeResult = { status: 'clean' } | { status: 'conflict'; files: string[]; output: string };

export interface Workspaces {
  create(project: ProjectConfig, task: Task): Promise<WorktreeRef>;
  restore(project: ProjectConfig, task: Task): Promise<void>;
  commitAll(worktreePath: string, message: string): Promise<boolean>;
  diff(project: ProjectConfig, task: Task): Promise<{ patch: string; files: string[] }>;
  merge(project: ProjectConfig, task: Task): Promise<MergeResult>;
  updateBranch(project: ProjectConfig, task: Task): Promise<MergeResult>;
  syncBase(project: ProjectConfig): Promise<{ ok: boolean; output: string }>;
  pushBranch(project: ProjectConfig, task: Task): Promise<void>;
  deleteRemoteBranch(project: ProjectConfig, branch: string): Promise<void>;
  mergeBaseInto(project: ProjectConfig, task: Task): Promise<BaseMergeResult>;
  unresolvedConflicts(worktreePath: string): Promise<string[]>;
  push(project: ProjectConfig): Promise<void>;
  ahead(project: ProjectConfig): Promise<number>;
  listWorktrees(project: ProjectConfig): Promise<string[]>;
  removeIfClean(project: ProjectConfig, worktreePath: string): Promise<boolean>;
  cleanup(project: ProjectConfig, task: Task): Promise<void>;
  discard(project: ProjectConfig, task: Task): Promise<void>;
  createDetached(project: ProjectConfig, name: string, ref?: string): Promise<string>;
  refreshDetached(project: ProjectConfig, worktreePath: string): Promise<void>;
  removeWorktree(project: ProjectConfig, worktreePath: string): Promise<void>;
}

export function slugify(title: string): string {
  const s = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'tarea';
}

function requireBranch(task: Task): { branch: string; worktreePath: string } {
  if (!task.branch || !task.worktreePath) throw new Error(`La tarea ${task.id} no tiene worktree`);
  return { branch: task.branch, worktreePath: task.worktreePath };
}

/** Ruta real (sin enlaces, p. ej. /var → /private/var) si existe; si no, la ruta tal cual. */
export function realOr(p: string): string {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

/** Ruta del worktree que tiene `branch` en checkout, o null. */
function worktreeFor(porcelain: string, branch: string): string | null {
  for (const block of porcelain.split('\n\n')) {
    const lines = block.split('\n');
    if (lines.includes(`branch refs/heads/${branch}`)) {
      const w = lines.find((l) => l.startsWith('worktree '));
      return w ? w.slice('worktree '.length) : null;
    }
  }
  return null;
}

async function midMerge(worktreePath: string): Promise<boolean> {
  return (await git(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0;
}

async function unmergedFiles(worktreePath: string): Promise<string[]> {
  return (await gitOk(worktreePath, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
}

/** Añade `.faro/` y los patrones `extra` a `<git-common-dir>/info/exclude` (sin duplicar líneas). */
async function ensureExcluded(repo: string, extra: string[] = []): Promise<void> {
  const common = (await gitOk(repo, ['rev-parse', '--git-common-dir'])).trim();
  const file = path.resolve(repo, common, 'info', 'exclude');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const current = existsSync(file) ? await fs.readFile(file, 'utf8') : '';
  const lines = new Set(current.split('\n'));
  const missing = ['.faro/', ...extra].filter((p) => p.trim() !== '' && !lines.has(p) && lines.add(p));
  if (missing.length) {
    await fs.appendFile(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`);
  }
}

/** ¿El destino del enlace simbólico `link` (ruta absoluta) queda dentro de `root`? */
async function linkStaysInside(root: string, link: string): Promise<boolean> {
  const target = path.resolve(path.dirname(link), await fs.readlink(link));
  const realRoot = await fs.realpath(root).catch(() => root);
  const realTarget = await fs.realpath(target).catch(() => target);
  return [target, realTarget].every((t) => isInside(root, t) || isInside(realRoot, t));
}

export class GitWorkspaces implements Workspaces {
  async create(project: ProjectConfig, task: Task): Promise<WorktreeRef> {
    const branch = `${task.id}-${slugify(task.title)}`;
    const wtPath = path.join(project.worktreesDir, branch);
    await fs.mkdir(project.worktreesDir, { recursive: true });
    await gitOk(project.repoPath, ['worktree', 'add', '-b', branch, wtPath, project.baseBranch]);
    try {
      await this.prepareWorktree(project, wtPath);
    } catch (err) {
      // Deshace worktree y rama para que un reintento no falle con "branch already exists".
      await git(project.repoPath, ['worktree', 'remove', '--force', wtPath]);
      await git(project.repoPath, ['worktree', 'prune']);
      await git(project.repoPath, ['branch', '-D', branch]);
      throw err;
    }
    return { path: wtPath, branch };
  }

  /** Vuelve a crear el worktree de una rama que ya existe (p. ej. lo borró la integración de otra tarea que la compartía). */
  async restore(project: ProjectConfig, task: Task): Promise<void> {
    const { branch, worktreePath } = requireBranch(task);
    const exists = await git(project.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (exists.code !== 0) throw new Error(`El worktree de ${task.id} ya no existe y la rama ${branch} tampoco`);
    await git(project.repoPath, ['worktree', 'prune']);
    await fs.mkdir(project.worktreesDir, { recursive: true });
    await gitOk(project.repoPath, ['worktree', 'add', worktreePath, branch]);
    try {
      await this.prepareWorktree(project, worktreePath);
    } catch (err) {
      await git(project.repoPath, ['worktree', 'remove', '--force', worktreePath]);
      await git(project.repoPath, ['worktree', 'prune']);
      throw err;
    }
  }

  private async prepareWorktree(project: ProjectConfig, wtPath: string): Promise<void> {
    await ensureExcluded(project.repoPath, project.exclude);
    for (const cmd of project.prepare) {
      const r = await sh(cmd, wtPath, 10 * 60_000);
      if (r.code !== 0) throw new Error(`Falló la preparación «${cmd}»: ${(r.stderr || r.stdout).trim()}`);
    }
  }

  /** Worktree sin rama propia (HEAD separado) en `ref`: chats del Coordinador y builds. */
  async createDetached(project: ProjectConfig, name: string, ref = project.baseBranch): Promise<string> {
    const wtPath = path.join(project.worktreesDir, name);
    await fs.mkdir(project.worktreesDir, { recursive: true });
    await gitOk(project.repoPath, ['worktree', 'add', '--detach', wtPath, ref]);
    try {
      await this.prepareWorktree(project, wtPath);
    } catch (err) {
      await git(project.repoPath, ['worktree', 'remove', '--force', wtPath]);
      await git(project.repoPath, ['worktree', 'prune']);
      throw err;
    }
    return wtPath;
  }

  /** Pone el worktree separado en la punta actual de la rama base (sin fetch). */
  async refreshDetached(project: ProjectConfig, worktreePath: string): Promise<void> {
    await gitOk(worktreePath, ['checkout', '-q', '--detach', project.baseBranch]);
  }

  async removeWorktree(project: ProjectConfig, worktreePath: string): Promise<void> {
    if (existsSync(worktreePath)) await gitOk(project.repoPath, ['worktree', 'remove', '--force', worktreePath]);
    await git(project.repoPath, ['worktree', 'prune']);
  }

  async commitAll(worktreePath: string, message: string): Promise<boolean> {
    await gitOk(worktreePath, ['add', '-A']);
    await this.unstageOutsideLinks(worktreePath);
    const staged = await git(worktreePath, ['diff', '--cached', '--quiet']);
    // Un merge a medias se cierra aunque la resolución deje el árbol igual que HEAD.
    if (staged.code === 0 && !(await midMerge(worktreePath))) return false;
    await gitOk(worktreePath, ['commit', '-q', '-m', message]);
    return true;
  }

  /**
   * Saca del índice los symlinks nuevos o cambiados que apuntan fuera del worktree (p. ej. los
   * `node_modules` que crea `prepare`): integrarlos sustituiría el directorio real del repo por un enlace.
   */
  private async unstageOutsideLinks(worktreePath: string): Promise<void> {
    const raw = await gitOk(worktreePath, ['diff', '--cached', '--raw', '--no-renames', '-z']);
    const parts = raw.split('\0');
    const bad: string[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const newMode = parts[i].split(' ')[1]; // «:<modo viejo> <modo nuevo> <sha> <sha> <estado>»
      const rel = parts[i + 1];
      if (newMode !== '120000') continue;
      if (!(await linkStaysInside(worktreePath, path.join(worktreePath, rel)))) bad.push(rel);
    }
    for (const rel of bad) await gitOk(worktreePath, ['reset', '-q', '--', rel]);
  }

  async diff(project: ProjectConfig, task: Task): Promise<{ patch: string; files: string[] }> {
    const { branch } = requireBranch(task);
    const range = `${project.baseBranch}...${branch}`;
    const patch = await gitOk(project.repoPath, ['diff', range]);
    const names = await gitOk(project.repoPath, ['diff', '--name-only', range]);
    return { patch, files: names.split('\n').filter(Boolean) };
  }

  /** Merge de la rama base en la rama de la tarea (en su worktree); si choca, lo deshace. */
  async updateBranch(project: ProjectConfig, task: Task): Promise<MergeResult> {
    const { worktreePath } = requireBranch(task);
    const up = await git(worktreePath, ['merge', '--no-edit', project.baseBranch]);
    if (up.code !== 0) {
      const output = (up.stdout + up.stderr).trim() || 'git merge falló sin salida';
      const conflict = (await midMerge(worktreePath)) || output.includes('CONFLICT');
      if (conflict) await git(worktreePath, ['merge', '--abort']);
      return { ok: false, conflict, output };
    }
    return { ok: true };
  }

  async merge(project: ProjectConfig, task: Task): Promise<MergeResult> {
    const { branch } = requireBranch(task);
    const up = await this.updateBranch(project, task);
    if (!up.ok) return up;
    const porcelain = await gitOk(project.repoPath, ['worktree', 'list', '--porcelain']);
    const basePath = worktreeFor(porcelain, project.baseBranch);
    const ff = basePath
      ? await git(basePath, ['merge', '--ff-only', branch])
      : await git(project.repoPath, ['fetch', '.', `${branch}:${project.baseBranch}`]);
    if (ff.code !== 0) return { ok: false, conflict: false, output: (ff.stdout + ff.stderr).trim() };
    return { ok: true };
  }

  /**
   * Para las tareas de conflicto: Faro hace merge de la rama base en el worktree y, si hay conflictos,
   * lo deja a medias con los marcadores en los archivos para que el agente solo tenga que editarlos.
   * Si ya había un merge a medias (reintento), lo respeta.
   */
  async mergeBaseInto(project: ProjectConfig, task: Task): Promise<BaseMergeResult> {
    const { worktreePath } = requireBranch(task);
    if (await midMerge(worktreePath)) return { status: 'conflict', files: await unmergedFiles(worktreePath), output: '' };
    const r = await git(worktreePath, ['merge', '--no-edit', project.baseBranch]);
    if (r.code === 0) return { status: 'clean' };
    const output = (r.stdout + r.stderr).trim() || 'git merge falló sin salida';
    if (!(await midMerge(worktreePath))) throw new Error(`No se pudo hacer merge de ${project.baseBranch}: ${output}`);
    return { status: 'conflict', files: await unmergedFiles(worktreePath), output };
  }

  /** Archivos del merge a medias que aún tienen marcadores de conflicto (vacío si no hay merge a medias). */
  async unresolvedConflicts(worktreePath: string): Promise<string[]> {
    if (!(await midMerge(worktreePath))) return [];
    const left: string[] = [];
    for (const rel of await unmergedFiles(worktreePath)) {
      const file = path.join(worktreePath, rel);
      if (!existsSync(file)) continue; // Resuelto borrándolo.
      if (/^(<{7}|>{7})( |$)/m.test(await fs.readFile(file, 'utf8'))) left.push(rel);
    }
    return left;
  }

  /**
   * Sube la rama base. Si el remoto tiene commits nuevos (p. ej. un PR fusionado en GitHub), los trae, los
   * fusiona en la rama base y vuelve a subir; si chocan (o tocan cambios sin commitear), falla sin dejar nada a medias.
   */
  async push(project: ProjectConfig): Promise<void> {
    const { repoPath, remote, baseBranch } = project;
    const first = await git(repoPath, ['push', remote, baseBranch]);
    if (first.code === 0) return;
    const out = (first.stdout + first.stderr).trim();
    if (!/non-fast-forward|fetch first|rejected/.test(out)) throw new Error(`git push ${remote} ${baseBranch} falló: ${out}`);
    await gitOk(repoPath, ['fetch', remote, baseBranch]);
    const basePath = worktreeFor(await gitOk(repoPath, ['worktree', 'list', '--porcelain']), baseBranch);
    if (!basePath) throw new Error(`${remote} tiene commits nuevos y ${baseBranch} no está en ningún checkout para fusionarlos`);
    const merged = await git(basePath, ['merge', '--no-edit', `${remote}/${baseBranch}`]);
    if (merged.code !== 0) {
      await git(basePath, ['merge', '--abort']);
      throw new Error(`Lo nuevo de ${remote}/${baseBranch} choca con ${baseBranch}; fusiónalo a mano: ${(merged.stdout + merged.stderr).trim()}`);
    }
    await gitOk(repoPath, ['push', remote, baseBranch]);
  }

  /**
   * Trae la rama base del remoto y avanza la local hasta ella si es un avance rápido (en su checkout, sin pisar
   * cambios sin commitear). Si no se puede (p. ej. la local tiene commits propios), no toca nada.
   */
  async syncBase(project: ProjectConfig): Promise<{ ok: boolean; output: string }> {
    const { repoPath, remote, baseBranch } = project;
    const f = await git(repoPath, ['fetch', remote, baseBranch]);
    if (f.code !== 0) return { ok: false, output: (f.stdout + f.stderr).trim() };
    const target = `${remote}/${baseBranch}`;
    const basePath = worktreeFor(await gitOk(repoPath, ['worktree', 'list', '--porcelain']), baseBranch);
    const r = basePath
      ? await git(basePath, ['merge', '--ff-only', target])
      : await git(repoPath, ['fetch', '.', `${target}:${baseBranch}`]);
    return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
  }

  /** Sube la rama de la tarea al remoto (para su PR). */
  async pushBranch(project: ProjectConfig, task: Task): Promise<void> {
    const { branch } = requireBranch(task);
    await gitOk(project.repoPath, ['push', '-u', project.remote, `${branch}:${branch}`]);
  }

  /** Borra la rama del remoto tras fusionar su PR (no falla si ya no existe). */
  async deleteRemoteBranch(project: ProjectConfig, branch: string): Promise<void> {
    await git(project.repoPath, ['push', project.remote, '--delete', branch]);
  }

  /** Rutas de los worktrees del repo que están dentro de `worktreesDir` (rutas reales). */
  async listWorktrees(project: ProjectConfig): Promise<string[]> {
    const porcelain = await gitOk(project.repoPath, ['worktree', 'list', '--porcelain']);
    const root = realOr(project.worktreesDir);
    return porcelain.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => realOr(l.slice('worktree '.length)))
      .filter((p) => p.startsWith(root + path.sep));
  }

  /** Borra el worktree solo si no tiene cambios sin commitear; devuelve si lo borró. */
  async removeIfClean(project: ProjectConfig, worktreePath: string): Promise<boolean> {
    const r = await git(project.repoPath, ['worktree', 'remove', worktreePath]);
    return r.code === 0;
  }

  /** Commits de la rama base que el remoto aún no tiene (según la última copia local del remoto; 0 si no la hay). */
  async ahead(project: ProjectConfig): Promise<number> {
    const r = await git(project.repoPath, ['rev-list', '--count', `${project.remote}/${project.baseBranch}..${project.baseBranch}`]);
    return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
  }

  async cleanup(project: ProjectConfig, task: Task): Promise<void> {
    if (task.worktreePath && existsSync(task.worktreePath)) {
      await gitOk(project.repoPath, ['worktree', 'remove', '--force', task.worktreePath]);
    }
    await git(project.repoPath, ['worktree', 'prune']);
  }

  async discard(project: ProjectConfig, task: Task): Promise<void> {
    await this.cleanup(project, task);
    if (!task.branch) return;
    const exists = await git(project.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${task.branch}`]);
    if (exists.code === 0) await gitOk(project.repoPath, ['branch', '-M', task.branch, `archive/${task.branch}`]);
  }
}
