import { shAbortable } from './exec';
import type { ProjectConfig } from './types';

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
  for (const c of project.checks) {
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
