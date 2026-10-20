import type { ProfileCreateBody } from '../server/api-config';
import type { Effort, Level, ProfileConfig } from '../server/types';
import { fmtBudget } from './routine-form';

/** Lógica pura del formulario de perfiles (sin React): estado, cuerpo que se manda y si hay cambios. */
type ProfileFields = Pick<ProfileConfig, 'name' | 'instructions' | 'defaultLevel' | 'model' | 'effort' | 'maxBudgetUsd' | 'timeoutMinutes'>;

/** Lo que edita el formulario. Los números van como texto para admitir la coma decimal. */
export interface ProfileFormState {
  name: string; instructions: string; level: Level; model: string; effort: Effort | ''; budget: string; timeout: string;
}

export function formFromProfile(p: ProfileFields): ProfileFormState {
  return {
    name: p.name, instructions: p.instructions, level: p.defaultLevel, model: p.model ?? '', effort: p.effort ?? '',
    budget: fmtBudget(p.maxBudgetUsd), timeout: String(p.timeoutMinutes).replace('.', ','),
  };
}

export const emptyProfileForm = (): ProfileFormState => ({ name: '', instructions: '', level: 1, model: '', effort: '', budget: '', timeout: '30' });

/** Número positivo desde un texto con coma o punto decimal; null si no lo es. */
export function positive(text: string): number | null {
  const n = Number(text.trim().replace(',', '.').replace(/\s*\$$/, ''));
  return text.trim() && Number.isFinite(n) && n > 0 ? n : null;
}

export type ProfileBody = Required<Omit<ProfileCreateBody, 'level'>>;
/** El cuerpo que se manda (todos los campos editables; null = quitarlo) o el motivo por el que no se puede. */
export function profileToBody(f: ProfileFormState): { ok: true; body: ProfileBody } | { ok: false; error: string } {
  if (!f.name.trim()) return { ok: false, error: 'Falta el nombre' };
  if (!f.instructions.trim()) return { ok: false, error: 'Faltan las instrucciones' };
  const timeoutMinutes = positive(f.timeout);
  if (timeoutMinutes === null) return { ok: false, error: 'El tiempo máximo debe ser un número de minutos mayor que 0' };
  let maxBudgetUsd: number | null = null;
  if (f.budget.trim()) {
    maxBudgetUsd = positive(f.budget);
    if (maxBudgetUsd === null) return { ok: false, error: 'El tope de gasto debe ser un número mayor que 0' };
  }
  return {
    ok: true,
    body: {
      name: f.name, instructions: f.instructions, defaultLevel: f.level, model: f.model.trim() || null, effort: f.effort || null,
      maxBudgetUsd, timeoutMinutes,
    },
  };
}

/** Igualdad por lo que se guardaría. */
export function profileSame(a: ProfileFormState, b: ProfileFormState): boolean {
  return a.name === b.name && a.instructions === b.instructions && a.level === b.level && a.model.trim() === b.model.trim()
    && a.effort === b.effort && a.budget.trim() === b.budget.trim() && a.timeout.trim() === b.timeout.trim();
}
