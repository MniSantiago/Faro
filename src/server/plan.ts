import { Backlog, type BacklogItem } from './backlog';
import { getProject } from './config';
import { fetchStoreBuild, unshipped, type StoreBuild, type Unshipped } from './shipping';
import type { CiRun, GitHub, PrSummary } from './github';
import type { Store } from './store';
import type { FaroConfig, ProjectConfig } from './types';

/** Cada cuánto se vuelve a preguntar a EAS por el último build de la tienda. */
const BUILD_TTL_MS = 3600_000;

interface CachedBuild { build: StoreBuild | null; fetchedAt: string; error: string | null }

export interface PlanState {
  /** Pendientes del backlog compartido; null si el proyecto no configura `backlogFile`. */
  backlog: BacklogItem[] | null;
  backlogError: string | null;
  build: StoreBuild | null;
  buildFetchedAt: string | null;
  buildError: string | null;
  /** Integrado desde el último build; `tested` = ya lo probaste en un dispositivo. */
  unshipped: (Unshipped & { tested: boolean })[];
  unshippedError: string | null;
  /** CI de la rama base y PR abiertos; null si el proyecto no usa GitHub. */
  github: GitHubState | null;
}

export interface GitHubState {
  ci: { sha: string; state: 'success' | 'failure' | 'pending'; url: string; workflows: string[]; at: string } | null;
  prs: PrSummary[];
  error: string | null;
}

const GITHUB_TTL_MS = 2 * 60_000;
const FAILED_RUN = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);

/** Estado del CI del commit más reciente de la rama base (todas sus ejecuciones juntas). */
export function ciState(runs: CiRun[]): GitHubState['ci'] {
  const latest = runs[0];
  if (!latest) return null;
  const same = runs.filter((r) => r.headSha === latest.headSha);
  const state = same.some((r) => FAILED_RUN.has(r.conclusion)) ? 'failure'
    : same.every((r) => r.status === 'completed') ? 'success' : 'pending';
  const shown = same.find((r) => FAILED_RUN.has(r.conclusion)) ?? latest;
  return { sha: latest.headSha, state, url: shown.url, workflows: [...new Set(same.map((r) => r.workflowName))], at: latest.createdAt };
}

/** La página «Plan»: pendientes, lo hecho sin enviar a la tienda y lo que falta probar en el iPhone. */
export class Plan {
  private refreshing = new Map<string, Promise<CachedBuild>>();
  private githubCache = new Map<string, { at: number; value: GitHubState }>();

  private githubRefreshing = new Map<string, Promise<GitHubState | null>>();

  /** Estado de GitHub con caché; una sola consulta a la vez por proyecto. */
  private githubState(p: ProjectConfig): Promise<GitHubState | null> {
    const running = this.githubRefreshing.get(p.id);
    if (running) return running;
    const job = this.loadGithubState(p).finally(() => this.githubRefreshing.delete(p.id));
    this.githubRefreshing.set(p.id, job);
    return job;
  }

  private async loadGithubState(p: ProjectConfig): Promise<GitHubState | null> {
    const gh = this.d.github;
    if (!gh || !p.github) return null;
    const hit = this.githubCache.get(p.id);
    if (hit && this.now().getTime() - hit.at < GITHUB_TTL_MS) return hit.value;
    let value: GitHubState;
    try {
      const [runs, prs] = await Promise.all([gh.runs(p, p.baseBranch, 10), gh.openPrs(p)]);
      value = { ci: ciState(runs), prs, error: null };
    } catch (e) {
      value = { ci: hit?.value.ci ?? null, prs: hit?.value.prs ?? [], error: (e as Error).message };
    }
    this.githubCache.set(p.id, { at: this.now().getTime(), value });
    return value;
  }

  constructor(private d: {
    store: Store; config: FaroConfig;
    fetchBuild?: (p: ProjectConfig) => Promise<StoreBuild | null>;
    github?: Pick<GitHub, 'runs' | 'openPrs'>;
    now?: () => Date;
  }) {}

  private backlog(p: ProjectConfig): Backlog | null {
    return p.backlogFile ? new Backlog(p.backlogFile, p.repoPath) : null;
  }

  private requireBacklog(projectId: string): Backlog {
    const b = this.backlog(getProject(this.d.config, projectId));
    if (!b) throw new Error(`El proyecto ${projectId} no tiene backlog configurado`);
    return b;
  }

  /** Pregunta a EAS (una sola consulta a la vez por proyecto) y guarda el resultado, también si falla. */
  refreshBuild(projectId: string): Promise<CachedBuild> {
    const running = this.refreshing.get(projectId);
    if (running) return running;
    const p = getProject(this.d.config, projectId);
    const job = (async () => {
      const prev = this.d.store.getMeta<CachedBuild>(`plan.build.${projectId}`);
      let next: CachedBuild;
      try {
        next = { build: await (this.d.fetchBuild ?? fetchStoreBuild)(p), fetchedAt: this.now().toISOString(), error: null };
      } catch (e) {
        // Si EAS falla se conserva el último build conocido.
        next = { build: prev?.build ?? null, fetchedAt: this.now().toISOString(), error: (e as Error).message };
      }
      this.d.store.setMeta(`plan.build.${projectId}`, next);
      return next;
    })().finally(() => this.refreshing.delete(projectId));
    this.refreshing.set(projectId, job);
    return job;
  }

  private now(): Date { return this.d.now?.() ?? new Date(); }

  async state(projectId: string): Promise<PlanState> {
    const p = getProject(this.d.config, projectId);
    let backlog: BacklogItem[] | null = null;
    let backlogError: string | null = null;
    try { backlog = this.backlog(p)?.list() ?? null; } catch (e) { backlogError = (e as Error).message; }

    let cached = this.d.store.getMeta<CachedBuild>(`plan.build.${projectId}`);
    if (!cached) cached = await this.refreshBuild(projectId);
    else if (this.now().getTime() - new Date(cached.fetchedAt).getTime() > BUILD_TTL_MS) void this.refreshBuild(projectId);

    const tested = this.tested(projectId);
    let list: PlanState['unshipped'] = [];
    let unshippedError: string | null = null;
    if (cached.build) {
      try {
        list = (await unshipped(p, cached.build.commit, this.d.store)).map((u) => ({ ...u, tested: !!(u.taskId && tested[u.taskId]) }));
      } catch (e) { unshippedError = (e as Error).message; }
    }
    return {
      backlog, backlogError, build: cached.build, buildFetchedAt: cached.fetchedAt, buildError: cached.error,
      unshipped: list, unshippedError, github: await this.githubState(p),
    };
  }

  addBacklog(projectId: string, text: string): BacklogItem { return this.requireBacklog(projectId).add(text); }
  setBacklogDone(projectId: string, id: number, isDone: boolean): BacklogItem { return this.requireBacklog(projectId).setDone(id, isDone); }

  private tested(projectId: string): Record<string, string> {
    return this.d.store.getMeta<Record<string, string>>(`plan.probados.${projectId}`) ?? {};
  }

  setTested(projectId: string, taskId: string, isTested: boolean): void {
    getProject(this.d.config, projectId);
    const cur = { ...this.tested(projectId) };
    if (isTested) cur[taskId] = this.now().toISOString(); else delete cur[taskId];
    this.d.store.setMeta(`plan.probados.${projectId}`, cur);
  }
}
