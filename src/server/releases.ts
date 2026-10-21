import fs from 'node:fs/promises';
import path from 'node:path';
import type { Bus } from './bus';
import { getProject } from './config';
import { ActionError } from './errors';
import { shAbortable } from './exec';
import { decide } from './policy';
import type { Store } from './store';
import { releaseRepo, repoView } from './task-repos';
import type { FaroConfig, FinalAction, Job, JobKind } from './types';
import type { Workspaces } from './workspaces';

const LABEL: Record<JobKind, string> = { build: 'build de EAS', submit: 'envío a App Store' };

export function parseBuildJson(stdout: string): { buildId?: string; url?: string } {
  const start = stdout.search(/^\s*[[{]/m);
  if (start < 0) return {};
  try {
    const v = JSON.parse(stdout.slice(start).trim()) as unknown;
    const first = (Array.isArray(v) ? v[0] : v) as { id?: unknown; artifacts?: { buildUrl?: unknown } } | undefined;
    const out: { buildId?: string; url?: string } = {};
    if (typeof first?.id === 'string') out.buildId = first.id;
    // Solo enlaces https: la URL se muestra como enlace en la interfaz.
    const url = first?.artifacts?.buildUrl;
    if (typeof url === 'string' && url.startsWith('https://')) out.url = url;
    return out;
  } catch {
    return {};
  }
}

/** Aviso de un lanzamiento cortado por un reinicio o cierre de Faro: el trabajo en la nube puede seguir. */
export function interruptedNote(kind: JobKind, when: 'reinicio' | 'cierre'): string {
  const what = when === 'reinicio' ? 'al reiniciarse Faro' : 'al cerrarse Faro';
  const check = kind === 'build'
    ? 'Comprueba en expo.dev si el build siguió en la nube antes de reintentar.'
    : 'Comprueba en expo.dev y en App Store Connect si el envío llegó a completarse antes de reintentar.';
  return `El ${LABEL[kind]} se interrumpió ${what}. ${check} Pulsa Reintentar para volver a lanzarlo.`;
}

interface Deps {
  store: Store;
  config: FaroConfig;
  bus: Bus;
  workspaces: Pick<Workspaces, 'createDetached' | 'removeWorktree'>;
  env?: NodeJS.ProcessEnv;
}

export class Releases {
  private procs = new Map<number, AbortController>();
  private pending = new Set<Promise<void>>();
  private closing = false;

  constructor(private d: Deps) {}

  private note(taskId: string, body: string): void {
    this.d.store.addComment(taskId, 'faro', body);
    this.d.bus.emitTask(this.d.store.getTask(taskId));
  }

  private runningFor(taskId: string): boolean {
    return this.d.store.listJobs(taskId).some((j) => j.state === 'running');
  }

  private pendingApproval(taskId: string, action: FinalAction) {
    return this.d.store.listApprovals(taskId).find((a) => a.action === action && a.state === 'pending');
  }

  private lastOkBuild(taskId: string): Job | undefined {
    return this.d.store.listJobs(taskId).filter((j) => j.kind === 'build' && j.state === 'ok').at(-1);
  }

  /** Tras integrar: guarda el commit y lanza el build (nivel 4) o lo deja pendiente de aprobación. */
  afterIntegrate(taskId: string, commit: string): void {
    const { store } = this.d;
    const t = store.getTask(taskId);
    if (t.release === 'none') return;
    if (!releaseRepo(getProject(this.d.config, t.projectId))) {
      this.note(taskId, 'Pediste un lanzamiento, pero el proyecto no tiene configuración de EAS.');
      return;
    }
    store.setMeta(`release-commit:${taskId}`, commit);
    if (decide(t.level, 'eas') === 'auto') {
      store.addApproval(taskId, 'eas', 'auto');
      this.start(taskId, 'build');
    } else {
      store.addApproval(taskId, 'eas', 'pending');
      this.note(taskId, 'Build de EAS pendiente de tu aprobación.');
    }
  }

  request(taskId: string): Job {
    const { store } = this.d;
    if (this.runningFor(taskId)) throw new ActionError('Ya hay un lanzamiento en curso para esta tarea');
    const eas = this.pendingApproval(taskId, 'eas');
    if (eas) {
      store.decideApproval(eas.id, 'approved');
      return this.start(taskId, 'build');
    }
    const pub = this.pendingApproval(taskId, 'publish');
    if (pub) {
      if (!this.lastOkBuild(taskId)) throw new ActionError('No hay un build terminado que enviar');
      store.decideApproval(pub.id, 'approved');
      return this.start(taskId, 'submit', this.lastOkBuild(taskId)!.meta.buildId);
    }
    throw new ActionError(`${taskId} no tiene ningún lanzamiento pendiente`);
  }

  retry(jobId: number): Job {
    const j = this.d.store.getJob(jobId);
    if (this.runningFor(j.taskId)) throw new ActionError('Ya hay un lanzamiento en curso para esta tarea');
    if (j.state !== 'failed' && j.state !== 'interrupted') throw new ActionError('Solo se puede reintentar un lanzamiento fallido o interrumpido');
    const latest = this.d.store.listJobs(j.taskId).filter((x) => x.kind === j.kind).at(-1);
    if (latest?.id !== j.id) throw new ActionError('Ya hay un intento más reciente de este lanzamiento');
    if (j.kind === 'submit') {
      if (this.pendingApproval(j.taskId, 'publish')) throw new ActionError('El envío está pendiente de tu aprobación: usa «Enviar a App Store»');
      if (!j.meta.buildId || this.lastOkBuild(j.taskId)?.meta.buildId !== j.meta.buildId) {
        throw new ActionError('Hay un build más reciente: usa «Enviar a App Store»');
      }
      return this.start(j.taskId, 'submit', j.meta.buildId);
    }
    return this.start(j.taskId, 'build');
  }

  stop(jobId: number): void {
    this.procs.get(jobId)?.abort();
  }

  recover(): void {
    for (const j of this.d.store.runningJobs()) {
      this.d.store.finishJob(j.id, 'interrupted');
      this.note(j.taskId, interruptedNote(j.kind, 'reinicio'));
      try {
        const project = getProject(this.d.config, this.d.store.getTask(j.taskId).projectId);
        const rr = releaseRepo(project);
        if (!rr) continue;
        void this.d.workspaces.removeWorktree(repoView(project, rr), path.join(project.worktreesDir, `_release-${j.taskId}-${j.id}`)).catch(() => {});
      } catch { /* sin proyecto: nada que limpiar */ }
    }
  }

  async waitIdle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  async shutdown(graceMs = 10_000): Promise<void> {
    this.closing = true;
    const t = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), graceMs).unref());
    if ((await Promise.race([this.waitIdle().then(() => 'idle' as const), t])) === 'timeout') {
      for (const ac of this.procs.values()) ac.abort();
      await Promise.race([this.waitIdle(), new Promise((r) => setTimeout(r, 3000).unref())]);
    }
  }

  private start(taskId: string, kind: JobKind, buildId?: string): Job {
    let job = this.d.store.createJob(taskId, kind);
    if (buildId !== undefined) {
      this.d.store.setJobMeta(job.id, { buildId });
      job = this.d.store.getJob(job.id);
    }
    this.note(taskId, `${LABEL[kind][0].toUpperCase()}${LABEL[kind].slice(1)} en curso…`);
    const ac = new AbortController();
    this.procs.set(job.id, ac);
    const p: Promise<void> = this.execute(job, ac)
      .catch((e: Error) => {
        this.d.store.finishJob(job.id, 'failed');
        this.note(taskId, `El ${LABEL[kind]} falló: ${e.message}`);
      })
      .finally(() => { this.procs.delete(job.id); this.pending.delete(p); });
    this.pending.add(p);
    return job;
  }

  private async execute(job: Job, ac: AbortController): Promise<void> {
    const { store, config, workspaces } = this.d;
    const task = store.getTask(job.taskId);
    const project = getProject(config, task.projectId);
    // Los builds salen del repo que tiene `release` (en un proyecto de un repo, el único).
    const rrepo = releaseRepo(project);
    if (!rrepo) throw new Error('El proyecto no tiene configuración de EAS');
    const rproject = repoView(project, rrepo);
    const rc = rrepo.release!;
    const commit = store.getMeta<string>(`release-commit:${task.id}`);
    if (!commit) throw new Error('No se sabe qué commit lanzar');
    let cmd = job.kind === 'build' ? rc.build : rc.submit;
    if (job.kind === 'submit') {
      const buildId = job.meta.buildId;
      if (!buildId) throw new Error('Falta el id del build');
      if (!/^[A-Za-z0-9-]{1,64}$/.test(buildId)) throw new Error('El id del build no es válido');
      cmd = cmd.replaceAll('{buildId}', buildId);
    }
    const dir = path.join(config.dataDir, 'artifacts', task.id);
    await fs.mkdir(dir, { recursive: true });
    const logPath = path.join(dir, `${job.kind}-${job.id}.log`);
    const wt = await workspaces.createDetached(rproject, `_release-${task.id}-${job.id}`, commit);
    try {
      const r = await shAbortable(cmd, path.join(wt, rc.cwd), {
        timeoutMs: (rc.timeoutMinutes ?? 90) * 60_000, signal: ac.signal, env: this.d.env ?? process.env,
      });
      await fs.writeFile(logPath, `$ ${cmd}\n\n${r.stdout}\n${r.stderr}`);
      store.addArtifact(task.id, 'file', logPath, `Log del ${LABEL[job.kind]} #${job.id}`);
      const meta = job.kind === 'build' ? parseBuildJson(r.stdout) : {};
      if (r.code === 130 && this.closing) {
        store.finishJob(job.id, 'interrupted', { outputPath: logPath });
        this.note(task.id, interruptedNote(job.kind, 'cierre'));
        return;
      }
      if (r.code === 0 && (job.kind !== 'build' || meta.buildId)) {
        store.finishJob(job.id, 'ok', { meta, outputPath: logPath });
        if (job.kind === 'build') {
          this.note(task.id, `Build terminado${meta.url ? `: ${meta.url}` : ` (${meta.buildId})`}.`);
          if (task.release === 'build_submit') {
            store.addApproval(task.id, 'publish', 'pending');
            this.note(task.id, 'Envío a App Store pendiente de tu aprobación.');
          }
        } else {
          this.note(task.id, 'Enviado a App Store Connect.');
        }
        return;
      }
      store.finishJob(job.id, 'failed', { meta, outputPath: logPath });
      const why = r.code === 130 ? 'parado por el usuario' : r.code === 124 ? 'tiempo agotado' : `${r.stderr || r.stdout}`.trim().slice(-600);
      this.note(task.id, `El ${LABEL[job.kind]} falló (${why}). Pulsa Reintentar para volver a lanzarlo.`);
    } finally {
      await workspaces.removeWorktree(rproject, wt).catch(() => {});
    }
  }
}
