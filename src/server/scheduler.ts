import { Cron } from 'croner';
import type { ReviewActions } from './actions';
import { ActionError } from './errors';
import { asoContext } from './aso/context';
import type { CurrentFicha } from './aso/ficha';
import { metricsContext } from './metrics/summary';
import type { Plan } from './plan';
import { statusContext } from './status';
import { NotFoundError, type Store } from './store';
import type { FaroConfig, Level, ProjectConfig, RoutineConfig, RoutineRow, Task } from './types';

const MISSED_LIMIT_MS = 12 * 3600_000;
const OPEN_STATES = new Set(['draft', 'queued', 'working', 'blocked']);

export function nextRun(cron: string, after: Date): Date | null {
  return new Cron(cron, { paused: true }).nextRun(after);
}

const pad = (n: number) => String(n).padStart(2, '0');

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${pad(week)}`;
}

export function expandTemplate(s: string, d: Date): string {
  const fecha = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return s.replaceAll('{fecha}', fecha).replaceAll('{semana}', isoWeek(d));
}

export interface RoutineView extends RoutineRow {
  name: string; profileId: string; level: Level; draft: boolean; recent: Task[];
}

interface Deps {
  store: Store;
  config: FaroConfig;
  actions: Pick<ReviewActions, 'createTask'>;
  /** Para `context: 'estado'`: pendientes, builds, CI y PR de la página «Plan». */
  plan?: Pick<Plan, 'state'>;
  /** Para `context: 'aso'`: ficha vigente de cada tienda (red); si falta o falla, el contexto lo dice. */
  asoFichas?: (project: ProjectConfig) => Promise<Record<string, CurrentFicha>>;
  now?: () => Date;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private d: Deps) {}

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  private all(): { project: ProjectConfig; r: RoutineConfig }[] {
    return this.d.config.projects.flatMap((project) => (project.routines ?? []).map((r) => ({ project, r })));
  }

  private find(id: string): { project: ProjectConfig; r: RoutineConfig } {
    const x = this.all().find((y) => y.r.id === id);
    if (!x) throw new NotFoundError(`La rutina ${id} no existe`);
    return x;
  }

  sync(): void {
    const now = this.now();
    for (const { project, r } of this.all()) {
      this.d.store.upsertRoutine(r.id, project.id, r.cron ?? null, r.cron ? nextRun(r.cron, now)?.toISOString() ?? null : null);
    }
    this.d.store.deleteRoutinesExcept(this.all().map((x) => x.r.id));
  }

  private openTask(routineId: string): Task | null {
    return this.d.store.listTasksByRoutine(routineId, 20).find((t) => OPEN_STATES.has(t.state)) ?? null;
  }

  private async launch(project: ProjectConfig, r: RoutineConfig, at: Date): Promise<Task> {
    let description = expandTemplate(r.prompt, at);
    if (r.context === 'metrics') {
      description += `\n\nDatos de las últimas fotos de métricas (Faro):\n${metricsContext(this.d.store, project.id, at, project.metrics) ?? '(no hay fotos de métricas todavía)'}`;
    }
    if (r.context === 'estado') {
      let plan = null;
      let planError: string | null = this.d.plan ? null : 'Faro no tiene la página Plan';
      try { plan = (await this.d.plan?.state(project.id)) ?? null; } catch (e) { planError = (e as Error).message; }
      description += `\n\nEstado del proyecto según Faro (${at.toISOString()}):\n\n${statusContext(this.d.store, project.id, plan, planError, at)}`;
    }
    if (r.context === 'aso') {
      let fichas: Record<string, CurrentFicha> = {};
      try { fichas = (await this.d.asoFichas?.(project)) ?? {}; } catch { /* sin ficha: el contexto lo dice */ }
      description += `\n\nContexto ASO de Faro (${at.toISOString()}):\n\n${asoContext(this.d.store, project, fichas, at)}`;
    }
    return this.d.actions.createTask({
      projectId: project.id, title: expandTemplate(r.title, at), description,
      profileId: r.profileId, level: r.level, draft: r.draft ?? false, routineId: r.id, release: r.release ?? 'none', repos: r.repos,
    });
  }

  async tick(): Promise<void> {
    const now = this.now();
    await Promise.all(this.all().map(({ project, r }) => this.tickOne(project, r, now).catch((e) => {
      console.error(`[faro] fallo en la rutina ${r.id}`, e);
    })));
  }

  private async tickOne(project: ProjectConfig, r: RoutineConfig, now: Date): Promise<void> {
    const row = this.d.store.getRoutine(r.id);
    if (!row?.enabled || !r.cron || !row.nextRunAt) return;
    const due = new Date(row.nextRunAt);
    if (due > now) return;
    const nextRunAt = nextRun(r.cron, now)?.toISOString() ?? null;
    if (now.getTime() - due.getTime() > MISSED_LIMIT_MS) {
      this.d.store.updateRoutine(r.id, { nextRunAt, lastSkipReason: 'Perdida: el Mac estaba apagado o dormido' });
      return;
    }
    const open = this.openTask(r.id);
    if (open) {
      this.d.store.updateRoutine(r.id, { nextRunAt, lastSkipReason: `La anterior sigue abierta (${open.id})` });
      return;
    }
    // La próxima fecha se guarda antes de esperar al contexto: así otro tick no la lanza dos veces.
    this.d.store.updateRoutine(r.id, { nextRunAt });
    try {
      await this.launch(project, r, now);
      this.d.store.updateRoutine(r.id, { lastRunAt: now.toISOString(), lastSkipReason: null });
    } catch (e) {
      this.d.store.updateRoutine(r.id, { lastSkipReason: `No se pudo crear la tarea: ${(e as Error).message}` });
    }
  }

  async runNow(id: string): Promise<Task> {
    const { project, r } = this.find(id);
    if (!this.d.store.getRoutine(id)) throw new NotFoundError(`La rutina ${id} no existe`);
    const open = this.openTask(id);
    if (open) throw new ActionError(`La anterior sigue abierta (${open.id})`);
    const now = this.now();
    const t = await this.launch(project, r, now);
    this.d.store.updateRoutine(id, { lastRunAt: now.toISOString(), lastSkipReason: null });
    return t;
  }

  toggle(id: string): RoutineRow {
    const { r } = this.find(id);
    const row = this.d.store.getRoutine(id);
    if (!row) throw new NotFoundError(`La rutina ${id} no existe`);
    const enabled = !row.enabled;
    // Al activar se cuenta desde ahora: no se dispara una ejecución vieja pendiente.
    const nextRunAt = enabled && r.cron ? nextRun(r.cron, this.now())?.toISOString() ?? null : row.nextRunAt;
    return this.d.store.updateRoutine(id, { enabled, nextRunAt });
  }

  list(projectId?: string): RoutineView[] {
    return this.all().filter(({ project }) => !projectId || project.id === projectId).flatMap(({ r }) => {
      const row = this.d.store.getRoutine(r.id);
      if (!row) return [];
      return [{ ...row, name: r.name, profileId: r.profileId, level: r.level, draft: r.draft ?? false, recent: this.d.store.listTasksByRoutine(r.id, 5) }];
    });
  }

  start(intervalMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => {
      this.tick().catch((e) => console.error('[faro] fallo del programador de rutinas', e));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
