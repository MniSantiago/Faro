import { isMultiRepo } from './config';
import { shAbortable } from './exec';
import { taskRepos } from './task-repos';
import type { ProjectConfig, Task } from './types';

export interface CheckResult {
  name: string;
  ok: boolean;
  skipped: boolean;
  /** Cortada por el usuario («Parar»). */
  aborted: boolean;
  output: string;
  durationMs: number;
}

export interface CheckOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Perfil de Seatbelt: las comprobaciones ejecutan código escrito por el agente. */
  sandboxProfile?: string | null;
}

export async function runChecks(
  project: ProjectConfig,
  cwd: string,
  changedFiles: string[],
  opts: CheckOptions = {},
): Promise<CheckResult[]> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const results: CheckResult[] = [];
  for (const c of project.checks ?? []) {
    if (c.whenChanged && !changedFiles.some((f) => f.startsWith(c.whenChanged!))) {
      results.push({ name: c.name, ok: true, skipped: true, aborted: false, output: '', durationMs: 0 });
      continue;
    }
    if (opts.signal?.aborted) {
      results.push({ name: c.name, ok: false, skipped: false, aborted: true, output: '[cancelada]', durationMs: 0 });
      continue;
    }
    const start = Date.now();
    const r = await shAbortable(c.command, cwd, { timeoutMs, signal: opts.signal, sandboxProfile: opts.sandboxProfile });
    let output = `${r.stdout}${r.stderr}`.slice(-20_000);
    if (r.code === 124) output += '\n[tiempo agotado]';
    if (r.code === 130) output += '\n[cancelada]';
    results.push({ name: c.name, ok: r.code === 0, skipped: false, aborted: r.code === 130, output, durationMs: Date.now() - start });
  }
  return results;
}

/**
 * Comprobaciones de la tarea en cada uno de sus repos, cada una en su worktree y con los archivos de ese repo
 * (sin prefijo: `whenChanged` es relativo al repo). Multi-repo: el nombre lleva delante el del repo, y las de un repo que la
 * tarea no cambió quedan omitidas sin ejecutarse (no cuentan como probadas). Un repo: runChecks tal cual.
 */
export async function runTaskChecks(
  project: ProjectConfig,
  task: Task,
  byRepo: Record<string, string[]>,
  opts: CheckOptions = {},
): Promise<CheckResult[]> {
  if (!task.worktreePath) throw new Error(`La tarea ${task.id} no tiene worktree`);
  if (!isMultiRepo(project)) return runChecks(project, task.worktreePath, byRepo[project.repos![0].id] ?? [], opts);
  const results: CheckResult[] = [];
  for (const tr of taskRepos(project, task)) {
    const label = tr.repo.name ?? tr.repo.id;
    const changed = byRepo[tr.repo.id] ?? [];
    const rs = changed.length
      ? await runChecks(tr.project, tr.task.worktreePath!, changed, opts)
      : (tr.project.checks ?? []).map((c): CheckResult => ({ name: c.name, ok: true, skipped: true, aborted: false, output: '', durationMs: 0 }));
    results.push(...rs.map((r) => ({ ...r, name: `${label} · ${r.name}` })));
  }
  return results;
}
