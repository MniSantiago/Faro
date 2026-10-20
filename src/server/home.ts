import { formatValue, STATE_ES, type ValueFormat } from '../shared/format';
import { elapsed, inboxSections } from '../shared/inbox';
import { getProject } from './config';
import { CONVERSION_KEY } from './metrics/posthog';
import { buildCards } from './metrics/summary';
import type { SourceId } from './metrics/types';
import type { Plan, PlanState } from './plan';
import type { Store } from './store';
import type { FaroConfig, ProjectConfig, RunOutcome } from './types';

export type HomeMetric = 'descargas' | 'conversion' | 'mrr' | 'gasto';

export interface HomeTile {
  metric: HomeMetric; label: string; value: number | null; format: ValueFormat;
  /** Variación frente a la semana anterior, en %; null si no hay referencia. */
  deltaPct: number | null;
  /** Valores diarios de los últimos 30 días, del más antiguo al más reciente (sin los días sin dato). */
  spark: number[];
  configured: boolean;
  /** Subir es bueno (verde) salvo en el gasto. */
  upIsGood: boolean;
}

export interface HealthLine { id: 'ci' | 'build' | 'store' | 'prs' | 'routines'; label: string; detail: string; tone: 'ok' | 'warn' | 'bad' }

export interface HomeView {
  headline: { text: string; detail: string; needCount: number };
  tiles: HomeTile[];
  health: HealthLine[];
  week: { label: string; value: string }[];
}

export interface SeriesView {
  metric: HomeMetric; days: number;
  points: { day: string; value: number | null }[];
  current: number | null; deltaPct: number | null;
  breakdown: { label: string; value: number }[];
  note: string | null;
}

export interface HomeDeps { store: Store; config: FaroConfig; plan?: Pick<Plan, 'state'> }

const METRICS: HomeMetric[] = ['descargas', 'conversion', 'mrr', 'gasto'];
const FORMAT: Record<HomeMetric, ValueFormat> = { descargas: 'int', conversion: 'percent', mrr: 'money', gasto: 'money' };
const SPARK_DAYS = 30;
const TOP = 10;

const pad = (n: number) => String(n).padStart(2, '0');
/** Día local `AAAA-MM-DD`. */
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Las 00:00 locales de hace `back` días. */
const dayStart = (now: Date, back: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
/** Los `n` días locales que acaban hoy, del más antiguo al más reciente. */
const lastDays = (now: Date, n: number) => Array.from({ length: n }, (_, i) => localDay(dayStart(now, n - 1 - i)));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pctChange = (cur: number, before: number) => (before > 0 ? ((cur - before) / before) * 100 : null);
const money = (usd: number) => formatValue(usd, 'money');

/** Titular de la home por reglas, en orden de prioridad (ver spec «Home»). */
export function headline(i: { ci: 'success' | 'failure' | 'pending' | null; need: number; unshipped: number; buildInStore: boolean; working: number }): { text: string; detail: string } {
  const text = i.ci === 'failure' ? 'El CI de main está en rojo'
    : i.need > 0 ? (i.need === 1 ? '1 cosa te espera' : `${i.need} cosas te esperan`)
    : i.unshipped > 0 && i.buildInStore ? 'Hay cambios esperando el próximo build'
    : 'Todo en orden';
  const detail = [
    i.ci ? { success: 'CI en verde', failure: 'CI en rojo', pending: 'CI en curso' }[i.ci] : null,
    i.working > 0 ? plural(i.working, 'agente trabajando', 'agentes trabajando') : null,
    i.need > 0 ? (i.need === 1 ? '1 tarea te espera' : `${i.need} tareas te esperan`) : null,
  ].filter(Boolean).join(' · ');
  return { text, detail };
}

function configured(p: ProjectConfig, metric: HomeMetric): boolean {
  const m = p.metrics;
  switch (metric) {
    case 'descargas': return !!(m?.ascAppId && m.ascVendorNumber);
    case 'conversion': return !!(m?.posthogFunnel?.conversion && m.posthogHost && m.posthogProjectId);
    case 'mrr': return !!m?.revenuecatProjectId;
    case 'gasto': return true;
  }
}

const SNAPSHOT: Partial<Record<HomeMetric, { source: SourceId; key: string }>> = {
  conversion: { source: 'posthog', key: CONVERSION_KEY },
  mrr: { source: 'revenuecat', key: 'mrr' },
};

/** Valor de cada día de `days` (o null si ese día no hay dato). */
function dailyValues(store: Store, p: ProjectConfig, metric: HomeMetric, days: string[], now: Date): (number | null)[] {
  const from = dayStart(now, days.length - 1).toISOString();
  const byDay = new Map<string, number | null>();
  if (metric === 'gasto') {
    for (const r of store.spendByDay(from)) byDay.set(r.day, r.usd);
    return days.map((d) => byDay.get(d) ?? 0);
  }
  if (metric === 'descargas') {
    // La fila centinela (`country ''`, 0 unidades) marca un día sin ventas: suma 0 y el día cuenta.
    for (const r of store.dailyDownloads(p.id, days[0], days.at(-1)!)) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.units);
  } else {
    const { source, key } = SNAPSHOT[metric]!;
    // En orden: la última foto de cada día pisa a las anteriores.
    for (const s of store.snapshotsSince(p.id, source, from)) byDay.set(localDay(new Date(s.takenAt)), num(s.data[key]));
  }
  return days.map((d) => byDay.get(d) ?? null);
}

/** Valor actual y variación frente a la semana anterior. */
function figure(store: Store, p: ProjectConfig, metric: HomeMetric, now: Date): { value: number | null; deltaPct: number | null } {
  if (metric === 'gasto') {
    const v = dailyValues(store, p, 'gasto', lastDays(now, 14), now) as number[];
    const cur = sum(v.slice(7));
    return { value: cur, deltaPct: pctChange(cur, sum(v.slice(0, 7))) };
  }
  if (metric === 'descargas') {
    // «Descargas 7 días» = suma de los 7 últimos días con informe; la referencia, los 7 días con informe anteriores.
    const byDay = new Map<string, number>();
    for (const r of store.dailyDownloads(p.id, localDay(dayStart(now, 90)), localDay(now))) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.units);
    const units = [...byDay].sort(([a], [b]) => (a < b ? 1 : -1)).map(([, u]) => u);
    if (!units.length) return { value: null, deltaPct: null };
    const cur = sum(units.slice(0, 7));
    return { value: cur, deltaPct: units.length >= 14 ? pctChange(cur, sum(units.slice(7, 14))) : null };
  }
  // Conversión y MRR: las tarjetas de Métricas (foto más reciente frente a la de hace ~7 días).
  const card = buildCards(store, p.id, now, p.metrics).find((c) => c.id === SNAPSHOT[metric]!.key);
  return { value: num(card?.value), deltaPct: card?.deltaPct ?? null };
}

function tile(store: Store, p: ProjectConfig, metric: HomeMetric, now: Date): HomeTile {
  const conf = configured(p, metric);
  const f = conf ? figure(store, p, metric, now) : { value: null, deltaPct: null };
  const spark = conf ? dailyValues(store, p, metric, lastDays(now, SPARK_DAYS), now).filter((v): v is number => v !== null) : [];
  const label = {
    descargas: 'Descargas 7 días',
    conversion: p.metrics?.posthogFunnel?.conversion?.label ?? 'Conversión',
    mrr: 'MRR',
    gasto: 'Gasto de Faro 7 días',
  }[metric];
  return { metric, label, value: f.value, format: FORMAT[metric], deltaPct: f.deltaPct, spark, configured: conf, upIsGood: metric !== 'gasto' };
}

const OUTCOME_ES: Record<RunOutcome, string> = {
  done: 'terminada', blocked: 'bloqueada', error: 'terminó con error', timeout: 'tiempo agotado', rate_limited: 'límite de uso',
  auth: 'sin sesión de Claude', interrupted: 'interrumpida', budget: 'tope de gasto alcanzado',
};
const REJECTED = new Set(['REJECTED', 'METADATA_REJECTED', 'DEVELOPER_REJECTED']);

/** Nombre de una rutina de cualquier proyecto (el gasto es de todo Faro). */
const routineName = (config: FaroConfig, id: string) =>
  config.projects.flatMap((p) => p.routines ?? []).find((r) => r.id === id)?.name ?? id;

/** Dónde está el último build según la foto de la App Store: a la venta, en revisión… o null si no se sabe. */
function buildWhere(store: Store, p: ProjectConfig, version: string): { text: string; inStore: boolean } | null {
  const as = p.metrics ? store.latestSnapshot(p.id, 'appstore', true) : null;
  if (!as) return null;
  if (as.data.version === version) return { text: 'En la tienda', inStore: true };
  const state = as.data.review_state;
  if (as.data.review_version === version && typeof state === 'string') return { text: STATE_ES[state] ?? state, inStore: false };
  return { text: 'Sin publicar', inStore: false };
}

function healthLines(d: HomeDeps, p: ProjectConfig, st: PlanState | null, now: Date, from7: string): HealthLine[] {
  const { store } = d;
  const lines: HealthLine[] = [];
  if (p.github?.ci && st?.github) {
    const ci = st.github.ci;
    lines.push(ci
      ? {
        id: 'ci', label: `CI de ${p.baseBranch}`,
        detail: `${{ success: 'En verde', failure: 'En rojo', pending: 'En curso' }[ci.state]} · hace ${elapsed(ci.at, now)}`,
        tone: ci.state === 'success' ? 'ok' : ci.state === 'failure' ? 'bad' : 'warn',
      }
      : { id: 'ci', label: `CI de ${p.baseBranch}`, detail: st.github.error ? 'GitHub no responde' : 'Sin ejecuciones', tone: 'warn' });
  }
  if (p.release && st) {
    const b = st.build;
    if (b) {
      const where = buildWhere(store, p, b.version);
      const parts = [`${b.version} (${b.buildNumber})`, where?.text, b.createdAt ? `hace ${elapsed(b.createdAt, now)}` : null];
      lines.push({ id: 'build', label: 'Último build', detail: parts.filter(Boolean).join(' · '), tone: st.buildError ? 'warn' : 'ok' });
    } else {
      lines.push({ id: 'build', label: 'Último build', detail: st.buildError ? 'EAS no responde' : 'Sin builds de producción', tone: 'warn' });
    }
  }
  if (p.metrics?.ascAppId) {
    const as = store.latestSnapshot(p.id, 'appstore', true);
    const version = as && typeof as.data.version === 'string' ? as.data.version : null;
    const state = as && typeof as.data.review_state === 'string' ? as.data.review_state : null;
    const review = as && typeof as.data.review_version === 'string' ? as.data.review_version : null;
    if (!version) lines.push({ id: 'store', label: 'En la tienda', detail: 'Sin datos todavía', tone: 'warn' });
    else {
      // La versión en revisión (u otro estado) se cuenta solo si no es la que ya está a la venta.
      const pending = state && review && review !== version ? ` · ${review}: ${STATE_ES[state] ?? state}` : '';
      lines.push({ id: 'store', label: 'En la tienda', detail: `Versión ${version}${pending}`, tone: state && REJECTED.has(state) ? 'bad' : 'ok' });
    }
  }
  if (p.github && st?.github) {
    const n = st.github.prs.length;
    lines.push({ id: 'prs', label: 'PR abiertos', detail: n === 0 ? 'Ninguno abierto' : plural(n, 'abierto', 'abiertos'), tone: 'ok' });
  }
  if (p.routines?.length) {
    // Una rutina falló si su última ejecución de los 7 días no terminó bien.
    const last = new Map<string, { outcome: RunOutcome; reason: string | null }>();
    for (const r of store.routineRuns(p.id, from7)) last.set(r.routineId, r);
    const failed = [...last].filter(([, r]) => r.outcome !== 'done').map(([id, r]) =>
      `${routineName(d.config, id)}: ${r.reason?.split('\n')[0].trim().slice(0, 80) || OUTCOME_ES[r.outcome] || r.outcome}`);
    lines.push(failed.length
      ? { id: 'routines', label: 'Rutinas', detail: failed.join('; '), tone: 'bad' }
      : { id: 'routines', label: 'Rutinas', detail: 'Ninguna falló en 7 días', tone: 'ok' });
  }
  return lines;
}

function weekLines(d: HomeDeps, p: ProjectConfig, now: Date, from7: string): HomeView['week'] {
  const { store } = d;
  const week: HomeView['week'] = [];
  const done = store.listTasks(['done']).filter((t) => t.projectId === p.id && t.kind === 'task' && t.updatedAt >= from7);
  week.push({ label: 'Tareas integradas', value: formatValue(done.length, 'int') });
  if (p.routines?.length) {
    const runs = store.routineRuns(p.id, from7);
    const ok = runs.filter((r) => r.outcome === 'done').length;
    week.push({ label: 'Rutinas', value: `${ok} ok · ${runs.length - ok} ${runs.length - ok === 1 ? 'fallida' : 'fallidas'}` });
  }
  week.push({ label: 'Ejecuciones de agentes', value: `${formatValue(store.runCount(from7), 'int')} · ${money(store.spend(now).week)}` });
  const ids = new Set((p.routines ?? []).map((r) => r.id));
  const top = store.spendBy('routine', from7).find((r) => ids.has(r.key));
  if (top) week.push({ label: 'Rutina más cara', value: `${routineName(d.config, top.key)} · ${money(top.usd)}` });
  if (p.aso) week.push({ label: 'Propuestas ASO sin decidir', value: formatValue(store.aso.listProposals(p.id, 'pending').length, 'int') });
  return week;
}

/** Todo lo que pinta la home de un proyecto. Sin `plan` (o si falla), la salud omite el CI, el build y los PR. */
export async function homeView(d: HomeDeps, projectId: string, now: Date): Promise<HomeView> {
  const p = getProject(d.config, projectId);
  let st: PlanState | null = null;
  if (d.plan) {
    try { st = await d.plan.state(projectId); } catch { st = null; }
  }
  // Los 7 días naturales incluido hoy, como el gasto de la barra lateral.
  const from7 = dayStart(now, 6).toISOString();
  const sections = inboxSections(d.store.listTasks().filter((t) => t.projectId === p.id), now);
  const ci = p.github?.ci ? st?.github?.ci?.state ?? null : null;
  // Sin foto de la App Store no se sabe dónde está el build: se da por enviado.
  const buildInStore = st?.build ? (buildWhere(d.store, p, st.build.version)?.inStore ?? true) : false;
  const h = headline({ ci, need: sections.need.length, unshipped: st?.unshipped.length ?? 0, buildInStore, working: sections.working.length });
  return {
    headline: { ...h, needCount: sections.need.length },
    tiles: METRICS.map((m) => tile(d.store, p, m, now)),
    health: healthLines(d, p, st, now, from7),
    week: weekLines(d, p, now, from7),
  };
}

/** Serie de una cifra para su vista de detalle: un punto por día local, del más antiguo a hoy. */
export function homeSeries(d: HomeDeps, projectId: string, metric: HomeMetric, days: 7 | 30 | 90, now: Date): SeriesView {
  const p = getProject(d.config, projectId);
  const dayList = lastDays(now, days);
  if (!configured(p, metric)) {
    return { metric, days, points: dayList.map((day) => ({ day, value: null })), current: null, deltaPct: null, breakdown: [], note: 'Sin configurar' };
  }
  const values = dailyValues(d.store, p, metric, dayList, now);
  const points = dayList.map((day, i) => ({ day, value: values[i] }));
  const f = figure(d.store, p, metric, now);
  const from = dayStart(now, days - 1).toISOString();
  let breakdown: SeriesView['breakdown'] = [];
  let note: string | null = null;

  if (metric === 'gasto') {
    breakdown = d.store.spendBy('routine', from).slice(0, TOP).map((r) => ({ label: routineName(d.config, r.key), value: r.usd }));
    // Todas las ejecuciones con coste tienen perfil: sumar por perfil da el total de ejecuciones.
    const runs = sum(d.store.spendBy('profile', from).map((r) => r.runs));
    const total = sum(values as number[]);
    note = runs > 0 ? `Equivalente API · coste medio por ejecución ${money(total / runs)}` : 'Equivalente API';
  } else {
    if (metric === 'descargas') {
      const byCountry = new Map<string, number>();
      for (const r of d.store.dailyDownloads(p.id, dayList[0], dayList.at(-1)!)) {
        if (r.country) byCountry.set(r.country, (byCountry.get(r.country) ?? 0) + r.units);
      }
      breakdown = [...byCountry].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TOP).map(([label, value]) => ({ label, value }));
    } else if (metric === 'conversion') {
      // El embudo de los últimos 7 días, como en Métricas.
      const snap = d.store.latestSnapshot(p.id, 'posthog', true);
      breakdown = (p.metrics?.posthogFunnel?.steps ?? []).flatMap((s) => {
        const v = num(snap?.data[s.event]);
        return v === null ? [] : [{ label: s.label, value: v }];
      });
    } else {
      const snap = d.store.latestSnapshot(p.id, 'revenuecat', true);
      breakdown = ([['mrr', 'MRR'], ['active_trials', 'Pruebas activas'], ['active_subscriptions', 'Suscripciones activas']] as const).flatMap(([k, label]) => {
        const v = num(snap?.data[k]);
        return v === null ? [] : [{ label, value: v }];
      });
    }
    const known = values.filter((v) => v !== null).length;
    if (known === 0) note = 'Todavía no hay datos';
    // Historial más corto que el periodo (el primer día no tiene dato): se dice cuántos días hay.
    else if (values[0] === null) note = `Hay datos de ${plural(known, 'día', 'días')}`;
  }
  return { metric, days, points, current: f.value, deltaPct: f.deltaPct, breakdown, note };
}
