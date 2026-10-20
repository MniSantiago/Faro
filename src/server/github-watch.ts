import { getProject } from './config';
import { gitOk } from './exec';
import type { CiRun, GitHub } from './github';
import { finishIntegrated, integrate, prMetaKey, prTitle, type IntegrateDeps, type PrMeta } from './integrate';
import { isIntegrating, withIntegrationLock } from './locks';
import { notifyParent } from './subtasks';
import type { ProjectConfig, Task } from './types';

/** Fallos de CI en un PR tras los que la tarea se bloquea en vez de volver al agente. */
export const MAX_PR_CI_FAILURES = 3;
/** Sin ninguna comprobación tras este tiempo, el PR se fusiona igual (el repo no tiene CI para PR). */
export const NO_CHECKS_GRACE_MS = 10 * 60_000;

const FAILED_RUN = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);

/** Estado del CI de la rama base que Faro ya ha tratado (para avisar una vez por commit). */
interface CiMeta { sha: string; failing: boolean; taskId: string | null }

export interface WatchDeps extends IntegrateDeps {
  github: GitHub;
  enqueue: (taskId: string, nextPrompt?: string | null) => void;
  notify: (title: string, body: string, url: string) => void;
  now?: () => Date;
}

/** Vigila GitHub: los PR de las tareas en `pr` (fusionar, devolver al agente…) y el CI de la rama base. */
export class GitHubWatcher {
  constructor(private d: WatchDeps) {}

  private now(): Date { return this.d.now?.() ?? new Date(); }

  /** Revisa una vez todas las tareas que esperan a su PR. */
  async checkPrs(): Promise<void> {
    for (const t of this.d.store.listTasks(['pr'])) {
      if (isIntegrating(t.id)) continue;
      try { await this.checkPr(t); } catch (e) { console.error(`[faro] no se pudo revisar el PR de ${t.id}:`, e); }
    }
  }

  async checkPr(task: Task): Promise<void> {
    const { store, bus, github } = this.d;
    const project = getProject(this.d.config, task.projectId);
    const meta = store.getMeta<PrMeta>(prMetaKey(task.id));
    if (!meta) {
      store.addComment(task.id, 'faro', 'No encuentro el PR de esta tarea; vuelve a revisión.');
      bus.emitTask(store.setState(task.id, 'review'));
      return;
    }
    const pr = await github.viewPr(project, meta.number);
    if (pr.state === 'MERGED') return this.merged(task, project, meta);
    if (pr.state === 'CLOSED') {
      store.addComment(task.id, 'faro', `El PR #${meta.number} se cerró sin fusionar; la tarea vuelve a revisión.`);
      bus.emitTask(store.setState(task.id, 'review'));
      return;
    }
    if (pr.mergeStateStatus === 'DIRTY') {
      // La rama base avanzó y el PR choca: se repite el merge (o se crea la tarea de conflicto).
      store.addComment(task.id, 'faro', `${project.baseBranch} ha cambiado y el PR #${meta.number} choca; vuelvo a hacer el merge.`);
      bus.emitTask(store.setState(task.id, 'review'));
      await integrate(this.d, task.id, { userApproved: meta.userApproved });
      return;
    }
    const failed = pr.checks.filter((c) => c.state === 'failure');
    if (failed.length) return this.ciFailed(task, project, meta, failed.map((c) => c.name));
    const allGreen = pr.checks.length > 0 && pr.checks.every((c) => c.state === 'success');
    const noChecks = pr.checks.length === 0 && this.now().getTime() - new Date(meta.openedAt).getTime() > NO_CHECKS_GRACE_MS;
    if (!allGreen && !noChecks) return;
    await withIntegrationLock(task.id, async () => {
      await github.mergePr(project, meta.number, prTitle(store, task));
    });
    await this.merged(task, project, meta);
  }

  /** GitHub ya fusionó el PR: se borra la rama remota, se avanza la base local y la tarea queda integrada. */
  private async merged(task: Task, project: ProjectConfig, meta: PrMeta): Promise<void> {
    const { store, workspaces } = this.d;
    await workspaces.deleteRemoteBranch(project, task.branch!).catch(() => {});
    const sync = await workspaces.syncBase(project);
    if (!sync.ok) console.error(`[faro] no se pudo avanzar ${project.baseBranch} local tras el PR #${meta.number}: ${sync.output}`);
    const commit = (await gitOk(project.repoPath, ['rev-parse', `${project.remote}/${project.baseBranch}`])).trim();
    store.addComment(task.id, 'faro', `PR #${meta.number} fusionado por squash en ${project.baseBranch}.`);
    await finishIntegrated(this.d, store.getTask(task.id), { userApproved: meta.userApproved, commit, viaGithub: true });
    notifyParent(this.d, store.getTask(task.id));
  }

  private async ciFailed(task: Task, project: ProjectConfig, meta: PrMeta, checks: string[]): Promise<void> {
    const { store, bus, github } = this.d;
    const failures = meta.ciFailures + 1;
    store.setMeta(prMetaKey(task.id), { ...meta, ciFailures: failures } satisfies PrMeta);
    const runId = await github.failedRunForBranch(project, task.branch!).catch(() => null);
    const log = runId ? await github.failedLog(project, runId).catch((e: Error) => `(no se pudo leer el log: ${e.message})`) : '';
    const what = `El CI de GitHub ha fallado en el PR #${meta.number} (${checks.join(', ')})`;
    store.addComment(task.id, 'faro', `${what}, intento ${failures} de ${MAX_PR_CI_FAILURES}.${log ? `\n\n${log}` : ''}`);
    if (failures >= MAX_PR_CI_FAILURES) {
      bus.emitTask(store.setState(task.id, 'blocked', { blockedReason: `${what} ${failures} veces. Revísalo tú.` }));
      return;
    }
    this.d.enqueue(task.id,
      `${what}. Arréglalo en esta misma rama: cuando termines, Faro sube el arreglo al PR y espera otra vez al CI.` +
      (log ? `\n\nLog de los pasos fallidos:\n${log}` : ''));
  }

  /**
   * Revisa el CI de la rama base de cada proyecto con `github.ci`: el commit más reciente cuyas ejecuciones han
   * terminado todas. Si falla (y no se había tratado), avisa y crea o actualiza la tarea de arreglo; si vuelve a
   * pasar tras un fallo, avisa. En modo PR, además, mantiene al día la base local.
   */
  async checkCi(): Promise<void> {
    for (const project of this.d.config.projects) {
      if (project.github?.prs) await this.d.workspaces.syncBase(project).catch(() => {});
      if (!project.github?.ci) continue;
      try { await this.checkProjectCi(project); } catch (e) { console.error(`[faro] no se pudo revisar el CI de ${project.id}:`, e); }
    }
  }

  private async checkProjectCi(project: ProjectConfig): Promise<void> {
    const { store, bus, github } = this.d;
    const runs = await github.runs(project, project.baseBranch);
    const bySha = new Map<string, CiRun[]>();
    for (const r of runs) bySha.set(r.headSha, [...(bySha.get(r.headSha) ?? []), r]);
    const done = [...bySha.entries()].find(([, rs]) => rs.every((r) => r.status === 'completed'));
    if (!done) return;
    const [sha, shaRuns] = done;
    const key = `github.ci.${project.id}`;
    const prev = store.getMeta<CiMeta>(key);
    if (prev?.sha === sha) return;
    const failed = shaRuns.filter((r) => FAILED_RUN.has(r.conclusion));
    if (!failed.length) {
      store.setMeta(key, { sha, failing: false, taskId: null } satisfies CiMeta);
      if (prev?.failing) this.d.notify(`El CI de ${project.baseBranch} vuelve a pasar`, `${project.name} · ${sha.slice(0, 7)}`, '/#/plan');
      return;
    }
    const run = failed[0];
    const jobs = await github.failedJobs(project, run.databaseId).catch(() => [] as string[]);
    const log = await github.failedLog(project, run.databaseId).catch((e: Error) => `(no se pudo leer el log: ${e.message})`);
    const header = `El CI de ${project.baseBranch} falla en ${sha.slice(0, 7)} (${failed.map((r) => r.workflowName).join(', ')}` +
      `${jobs.length ? `: ${jobs.join(', ')}` : ''}). Ejecución: ${run.url}`;
    const open = prev?.taskId ? store.findTask(prev.taskId) : null;
    let taskId: string;
    if (open && open.state !== 'done' && open.state !== 'discarded') {
      taskId = open.id;
      store.addComment(taskId, 'faro', `${header}\n\n${log}`, { pending: true });
      bus.emitTask(store.getTask(taskId));
    } else {
      const t = store.createTask(project, {
        title: `Arreglar el CI de ${project.baseBranch} (${jobs[0] ?? failed[0].workflowName})`,
        description: `${header}\n\nArregla la causa (no desactives ni saltes tests) y deja el CI en verde. ` +
          `Comprueba en local con los mismos comandos que el CI.\n\nLog de los pasos fallidos:\n${log}`,
        profileId: this.ciProfile(jobs), level: 2,
      });
      taskId = t.id;
      bus.emitTask(t);
      this.d.enqueue(t.id);
    }
    store.setMeta(key, { sha, failing: true, taskId } satisfies CiMeta);
    this.d.notify(`El CI de ${project.baseBranch} falla`, `${project.name} · ${jobs.join(', ') || failed[0].workflowName} → ${taskId}`, `/#/tarea/${taskId}`);
  }

  /** Perfil para arreglar el CI: web si solo fallan trabajos de backend, web o landing; si no, ios. */
  private ciProfile(jobs: string[]): string {
    const ids = new Set(this.d.config.profiles.map((p) => p.id));
    const wanted = jobs.length > 0 && jobs.every((j) => /backend|web|landing/i.test(j) && !/app en la web/i.test(j)) ? 'web' : 'ios';
    if (ids.has(wanted)) return wanted;
    return this.d.config.profiles.find((p) => p.defaultLevel >= 2)?.id ?? this.d.config.profiles[0].id;
  }
}
