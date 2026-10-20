import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { headline, homeSeries, homeView } from '../src/server/home';
import type { PlanState } from '../src/server/plan';
import { Store } from '../src/server/store';
import type { FaroConfig, ProjectConfig, RunOutcome } from '../src/server/types';
import { makeConfig, makeRepo, tmpDir } from './helpers';

// Mediodía local: los días locales no dependen de la zona horaria de quien ejecuta los tests.
const NOW = new Date(2026, 9, 20, 12, 0, 0);
const daysAgo = (n: number, h = 0) => new Date(NOW.getTime() - n * 86_400_000 + h * 3_600_000);
const REPO = makeRepo();

const METRICS = {
  ascAppId: '123', ascVendorNumber: '456', revenuecatProjectId: 'rc', posthogHost: 'https://ph', posthogProjectId: '1',
  posthogFunnel: {
    steps: [{ event: 'trial', label: 'Prueba' }, { event: 'paid', label: 'Pago' }],
    conversion: { from: 'trial', to: 'paid', label: 'Prueba → pago' },
  },
};

function setup(project: Partial<ProjectConfig> = {}) {
  const base = makeConfig(REPO);
  const config: FaroConfig = { ...base, projects: [{ ...base.projects[0], ...project }] };
  const store = new Store(path.join(tmpDir('faro-home-'), 'faro.db'));
  return { config, store, project: config.projects[0] };
}

let runSeq = 0;
/** Tarea con una ejecución terminada en la fecha dada (SQL directo: startRun usa la hora real). */
function addRun(store: Store, project: ProjectConfig, o: { at: Date; cost?: number | null; outcome?: RunOutcome; routineId?: string; profileId?: string; state?: string; reason?: string }) {
  const t = store.createTask(project, { title: `T${++runSeq}`, description: '', profileId: o.profileId ?? 'dev', level: 2, routineId: o.routineId ?? null });
  const iso = o.at.toISOString();
  store.db.prepare('UPDATE tasks SET state = ?, blocked_reason = ?, updated_at = ? WHERE id = ?').run(o.state ?? 'done', o.reason ?? null, iso, t.id);
  store.db.prepare('INSERT INTO runs (task_id, session_id, started_at, ended_at, outcome, cost_usd) VALUES (?, ?, ?, ?, ?, ?)')
    .run(t.id, 's', iso, iso, o.outcome ?? 'done', o.cost === undefined ? 1 : o.cost);
  return t;
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('headline', () => {
  const base = { ci: null, need: 0, unshipped: 0, buildInStore: false, working: 0 } as const;

  it('CI en rojo manda aunque haya cosas pendientes', () => {
    expect(headline({ ...base, ci: 'failure', need: 3 }).text).toBe('El CI de main está en rojo');
  });

  it('tareas que te esperan, en singular y plural', () => {
    expect(headline({ ...base, need: 2 }).text).toBe('2 cosas te esperan');
    expect(headline({ ...base, need: 1 }).text).toBe('1 cosa te espera');
  });

  it('cambios esperando el próximo build solo si el último build está en la tienda', () => {
    expect(headline({ ...base, unshipped: 2, buildInStore: true }).text).toBe('Hay cambios esperando el próximo build');
    expect(headline({ ...base, unshipped: 2, buildInStore: false }).text).toBe('Todo en orden');
    expect(headline(base).text).toBe('Todo en orden');
  });

  it('el detalle une CI, agentes trabajando y lo que espera, omitiendo lo que no aplica', () => {
    expect(headline({ ...base, ci: 'success', working: 2, need: 1 }).detail).toBe('CI en verde · 2 agentes trabajando · 1 tarea te espera');
    expect(headline({ ...base, ci: 'pending', working: 1 }).detail).toBe('CI en curso · 1 agente trabajando');
    expect(headline({ ...base, ci: 'failure', need: 3 }).detail).toBe('CI en rojo · 3 tareas te esperan');
    expect(headline(base).detail).toBe('');
  });
});

describe('homeView', () => {
  it('4 cifras en orden: descargas (suma de los 7 últimos días con informe), conversión, MRR y gasto', async () => {
    const { config, store, project } = setup({ metrics: METRICS });
    // Del 1 al 17 de octubre, tantas descargas como el día; el 18, día sin ventas (fila centinela).
    for (let d = 1; d <= 17; d++) store.upsertDailyDownloads('demo', `2026-10-${String(d).padStart(2, '0')}`, [{ country: 'ES', units: d - 1 }, { country: 'US', units: 1 }]);
    store.upsertDailyDownloads('demo', '2026-10-18', []);
    store.addSnapshot('demo', 'revenuecat', true, { mrr: 100 }, null, daysAgo(7));
    store.addSnapshot('demo', 'revenuecat', true, { mrr: 120 }, null, daysAgo(0, -1));
    store.addSnapshot('demo', 'posthog', true, { trial: 10, paid: 2, conversion: 0.2 }, null, daysAgo(0, -1));
    addRun(store, project, { at: daysAgo(1), cost: 2 });
    addRun(store, project, { at: daysAgo(3), cost: 1.5 });
    addRun(store, project, { at: daysAgo(9), cost: 7 });
    addRun(store, project, { at: daysAgo(20), cost: 50 }); // fuera de las dos semanas

    const v = await homeView({ store, config }, 'demo', NOW);
    expect(v.tiles.map((t) => t.metric)).toEqual(['descargas', 'conversion', 'mrr', 'gasto']);
    const [dl, conv, mrr, spend] = v.tiles;
    // 12..17 + 0 (centinela del 18) = 87; los 7 anteriores (5..11) = 56.
    expect(dl).toMatchObject({ label: 'Descargas 7 días', value: 87, format: 'int', configured: true, upIsGood: true });
    expect(dl.deltaPct).toBeCloseTo(((87 - 56) / 56) * 100);
    expect(dl.spark.length).toBeLessThanOrEqual(30);
    expect(dl.spark.at(-1)).toBe(0);
    expect(conv).toMatchObject({ label: 'Prueba → pago', value: 0.2, format: 'percent', configured: true });
    expect(mrr).toMatchObject({ label: 'MRR', value: 120, format: 'money', configured: true, deltaPct: 20 });
    expect(spend).toMatchObject({ metric: 'gasto', value: 3.5, format: 'money', configured: true, upIsGood: false });
    expect(spend.deltaPct).toBeCloseTo(((3.5 - 7) / 7) * 100);
    expect(spend.spark).toHaveLength(30);
    expect(spend.spark.at(-2)).toBe(2);
  });

  it('proyecto sin metrics, github ni release: 3 cifras sin configurar, gasto con valor y salud parcial', async () => {
    const { config, store, project } = setup();
    addRun(store, project, { at: daysAgo(1), cost: 0.25 });
    const plan = { state: async (): Promise<PlanState> => ({
      backlog: null, backlogError: null, build: null, buildFetchedAt: null, buildError: null, unshipped: [], unshippedError: null, github: null,
    }) };
    const v = await homeView({ store, config, plan }, 'demo', NOW);
    expect(v.tiles.slice(0, 3).map((t) => [t.configured, t.value])).toEqual([[false, null], [false, null], [false, null]]);
    expect(v.tiles[3]).toMatchObject({ metric: 'gasto', value: 0.25, configured: true });
    const ids = v.health.map((h) => h.id);
    for (const id of ['ci', 'build', 'store', 'prs'] as const) expect(ids).not.toContain(id);
    expect(v.headline.text).toBe('Todo en orden');
    expect(JSON.stringify(v)).not.toMatch(/NaN|Infinity/);
    expect(v.week.find((w) => w.label === 'Tareas integradas')?.value).toBe('1');
  });

  it('con GitHub y release: CI en rojo en el titular y en la salud; PR, build y cambios sin build', async () => {
    const { config, store } = setup({ github: { ci: true, prs: true }, release: { cwd: '.', build: 'b', submit: 's' } });
    const plan = { state: async (): Promise<PlanState> => ({
      backlog: null, backlogError: null, buildFetchedAt: null, buildError: null, unshippedError: null,
      build: { version: '1.2.0', buildNumber: '34', commit: 'abc', createdAt: daysAgo(2).toISOString() },
      unshipped: [{ taskId: null, title: 'x', commits: 1, lastAt: '', touchesApp: true, state: null, tested: false }],
      github: { ci: { sha: 'abc', state: 'failure', url: 'u', workflows: ['ci'], at: daysAgo(0, -2).toISOString() }, prs: [{ number: 1, title: 'p', url: 'u', headRefName: 'h', isDraft: false }], error: null },
    }) };
    const v = await homeView({ store, config, plan }, 'demo', NOW);
    expect(v.headline.text).toBe('El CI de main está en rojo');
    const by = Object.fromEntries(v.health.map((h) => [h.id, h]));
    expect(by.ci).toMatchObject({ tone: 'bad' });
    expect(by.ci.detail).toContain('2 h');
    expect(by.prs).toMatchObject({ detail: '1 abierto' });
    expect(by.build.detail).toContain('1.2.0 (34)');
  });

  it('si plan.state falla, la salud omite sus líneas y la home carga', async () => {
    const { config, store } = setup({ github: { ci: true }, release: { cwd: '.', build: 'b', submit: 's' } });
    const v = await homeView({ store, config, plan: { state: async () => { throw new Error('EAS caído'); } } }, 'demo', NOW);
    expect(v.health.map((h) => h.id)).not.toContain('ci');
    expect(v.health.map((h) => h.id)).not.toContain('build');
    expect(v.tiles).toHaveLength(4);
  });

  it('versión en la tienda solo si el proyecto tiene métricas', async () => {
    const { config, store } = setup({ metrics: { ascAppId: '123' } });
    store.addSnapshot('demo', 'appstore', true, { version: '1.1.0', review_state: 'READY_FOR_SALE', review_version: '1.1.0' }, null, daysAgo(0, -1));
    const v = await homeView({ store, config }, 'demo', NOW);
    expect(v.health.find((h) => h.id === 'store')).toMatchObject({ tone: 'ok' });
    expect(v.health.find((h) => h.id === 'store')?.detail).toContain('1.1.0');
  });

  it('rutina cuya última ejecución de los 7 días falló: línea de rutinas en rojo con el motivo corto', async () => {
    const routines = [
      { id: 'informe', name: 'Informe semanal', profileId: 'dev', level: 1 as const, title: 'Informe', prompt: 'x' },
      { id: 'limpieza', name: 'Limpieza', profileId: 'dev', level: 1 as const, title: 'Limpieza', prompt: 'x' },
    ];
    const { config, store, project } = setup({ routines });
    addRun(store, project, { at: daysAgo(3), routineId: 'informe' });
    addRun(store, project, { at: daysAgo(1), routineId: 'informe', outcome: 'error', state: 'blocked', reason: 'El agente terminó con error\nmás detalle' });
    addRun(store, project, { at: daysAgo(2), routineId: 'limpieza', outcome: 'budget', state: 'blocked' });
    addRun(store, project, { at: daysAgo(0, -1), routineId: 'limpieza' }); // la última fue bien
    const v = await homeView({ store, config }, 'demo', NOW);
    const line = v.health.find((h) => h.id === 'routines');
    expect(line).toMatchObject({ tone: 'bad' });
    expect(line?.detail).toBe('Informe semanal: El agente terminó con error');
    expect(v.week.find((w) => w.label === 'Rutinas')?.value).toBe('2 ok · 2 fallidas');
    expect(v.headline.needCount).toBe(2);
  });

  it('rutinas sin fallos: línea en verde', async () => {
    const { config, store, project } = setup({ routines: [{ id: 'informe', name: 'Informe', profileId: 'dev', level: 1, title: 'I', prompt: 'x' }] });
    addRun(store, project, { at: daysAgo(1), routineId: 'informe' });
    addRun(store, project, { at: daysAgo(9), routineId: 'informe', outcome: 'error' }); // fuera de los 7 días
    const v = await homeView({ store, config }, 'demo', NOW);
    expect(v.health.find((h) => h.id === 'routines')?.tone).toBe('ok');
  });
});

describe('homeSeries', () => {
  it('una muestra por día (la última foto del día)', () => {
    const { config, store } = setup({ metrics: METRICS });
    store.addSnapshot('demo', 'revenuecat', true, { mrr: 90, active_trials: 3, active_subscriptions: 9 }, null, daysAgo(2, -3));
    store.addSnapshot('demo', 'revenuecat', true, { mrr: 100 }, null, daysAgo(1, -3));
    store.addSnapshot('demo', 'revenuecat', true, { mrr: 110, active_trials: 4, active_subscriptions: 11 }, null, daysAgo(1, -1));
    store.addSnapshot('demo', 'revenuecat', false, { mrr: 999 }, 'falló', daysAgo(0, -1));
    const s = homeSeries({ store, config }, 'demo', 'mrr', 7, NOW);
    expect(s.points).toHaveLength(7);
    expect(s.points.at(-1)).toEqual({ day: localDay(NOW), value: null });
    expect(s.points.at(-2)).toEqual({ day: localDay(daysAgo(1)), value: 110 });
    expect(s.points.at(-3)?.value).toBe(90);
    expect(s.points[0].value).toBeNull();
    expect(s.current).toBe(110);
    expect(s.breakdown).toEqual([{ label: 'MRR', value: 110 }, { label: 'Pruebas activas', value: 4 }, { label: 'Suscripciones activas', value: 11 }]);
  });

  it('descargas por día y desglose por país sin la fila centinela', () => {
    const { config, store } = setup({ metrics: METRICS });
    store.upsertDailyDownloads('demo', localDay(daysAgo(3)), [{ country: 'ES', units: 5 }, { country: 'US', units: 2 }]);
    store.upsertDailyDownloads('demo', localDay(daysAgo(2)), []);
    const s = homeSeries({ store, config }, 'demo', 'descargas', 7, NOW);
    expect(s.points.map((p) => p.value)).toEqual([null, null, null, 7, 0, null, null]);
    expect(s.breakdown).toEqual([{ label: 'ES', value: 5 }, { label: 'US', value: 2 }]);
  });

  it('gasto: por día y desglose por rutina (las 10 más caras)', () => {
    const routines = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, name: `Rutina ${i}`, profileId: 'dev', level: 1 as const, title: 't', prompt: 'p' }));
    const { config, store, project } = setup({ routines });
    routines.forEach((r, i) => addRun(store, project, { at: daysAgo(1), cost: i + 1, routineId: r.id }));
    addRun(store, project, { at: daysAgo(2), cost: 0.5 }); // sin rutina
    const s = homeSeries({ store, config }, 'demo', 'gasto', 30, NOW);
    expect(s.points).toHaveLength(30);
    expect(s.points.at(-2)?.value).toBe(78);
    expect(s.points.at(-3)?.value).toBe(0.5);
    expect(s.points[0].value).toBe(0);
    expect(s.breakdown).toHaveLength(10);
    expect(s.breakdown[0]).toEqual({ label: 'Rutina 11', value: 12 });
    expect(s.breakdown.at(-1)).toEqual({ label: 'Rutina 2', value: 3 });
    expect(s.note).toMatch(/^Equivalente API · coste medio por ejecución /);
  });

  it('métrica sin configurar: puntos vacíos y nota', () => {
    const { config, store } = setup();
    const s = homeSeries({ store, config }, 'demo', 'conversion', 30, NOW);
    expect(s.points).toHaveLength(30);
    expect(s.points.every((p) => p.value === null)).toBe(true);
    expect(s.current).toBeNull();
    expect(s.note).toBe('Sin configurar');
  });
});

describe('Store: gasto', () => {
  it('spendByDay agrupa por día local y spendBy por rutina o perfil', () => {
    const { store, project } = setup();
    addRun(store, project, { at: daysAgo(1), cost: 1, routineId: 'a', profileId: 'dev' });
    addRun(store, project, { at: daysAgo(1, 1), cost: 2, routineId: 'a', profileId: 'otro' });
    addRun(store, project, { at: daysAgo(2), cost: null, routineId: 'b' });
    addRun(store, project, { at: daysAgo(30), cost: 9, routineId: 'a' });
    const from = daysAgo(7).toISOString();
    expect(store.spendByDay(from)).toEqual([{ day: localDay(daysAgo(1)), usd: 3 }]);
    expect(store.spendBy('routine', from)).toEqual([{ key: 'a', usd: 3, runs: 2 }]);
    expect(store.spendBy('profile', from)).toEqual([{ key: 'otro', usd: 2, runs: 1 }, { key: 'dev', usd: 1, runs: 1 }]);
  });
});
