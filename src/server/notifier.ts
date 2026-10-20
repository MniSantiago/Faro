import type { Bus } from './bus';
import type { Push } from './push';
import type { Store } from './store';
import type { FaroConfig, FinalAction, QueueState, Task, TaskState } from './types';

const ACTION_LABEL: Record<FinalAction, string | null> = {
  push: null, eas: 'build de EAS', publish: 'publicar', merge: null,
};
const PAUSE_LABEL = { rate_limit: 'límite de uso', auth: 'sesión de Claude caducada', manual: 'manual' } as const;
/** Horas en revisión o bloqueada a partir de las que se avisa de que una tarea está parada. */
export const STALE_HOURS = 24;
const STALE_KEY = 'avisos.paradas';
const STALE_EVERY_MS = 30 * 60_000;

/** Escucha el bus y avisa por push de revisiones, preguntas, aprobaciones, pausas de la cola y tareas paradas. */
export class Notifier {
  private states = new Map<string, TaskState>();
  private approvals = new Set<number>();
  private pauseReason: string | null = null;
  /** Proyectos con cambios sin subir de los que ya se avisó: un solo aviso hasta que se suben. */
  private pushNotified = new Set<string>();

  constructor(private d: { store: Store; bus: Bus; push: Pick<Push, 'send'>; config?: Pick<FaroConfig, 'projects'>; queueState?: () => QueueState }) {}

  start(): () => void {
    const q = this.d.queueState?.();
    if (q?.paused) this.pauseReason = q.reason ?? 'manual';
    for (const t of this.d.store.listTasks()) {
      this.states.set(t.id, t.state);
      for (const a of this.markApprovals(t.id)) if (a.action === 'push') this.pushNotified.add(t.projectId);
    }
    const timer = setInterval(() => this.checkStale(new Date()), STALE_EVERY_MS);
    timer.unref?.();
    const off = this.d.bus.subscribe((m) => {
      if (m.type === 'task') this.onTask(m.task);
      else if (m.type === 'queue') this.onQueue(m.queue);
    });
    return () => { clearInterval(timer); off(); };
  }

  /**
   * Avisa una vez de cada tarea que lleva más de STALE_HOURS en revisión o bloqueada. Lo avisado se guarda
   * (id → updatedAt) para no repetirlo al reiniciar; si la tarea se mueve y vuelve a pararse, se avisa de nuevo.
   */
  checkStale(now: Date): void {
    const seen = this.d.store.getMeta<Record<string, string>>(STALE_KEY) ?? {};
    const next: Record<string, string> = {};
    for (const t of this.d.store.listTasks(['review', 'blocked'])) {
      if (t.kind !== 'task') continue;
      const hours = (now.getTime() - new Date(t.updatedAt).getTime()) / 3600_000;
      if (seen[t.id] === t.updatedAt) { next[t.id] = t.updatedAt; continue; }
      if (hours < STALE_HOURS) continue;
      next[t.id] = t.updatedAt;
      const what = t.state === 'review' ? 'en revisión' : 'bloqueada';
      this.notify(`${t.id} lleva ${Math.floor(hours / 24)} d ${what}`, t.title, `/#/tarea/${t.id}`);
    }
    this.d.store.setMeta(STALE_KEY, next);
  }

  private markApprovals(taskId: string): { id: number; action: FinalAction }[] {
    const fresh: { id: number; action: FinalAction }[] = [];
    for (const a of this.d.store.listApprovals(taskId)) {
      if (a.state !== 'pending' || this.approvals.has(a.id)) continue;
      this.approvals.add(a.id);
      fresh.push(a);
    }
    return fresh;
  }

  private notify(title: string, body: string, url: string): void {
    this.d.push.send({ title, body, url }).catch((e) => console.error('[faro] aviso push falló', e));
  }

  private onTask(task: Task): void {
    const prev = this.states.get(task.id);
    this.states.set(task.id, task.state);
    const url = `/#/tarea/${task.id}`;
    if (prev !== task.state) {
      if (task.state === 'review') this.notify(`${task.id} en revisión`, task.title, url);
      // Terminada sin pasar por revisión (se cerró o integró sola); si la aprobaste tú no hace falta aviso.
      else if (task.state === 'done' && prev === 'working') this.notify(`${task.id} terminada`, (task.summary || task.title).slice(0, 100), url);
      else if (task.state === 'done' && prev === 'pr') this.notify(`${task.id} integrada`, `PR fusionado · ${task.title}`.slice(0, 100), url);
      else if (task.state === 'blocked') this.notify(this.blockedTitle(task), task.questions?.[0]?.text || task.blockedReason || 'Necesita tu ayuda', url);
      else if (task.state === 'idle' && task.kind === 'chat' && prev !== undefined) {
        this.notify('El Coordinador ha respondido', (task.summary ?? '').slice(0, 100), url);
      }
    }
    for (const a of this.markApprovals(task.id)) {
      if (a.action === 'push') { this.onPushPending(task.projectId); continue; }
      const label = ACTION_LABEL[a.action];
      if (label) this.notify(`Aprobación pendiente: ${label}`, `${task.id} · ${task.title}`, url);
    }
    if (this.pushNotified.has(task.projectId) && this.d.store.listPendingApprovals(task.projectId, 'push').length === 0) {
      this.pushNotified.delete(task.projectId);
    }
  }

  /** Los push pendientes se agrupan: un aviso por proyecto, y se suben todos a la vez desde la bandeja. */
  private onPushPending(projectId: string): void {
    if (this.pushNotified.has(projectId)) return;
    this.pushNotified.add(projectId);
    const name = this.d.config?.projects.find((p) => p.id === projectId)?.name ?? projectId;
    this.notify(`Cambios sin subir en ${name}`, 'Súbelos todos de una vez desde la bandeja.', '/#/bandeja');
  }

  private blockedTitle(task: Task): string {
    if (!task.routineId) return `${task.id} necesita tu respuesta`;
    const routine = this.d.config?.projects.flatMap((p) => p.routines ?? []).find((r) => r.id === task.routineId);
    return `La rutina ${routine?.name ?? task.routineId} necesita ayuda`;
  }

  private onQueue(q: { paused: boolean; reason: keyof typeof PAUSE_LABEL | null }): void {
    if (!q.paused) { this.pauseReason = null; return; }
    const reason = q.reason ?? 'manual';
    if (reason === this.pauseReason) return;
    this.pauseReason = reason;
    this.notify(`Cola en pausa: ${PAUSE_LABEL[reason]}`, 'Las tareas esperan hasta que reanudes la cola.', '/#/bandeja');
  }
}
