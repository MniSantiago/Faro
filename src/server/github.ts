import { exec } from './exec';
import type { ProjectConfig } from './types';

/** Una ejecución de CI (GitHub Actions) tal como la da `gh run list`. */
export interface CiRun {
  databaseId: number; headSha: string; status: string; conclusion: string; workflowName: string; url: string; createdAt: string;
}

/** Una comprobación de un PR: `state` resume su estado («pending», «success» o «failure»). */
export interface PrCheck { name: string; state: 'pending' | 'success' | 'failure' }

export interface PrView {
  number: number; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; mergeStateStatus: string; headRefName: string; checks: PrCheck[];
}

export interface PrSummary { number: number; title: string; url: string; headRefName: string; isDraft: boolean }

const FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR', 'failure', 'cancelled', 'timed_out']);
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'success', 'neutral', 'skipped']);

/** Resume una entrada de `statusCheckRollup` (CheckRun o StatusContext) en pending/success/failure. */
export function checkState(c: { status?: string; conclusion?: string; state?: string }): PrCheck['state'] {
  const verdict = c.conclusion || c.state || '';
  if (c.status && c.status !== 'COMPLETED' && c.status !== 'completed') return 'pending';
  if (PASSED.has(verdict)) return 'success';
  if (FAILED.has(verdict)) return 'failure';
  return 'pending';
}

/**
 * La CLI `gh` con la sesión del usuario en el Mac, siempre en el repo del proyecto (gh saca el repo de su remoto).
 * Cada llamada lanza un error con la salida de gh si falla.
 */
export class GitHub {
  constructor(private bin = 'gh', private env?: NodeJS.ProcessEnv) {}

  private async run(project: ProjectConfig, args: string[], timeoutMs = 60_000): Promise<string> {
    const r = await exec(this.bin, args, { cwd: project.repoPath, timeoutMs, env: this.env });
    if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} falló: ${(r.stderr || r.stdout).trim().slice(-500)}`);
    return r.stdout;
  }

  private async json<T>(project: ProjectConfig, args: string[]): Promise<T> {
    return JSON.parse(await this.run(project, args)) as T;
  }

  /** Ejecuciones de CI de los push a `branch`, de la más nueva a la más vieja. */
  runs(project: ProjectConfig, branch: string, limit = 20): Promise<CiRun[]> {
    return this.json(project, ['run', 'list', '--branch', branch, '--event', 'push', '--limit', String(limit),
      '--json', 'databaseId,headSha,status,conclusion,workflowName,url,createdAt']);
  }

  /** Nombres de los trabajos que fallaron en una ejecución. */
  async failedJobs(project: ProjectConfig, runId: number): Promise<string[]> {
    const r = await this.json<{ jobs: { name: string; conclusion: string }[] }>(project, ['run', 'view', String(runId), '--json', 'jobs']);
    return r.jobs.filter((j) => FAILED.has(j.conclusion)).map((j) => j.name);
  }

  /** Las últimas `lines` líneas de los pasos que fallaron (sin códigos de color). */
  async failedLog(project: ProjectConfig, runId: number, lines = 200): Promise<string> {
    const out = await this.run(project, ['run', 'view', String(runId), '--log-failed'], 120_000);
    // eslint-disable-next-line no-control-regex
    return out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-lines).join('\n').trim();
  }

  /** El PR abierto cuya rama es `branch`, o null. */
  async openPrFor(project: ProjectConfig, branch: string): Promise<{ number: number; url: string } | null> {
    const list = await this.json<{ number: number; url: string }[]>(project, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url']);
    return list[0] ?? null;
  }

  async createPr(project: ProjectConfig, o: { branch: string; title: string; body: string }): Promise<{ number: number; url: string }> {
    const out = await this.run(project, ['pr', 'create', '--base', project.baseBranch, '--head', o.branch, '--title', o.title, '--body', o.body]);
    const url = out.trim().split('\n').pop()!.trim();
    const n = Number(url.match(/\/pull\/(\d+)/)?.[1]);
    if (!n) throw new Error(`gh pr create no devolvió el enlace del PR: ${out.trim()}`);
    return { number: n, url };
  }

  async viewPr(project: ProjectConfig, n: number): Promise<PrView> {
    const r = await this.json<{
      number: number; url: string; state: PrView['state']; mergeStateStatus: string; headRefName: string;
      statusCheckRollup: { name?: string; context?: string; status?: string; conclusion?: string; state?: string }[] | null;
    }>(project, ['pr', 'view', String(n), '--json', 'number,url,state,mergeStateStatus,headRefName,statusCheckRollup']);
    return {
      number: r.number, url: r.url, state: r.state, mergeStateStatus: r.mergeStateStatus, headRefName: r.headRefName,
      checks: (r.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context ?? '?', state: checkState(c) })),
    };
  }

  /** Ejecución de CI fallida más reciente del PR (para sacar su log), o null. */
  async failedRunForBranch(project: ProjectConfig, branch: string): Promise<number | null> {
    const list = await this.json<CiRun[]>(project, ['run', 'list', '--branch', branch, '--limit', '10',
      '--json', 'databaseId,headSha,status,conclusion,workflowName,url,createdAt']);
    return list.find((r) => r.status === 'completed' && FAILED.has(r.conclusion))?.databaseId ?? null;
  }

  async mergePr(project: ProjectConfig, n: number, subject: string): Promise<void> {
    await this.run(project, ['pr', 'merge', String(n), '--squash', '--subject', subject, '--body', '']);
  }

  async closePr(project: ProjectConfig, n: number, comment: string): Promise<void> {
    await this.run(project, ['pr', 'close', String(n), '--comment', comment]);
  }

  openPrs(project: ProjectConfig): Promise<PrSummary[]> {
    return this.json(project, ['pr', 'list', '--state', 'open', '--limit', '20', '--json', 'number,title,url,headRefName,isDraft']);
  }
}
