import type { ConfigGeneralView, ConfigProjectView, GeneralUpdateBody, ProjectUpdateBody } from '../server/api-config';
import { positive } from './profile-form';

/** Lógica pura de los formularios de Proyecto y Generales (sin React). */

/** Sí / no / el valor por defecto de Faro (se quita del panel). */
export type Tri = 'default' | 'on' | 'off';
const triOf = (v: boolean | null | undefined): Tri => (v == null ? 'default' : v ? 'on' : 'off');
const boolOf = (t: Tri): boolean | null => (t === 'default' ? null : t === 'on');
const orNull = (s: string) => s.trim() || null;
const intOrNull = (s: string) => { const n = Number(s.trim()); return Number.isInteger(n) && n > 0 ? n : null; };

// --- Proyecto ---

export const METRIC_IDS = ['revenuecatProjectId', 'posthogHost', 'posthogProjectId', 'ascAppId', 'ascVendorNumber'] as const;
export interface ProjectFormState {
  baseBranch: string; ci: Tri; prs: Tri; ciProfile: string; backlogFile: string; contextWindow: string;
  ids: Record<typeof METRIC_IDS[number], string>; funnel: string;
}
type ProjectFields = Pick<ConfigProjectView, 'baseBranch' | 'github' | 'backlogFile' | 'contextWindow' | 'metrics'>;

export function formFromProject(p: ProjectFields): ProjectFormState {
  const m = p.metrics;
  return {
    baseBranch: p.baseBranch, ci: triOf(p.github?.ci), prs: triOf(p.github?.prs), ciProfile: p.github?.ciProfile ?? '',
    backlogFile: p.backlogFile ?? '', contextWindow: p.contextWindow == null ? '' : String(p.contextWindow),
    ids: Object.fromEntries(METRIC_IDS.map((k) => [k, m?.[k] ?? ''])) as ProjectFormState['ids'],
    funnel: m?.posthogFunnel ? JSON.stringify(m.posthogFunnel, null, 2) : '',
  };
}

export function projectToBody(f: ProjectFormState): { ok: true; body: Required<ProjectUpdateBody> } | { ok: false; error: string } {
  if (!f.baseBranch.trim()) return { ok: false, error: 'Falta la rama base' };
  let contextWindow: number | null = null;
  if (f.contextWindow.trim()) {
    contextWindow = intOrNull(f.contextWindow);
    if (contextWindow === null) return { ok: false, error: 'La ventana de contexto debe ser un entero mayor que 0' };
  }
  let posthogFunnel: NonNullable<ProjectUpdateBody['metrics']>['posthogFunnel'] = null;
  if (f.funnel.trim()) {
    try { posthogFunnel = JSON.parse(f.funnel); } catch { return { ok: false, error: 'El embudo no es un JSON válido' }; }
    if (!posthogFunnel || typeof posthogFunnel !== 'object' || Array.isArray(posthogFunnel)) return { ok: false, error: 'El embudo debe ser un objeto con «steps»' };
  }
  const ids = Object.fromEntries(METRIC_IDS.map((k) => [k, orNull(f.ids[k])])) as Record<typeof METRIC_IDS[number], string | null>;
  const github = { ci: boolOf(f.ci), prs: boolOf(f.prs), ciProfile: orNull(f.ciProfile) };
  const noMetrics = !posthogFunnel && Object.values(ids).every((v) => v === null);
  return {
    ok: true,
    body: {
      baseBranch: f.baseBranch.trim(),
      github: Object.values(github).every((v) => v === null) ? null : github,
      backlogFile: orNull(f.backlogFile), contextWindow,
      metrics: noMetrics ? null : { ...ids, posthogFunnel },
    },
  };
}

export function projectSame(a: ProjectFormState, b: ProjectFormState): boolean {
  return a.baseBranch.trim() === b.baseBranch.trim() && a.ci === b.ci && a.prs === b.prs && a.ciProfile.trim() === b.ciProfile.trim()
    && a.backlogFile.trim() === b.backlogFile.trim() && a.contextWindow.trim() === b.contextWindow.trim()
    && a.funnel.trim() === b.funnel.trim() && METRIC_IDS.every((k) => a.ids[k].trim() === b.ids[k].trim());
}

// --- Generales ---

export interface GeneralFormState {
  title: string; maxConcurrent: string; coordinatorProfile: string; enabled: Tri; maxWait: string; maxUsageWait: string;
}
type GeneralFields = Pick<ConfigGeneralView, 'title' | 'maxConcurrentRuns' | 'coordinatorProfile' | 'retryWatchdog'>;

const minutes = (ms: number | undefined) => (ms == null ? '' : String(ms / 60000).replace('.', ','));
/** Minutos (admite coma) → ms; null si no es un número de 0 en adelante. */
const toMs = (s: string): number | null => {
  const n = Number(s.trim().replace(',', '.'));
  return s.trim() && Number.isFinite(n) && n >= 0 ? Math.round(n * 60000) : null;
};

export function formFromGeneral(g: GeneralFields): GeneralFormState {
  const w = g.retryWatchdog;
  return {
    title: g.title, maxConcurrent: String(g.maxConcurrentRuns), coordinatorProfile: g.coordinatorProfile,
    enabled: triOf(w?.enabled), maxWait: minutes(w?.maxWaitMs), maxUsageWait: minutes(w?.maxUsageLimitWaitMs),
  };
}

export function generalToBody(f: GeneralFormState): { ok: true; body: Required<GeneralUpdateBody> } | { ok: false; error: string } {
  const maxConcurrentRuns = intOrNull(f.maxConcurrent);
  if (maxConcurrentRuns === null) return { ok: false, error: 'Las ejecuciones simultáneas deben ser un entero mayor que 0' };
  let maxWaitMs: number | null = null;
  let maxUsageLimitWaitMs: number | null = null;
  if (f.maxWait.trim() && (maxWaitMs = toMs(f.maxWait)) === null) return { ok: false, error: 'La espera máxima debe ser un número de minutos (0 o más)' };
  if (f.maxUsageWait.trim() && (maxUsageLimitWaitMs = toMs(f.maxUsageWait)) === null) return { ok: false, error: 'La espera por límite de uso debe ser un número de minutos (0 o más)' };
  const enabled = boolOf(f.enabled);
  return {
    ok: true,
    body: {
      title: orNull(f.title), maxConcurrentRuns, coordinatorProfile: orNull(f.coordinatorProfile),
      retryWatchdog: enabled === null && maxWaitMs === null && maxUsageLimitWaitMs === null ? null : { enabled, maxWaitMs, maxUsageLimitWaitMs },
    },
  };
}

export function generalSame(a: GeneralFormState, b: GeneralFormState): boolean {
  return a.title.trim() === b.title.trim() && a.maxConcurrent.trim() === b.maxConcurrent.trim() && a.coordinatorProfile === b.coordinatorProfile
    && a.enabled === b.enabled && a.maxWait.trim() === b.maxWait.trim() && a.maxUsageWait.trim() === b.maxUsageWait.trim();
}
