import type { RoutineContext, RoutineCreateBody } from '../server/api-config';
import type { Level, RoutineConfig } from '../server/types';
import { cronFromSchedule, scheduleError, scheduleFromCron, type Schedule } from './schedule';

/** Lógica pura del formulario de rutinas (sin React): estado, cuerpo que se manda y si hay cambios. */
type RoutineFields = Pick<RoutineConfig, 'name' | 'title' | 'prompt' | 'cron' | 'profileId' | 'level' | 'context' | 'maxBudgetUsd'>;

/** Lo que edita el formulario. El tope de gasto va como texto para admitir la coma decimal. */
export interface RoutineFormState {
  name: string; title: string; schedule: Schedule; level: Level; profileId: string;
  budget: string; context: RoutineContext | null; enabled: boolean; prompt: string;
}

export const fmtBudget = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','));

export function formFromRoutine(r: RoutineFields, enabled: boolean): RoutineFormState {
  return {
    name: r.name, title: r.title, schedule: scheduleFromCron(r.cron ?? null), level: r.level, profileId: r.profileId,
    budget: fmtBudget(r.maxBudgetUsd), context: r.context ?? null, enabled, prompt: r.prompt,
  };
}

export function emptyForm(profileId: string): RoutineFormState {
  return { name: '', title: '', schedule: { kind: 'manual' }, level: 1, profileId, budget: '', context: null, enabled: false, prompt: '' };
}

/** El cuerpo que se manda (todos los campos editables; null = quitarlo) o el motivo por el que no se puede. */
export type Body = Omit<RoutineCreateBody, 'projectId'> & { cron: string | null; context: RoutineContext | null; maxBudgetUsd: number | null };
export function toBody(f: RoutineFormState): { ok: true; body: Body } | { ok: false; error: string } {
  if (!f.name.trim()) return { ok: false, error: 'Falta el nombre' };
  if (!f.title.trim()) return { ok: false, error: 'Falta el título de cada tarea' };
  if (!f.prompt.trim()) return { ok: false, error: 'Faltan las instrucciones' };
  if (!f.profileId) return { ok: false, error: 'Elige un perfil' };
  const se = scheduleError(f.schedule);
  if (se) return { ok: false, error: se };
  let maxBudgetUsd: number | null = null;
  if (f.budget.trim()) {
    const n = Number(f.budget.trim().replace(',', '.').replace(/\s*\$$/, ''));
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'El tope de gasto debe ser un número mayor que 0' };
    maxBudgetUsd = n;
  }
  return {
    ok: true,
    body: { name: f.name, title: f.title, prompt: f.prompt, cron: cronFromSchedule(f.schedule), profileId: f.profileId, level: f.level, context: f.context, maxBudgetUsd },
  };
}

/** Igualdad por lo que se guardaría (dos horarios iguales pueden ser objetos distintos). */
export function sameForm(a: RoutineFormState, b: RoutineFormState): boolean {
  return a.name === b.name && a.title === b.title && a.prompt === b.prompt && a.level === b.level && a.profileId === b.profileId
    && a.context === b.context && a.enabled === b.enabled && a.budget.trim() === b.budget.trim()
    && a.schedule.kind === b.schedule.kind && cronFromSchedule(a.schedule) === cronFromSchedule(b.schedule);
}

export const timeOf = (s: Schedule) => ('hour' in s ? { hour: s.hour, minute: s.minute } : { hour: 9, minute: 0 });

/** Cambia de forma de horario conservando la hora; a «Personalizado» pasa el cron actual para retocarlo. */
export function switchKind(s: Schedule, kind: Schedule['kind']): Schedule {
  // Desde «Personalizado», si el cron encaja en la forma elegida se recupera tal cual.
  const parsed = s.kind === 'custom' ? scheduleFromCron(s.cron.trim() || null) : null;
  if (parsed?.kind === kind) return parsed;
  const t = timeOf(s);
  switch (kind) {
    case 'manual': return { kind };
    case 'daily': return { kind, ...t };
    case 'weekly': return { kind, days: s.kind === 'weekly' ? s.days : [1], ...t };
    case 'monthly': return { kind, day: s.kind === 'monthly' ? s.day : 1, ...t };
    case 'custom': return { kind, cron: scheduleError(s) ? '0 9 * * *' : cronFromSchedule(s) ?? '0 9 * * *' };
  }
}

