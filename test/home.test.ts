import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { headline, homeSeries, homeView, shortReason } from '../src/server/home';
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
    expect(headline({ ...base, ci: 'success', working: 2, need: 1 }).detail).toBe('CI en verde · 2 agentes trabajando');
    expect(headline({ ...base, ci: 'pending', working: 1 }).detail).toBe('CI en curso · 1 agente trabajando');
    // Si el titular ya es «N cosas te esperan», el detalle no repite el recuento; con el CI en rojo el titular es otro y sí lo cuenta.
    expect(headline({ ...base, ci: 'failure', need: 3 }).detail).toBe('CI en rojo · 3 tareas te esperan');
    expect(headline({ ...base, need: 4 })).toEqual({ text: '4 cosas te esperan', detail: '' });
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

  it('CI en verde, cambios sin build y el último build en la tienda: «Hay cambios esperando el próximo build»', async () => {
    const { config, store } = setup({ github: { ci: true }, release: { cwd: '.', build: 'b', submit: 's' }, metrics: { ascAppId: '123' } });
    store.addSnapshot('demo', 'appstore', true, { version: '1.2.0', review_state: 'READY_FOR_SALE', review_version: '1.2.0' }, null, daysAgo(0, -1));
    const plan = { state: async (): Promise<PlanState> => ({
      backlog: null, backlogError: null, buildFetchedAt: null, buildError: null, unshippedError: null,
      build: { version: '1.2.0', buildNumber: '34', commit: 'abc', createdAt: daysAgo(5).toISOString() },
      unshipped: [{ taskId: null, title: 'x', commits: 1, lastAt: '', touchesApp: true, state: null, tested: false }],
      github: { ci: { sha: 'abc', state: 'success', url: 'u', workflows: ['ci'], at: daysAgo(0, -2).toISOString() }, prs: [], error: null },
    }) };
    const v = await homeView({ store, config, plan }, 'demo', NOW);
    expect(v.headline).toEqual({ text: 'Hay cambios esperando el próximo build', detail: 'CI en verde', needCount: 0 });
    expect(v.health.find((h) => h.id === 'build')?.detail).toContain('En la tienda');
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

  it('varias rutinas fallidas: «N rutinas fallaron» y la más reciente; todas en title', async () => {
    const routines = [
      { id: 'informe', name: 'Informe', profileId: 'dev', level: 1 as const, title: 'I', prompt: 'x' },
      { id: 'limpieza', name: 'Limpieza', profileId: 'dev', level: 1 as const, title: 'L', prompt: 'x' },
    ];
    const { config, store, project } = setup({ routines });
    addRun(store, project, { at: daysAgo(1), routineId: 'informe', outcome: 'error', state: 'blocked', reason: 'Se rompió. Detalle' });
    addRun(store, project, { at: daysAgo(3), routineId: 'limpieza', outcome: 'budget', state: 'blocked' });
    const line = (await homeView({ store, config }, 'demo', NOW)).health.find((h) => h.id === 'routines');
    expect(line?.detail).toBe('2 rutinas fallaron · la más reciente, Informe: Se rompió.');
    expect(line?.title).toContain('Limpieza: tope de gasto alcanzado');
    expect(line?.title).toContain('Informe: Se rompió. Detalle');
  });

  it('una sola rutina fallida: «nombre: motivo» recortado a la primera frase y 80 caracteres, con el texto entero en title', async () => {
    const { config, store, project } = setup({ routines: [{ id: 'informe', name: 'Informe', profileId: 'dev', level: 1, title: 'I', prompt: 'x' }] });
    const reason = 'No se pudo abrir el repositorio. Revisa la ruta configurada y vuelve a intentarlo desde el panel.';
    addRun(store, project, { at: daysAgo(1), routineId: 'informe', outcome: 'error', state: 'blocked', reason });
    const line = (await homeView({ store, config }, 'demo', NOW)).health.find((h) => h.id === 'routines');
    expect(line?.detail).toBe('Informe: No se pudo abrir el repositorio.');
    expect(line?.title).toBe(`Informe: ${reason}`);
  });

  it('rutinas sin fallos: línea en verde', async () => {
    const { config, store, project } = setup({ routines: [{ id: 'informe', name: 'Informe', profileId: 'dev', level: 1, title: 'I', prompt: 'x' }] });
    addRun(store, project, { at: daysAgo(1), routineId: 'informe' });
    addRun(store, project, { at: daysAgo(9), routineId: 'informe', outcome: 'error' }); // fuera de los 7 días
    const v = await homeView({ store, config }, 'demo', NOW);
    expect(v.health.find((h) => h.id === 'routines')?.tone).toBe('ok');
  });
});

describe('shortReason', () => {
  it('primera frase, 80 caracteres como mucho y «…» si se corta', () => {
    expect(shortReason('Falló el build. Más detalle')).toBe('Falló el build.');
    expect(shortReason('Primera línea\nsegunda')).toBe('Primera línea');
    expect(shortReason('sin punto final')).toBe('sin punto final');
    const long = 'palabra '.repeat(20).trim();
    const out = shortReason(long);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toBe(`${long.slice(0, 79).trimEnd()}…`);
  });
});

describe('homeSeries', () => {
  it('una muestra por día (la última foto del día con dato)', () => {
    const { config, store } = setup({ metrics: METRICS });
    store.addSnapshot('demo', 'revenuecat', true, { mrr: 90, active_trials: 3, active_subscriptions: 9 }, null, daysAgo(2, -3));
    store.addSnapshot('demo', 'revenuecat', true, { active_trials: 3 }, null, daysAgo(2, -1)); // sin MRR: no borra el 90
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
    expect(s.breakdowns).toEqual([{ title: 'Ahora', rows: [{ label: 'MRR', value: 110 }, { label: 'Pruebas activas', value: 4 }, { label: 'Suscripciones activas', value: 11 }] }]);
  });

  it('descargas por día y desglose por país sin la fila centinela', () => {
    const { config, store } = setup({ metrics: METRICS });
    store.upsertDailyDownloads('demo', localDay(daysAgo(3)), [{ country: 'ES', units: 5 }, { country: 'US', units: 2 }]);
    store.upsertDailyDownloads('demo', localDay(daysAgo(2)), []);
    const s = homeSeries({ store, config }, 'demo', 'descargas', 7, NOW);
    expect(s.points.map((p) => p.value)).toEqual([null, null, null, 7, 0, null, null]);
    expect(s.breakdowns).toEqual([{ title: 'Por país', rows: [{ label: 'ES', value: 5 }, { label: 'US', value: 2 }] }]);
  });

  it('gasto: por día, total del periodo y desgloses por rutina (las 10 más caras), por perfil y coste medio', () => {
    const routines = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, name: `Rutina ${i}`, profileId: 'dev', level: 1 as const, title: 't', prompt: 'p' }));
    const { config, store, project } = setup({ routines });
    routines.forEach((r, i) => addRun(store, project, { at: daysAgo(1), cost: i + 1, routineId: r.id }));
    addRun(store, project, { at: daysAgo(2), cost: 0.5, profileId: 'otro' }); // sin rutina
    addRun(store, project, { at: daysAgo(20), cost: 10 }); // dentro de 30 días, fuera de 7
    const s = homeSeries({ store, config }, 'demo', 'gasto', 30, NOW);
    expect(s.current).toBe(88.5);
    expect(homeSeries({ store, config }, 'demo', 'gasto', 7, NOW).current).toBe(78.5);
    expect(s.points).toHaveLength(30);
    expect(s.points.at(-2)?.value).toBe(78);
    expect(s.points.at(-3)?.value).toBe(0.5);
    expect(s.points[0].value).toBe(0);
    expect(s.breakdowns.map((b) => b.title)).toEqual(['Por rutina', 'Por perfil', 'Resumen']);
    const [byRoutine, byProfile, summary] = s.breakdowns;
    expect(byRoutine.rows).toHaveLength(10);
    expect(byRoutine.rows[0]).toEqual({ label: 'Rutina 11', value: 12 });
    expect(byRoutine.rows.at(-1)).toEqual({ label: 'Rutina 2', value: 3 });
    expect(byProfile.rows).toEqual([{ label: 'Dev', value: 88 }, { label: 'otro', value: 0.5 }]);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0].label).toBe('Coste medio por ejecución');
    expect(summary.rows[0].value).toBeCloseTo(88.5 / 14);
    expect(s.note).toBe('Equivalente API');
  });

  it('gasto: las llamadas del asistente salen como «Asistente» y no entran en el coste medio por ejecución', () => {
    const { config, store, project } = setup({});
    addRun(store, project, { at: daysAgo(1), cost: 2 });
    store.db.prepare('INSERT INTO assistant_calls (at, cost_usd, ok) VALUES (?, ?, 1)').run(daysAgo(1).toISOString(), 1);
    const s = homeSeries({ store, config }, 'demo', 'gasto', 7, NOW);
    expect(s.current).toBe(3);
    expect(s.breakdowns[1].rows).toEqual([{ label: 'Dev', value: 2 }, { label: 'Asistente', value: 1 }]);
    expect(s.breakdowns[2].rows).toEqual([{ label: 'Coste medio por ejecución', value: 2 }]);
  });

  it('conversión: sin desgloses (el embudo se pinta aparte)', () => {
    const { config, store } = setup({ metrics: METRICS });
    store.addSnapshot('demo', 'posthog', true, { trial: 10, paid: 2, conversion: 0.2 }, null, daysAgo(0, -1));
    const s = homeSeries({ store, config }, 'demo', 'conversion', 7, NOW);
    expect(s.current).toBe(0.2);
    expect(s.breakdowns).toEqual([]);
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

describe('homeView con un plan lento', () => {
  const state = (): PlanState => ({
    backlog: null, backlogError: null, buildFetchedAt: null, buildError: null, unshippedError: null,
    build: { version: '1.2.0', buildNumber: '34', commit: 'abc', createdAt: daysAgo(2).toISOString() },
    unshipped: [], github: { ci: { sha: 'abc', state: 'success', url: 'u', workflows: ['ci'], at: daysAgo(0, -2).toISOString() }, prs: [], error: null },
  });

  it('si plan.state tarda más que el límite, la home sale sin sus líneas y con pending; la promesa sigue y la siguiente llamada la usa', async () => {
    const { config, store } = setup({ github: { ci: true }, release: { cwd: '.', build: 'b', submit: 's' } });
    let warm: PlanState | null = null;
    let calls = 0;
    const plan = { state: async (): Promise<PlanState> => {
      calls++;
      if (warm) return warm;
      await new Promise((r) => setTimeout(r, 120));
      return (warm = state());
    } };
    const t0 = Date.now();
    const slow = await homeView({ store, config, plan, planTimeoutMs: 20 }, 'demo', NOW);
    expect(Date.now() - t0).toBeLessThan(110);
    expect(slow.pending).toBe(true);
    expect(slow.health.map((h) => h.id)).not.toContain('ci');
    expect(slow.tiles).toHaveLength(4);
    await new Promise((r) => setTimeout(r, 150));
    expect(warm).not.toBeNull();
    const fast = await homeView({ store, config, plan, planTimeoutMs: 20 }, 'demo', NOW);
    expect(fast.pending).toBe(false);
    expect(fast.health.map((h) => h.id)).toContain('ci');
    expect(calls).toBe(2);
  });

  it('si la promesa lenta acaba rechazada tras el límite, no queda un rechazo sin atender', async () => {
    const { config, store } = setup();
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', on);
    const plan = { state: async (): Promise<PlanState> => { await new Promise((r) => setTimeout(r, 40)); throw new Error('EAS caído'); } };
    const v = await homeView({ store, config, plan, planTimeoutMs: 5 }, 'demo', NOW);
    expect(v.pending).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    process.off('unhandledRejection', on);
    expect(unhandled).toEqual([]);
  });

  it('dos peticiones solapadas comparten una sola consulta a plan.state (también la que quedó atrás tras el límite)', async () => {
    const { config, store } = setup({ github: { ci: true } });
    let calls = 0;
    const plan = { state: async (): Promise<PlanState> => { calls++; await new Promise((r) => setTimeout(r, 80)); return state(); } };
    const [a, b] = await Promise.all([
      homeView({ store, config, plan, planTimeoutMs: 20 }, 'demo', NOW),
      homeView({ store, config, plan, planTimeoutMs: 20 }, 'demo', NOW),
    ]);
    expect([a.pending, b.pending]).toEqual([true, true]);
    const c = await homeView({ store, config, plan, planTimeoutMs: 500 }, 'demo', NOW); // aún en vuelo: la reutiliza
    expect(c.pending).toBe(false);
    expect(calls).toBe(1);
  });

  it('un throw síncrono de plan.state también se captura', async () => {
    const { config, store } = setup();
    const v = await homeView({ store, config, plan: { state: () => { throw new Error('boom'); } } }, 'demo', NOW);
    expect(v.pending).toBe(false);
    expect(v.tiles).toHaveLength(4);
  });

  it('un plan rápido no marca pending', async () => {
    const { config, store } = setup({ github: { ci: true } });
    const v = await homeView({ store, config, plan: { state: async () => state() } }, 'demo', NOW);
    expect(v.pending).toBe(false);
  });
});

describe('formato del gasto en «Esta semana»', () => {
  it('las líneas de gasto usan «≈ 108,71 $», como la cifra y la barra lateral', async () => {
    const routines = [{ id: 'informe', name: 'Informe', profileId: 'dev', level: 1 as const, title: 'I', prompt: 'x' }];
    const { config, store, project } = setup({ routines });
    addRun(store, project, { at: daysAgo(1), cost: 108.71, routineId: 'informe' });
    const week = (await homeView({ store, config }, 'demo', NOW)).week;
    expect(week.find((w) => w.label === 'Ejecuciones de agentes')?.value).toBe('1 · ≈ 108,71 $');
    expect(week.find((w) => w.label === 'Rutina más cara')?.value).toBe('Informe · ≈ 108,71 $');
  });
});
