import { describe, expect, it, vi } from 'vitest';
import { ReviewActions } from '../src/server/actions';
import { Bus } from '../src/server/bus';
import { expandTemplate, nextRun, Scheduler } from '../src/server/scheduler';
import { NotFoundError, Store } from '../src/server/store';
import type { PlanState } from '../src/server/plan';
import type { RoutineConfig } from '../src/server/types';
import { GitWorkspaces } from '../src/server/workspaces';
import { makeConfig, makeRepo } from './helpers';

const lunes9 = new Date(2026, 9, 19, 9, 0); // lunes 19-10-2026 09:00 local
const rutina = (over: Partial<RoutineConfig> = {}): RoutineConfig => ({
  id: 'semanal', name: 'Informe', cron: '0 9 * * 1', profileId: 'dev', level: 1,
  title: 'Informe {semana}', prompt: 'Datos hasta {fecha}', ...over,
});

function setup(routines: RoutineConfig[], start: Date, failing = false, plan?: { state: () => Promise<PlanState> }) {
  const base = makeConfig(makeRepo());
  const config = { ...base, projects: [{ ...base.projects[0], routines }] };
  const store = new Store(':memory:');
  const bus = new Bus();
  const enqueued: string[] = [];
  const orchestrator = { enqueue: (id: string) => { enqueued.push(id); store.setState(id, 'queued'); }, cancelChecks: () => false, interruptChecks: () => false };
  const actions = new ReviewActions({ store, config, bus, workspaces: new GitWorkspaces(), orchestrator, runner: { cancel: () => {} } });
  let now = start;
  const sched = new Scheduler({ store, config, actions: failing ? { createTask: () => { throw new Error('sin perfil'); } } : actions, plan, now: () => now });
  return { store, sched, enqueued, config, actions, bus, setNow: (d: Date) => { now = d; } };
}

describe('scheduler', () => {
  it('nextRun y plantillas', async () => {
    expect(nextRun('0 9 * * 1', new Date(2026, 9, 15, 12, 0))).toEqual(lunes9);
    expect(expandTemplate('Informe {semana} · {fecha}', lunes9)).toBe('Informe 2026-W43 · 2026-10-19');
  });

  it('context: metrics añade las fotos (o el aviso) a la descripción', async () => {
    const { store, sched, config } = setup([rutina({ context: 'metrics' }), rutina({ id: 'con', context: 'metrics' }), rutina({ id: 'sin', title: 'S' })], lunes9);
    sched.sync();
    const pid = config.projects[0].id;
    expect((await sched.runNow('semanal')).description).toContain('Datos de las últimas fotos de métricas (Faro):\n(no hay fotos de métricas todavía)');
    store.addSnapshot(pid, 'revenuecat', true, { mrr: 50 }, null, lunes9);
    const d = (await sched.runNow('con')).description;
    expect(d).toContain('Datos de las últimas fotos de métricas (Faro):\n- MRR: 50,00');
    expect((await sched.runNow('sin')).description).not.toContain('métricas');
  });

  describe('context: aso', () => {
    const ficha = { name: 'Demo', subtitle: 'Foco', keywords: 'a,b', sources: { name: 'tienda' as const, subtitle: 'tienda' as const, keywords: 'repo' as const } };
    const build = (asoFichas?: () => Promise<Record<string, typeof ficha>>) => {
      const t = setup([rutina({ context: 'aso' })], lunes9);
      t.config.projects[0]!.aso = { appId: '111', stores: [{ id: 'es', country: 'es', storefront: 'x', fichaFile: 'f.md' }] };
      const sched = new Scheduler({ store: t.store, config: t.config, actions: t.actions, asoFichas, now: () => lunes9 });
      sched.sync();
      return sched;
    };

    it('con la ficha inyectada la descripción lleva el contexto y las instrucciones', async () => {
      const d = (await build(async () => ({ es: ficha })).runNow('semanal')).description;
      expect(d).toContain('Contexto ASO de Faro');
      expect(d).toContain('Demo (tienda)');
      expect(d).toContain('propón una lista inicial');
      expect(d).toContain('```aso-json');
    });

    it('sin dependencia o si falla, el contexto dice que la ficha no está disponible', async () => {
      expect((await build().runNow('semanal')).description).toContain('ficha actual no disponible');
      const fallo = build(async () => { throw new Error('sin red'); });
      expect((await fallo.runNow('semanal')).description).toContain('ficha actual no disponible');
    });
  });

  it('context: estado añade tareas, pendientes, build, sin enviar, CI y PR', async () => {
    const plan: PlanState = {
      backlog: [{ id: 6, text: 'Más expediciones', isDone: false, createdAt: 0 }, { id: 2, text: 'Hecho', isDone: true, createdAt: 0 }],
      backlogError: null,
      build: { version: '1.0.2', buildNumber: '12', commit: 'abcdef1234', createdAt: '2026-10-18T10:00:00Z' }, buildFetchedAt: null, buildError: null,
      unshipped: [{ taskId: 'X-1', title: 'Armario', commits: 2, lastAt: '2026-10-18T11:00:00Z', touchesApp: true, state: 'done', tested: false }],
      unshippedError: null,
      github: { ci: { sha: '1234567890', state: 'failure', url: '', workflows: ['CI'], at: '' }, prs: [{ number: 81, title: 'Ficha', url: '', headRefName: 'f', isDraft: false }], error: null },
    };
    const { store, sched, config } = setup([rutina({ context: 'estado' })], lunes9, false, { state: async () => plan });
    sched.sync();
    const p = config.projects[0];
    const bloq = store.createTask(p, { title: 'Escudo', description: '', profileId: 'dev', level: 2 });
    store.setState(bloq.id, 'queued');
    store.setState(bloq.id, 'working');
    store.setState(bloq.id, 'blocked');
    const d = (await sched.runNow('semanal')).description;
    expect(d).toContain('Estado del proyecto según Faro');
    expect(d).toMatch(new RegExp(`### Bloqueadas\\n- ${bloq.id} · Escudo`));
    expect(d).toContain('#6 Más expediciones');
    expect(d).not.toContain('#2 Hecho');
    expect(d).toContain('1.0.2 (12) del 2026-10-18, commit abcdef1');
    expect(d).toContain('X-1 · Armario (2 commits, 2026-10-18) — falta probar en el iPhone');
    expect(d).toContain('CI de la rama base: failure en 1234567');
    expect(d).toContain('#81 Ficha');
  });

  it('context: estado sin Plan lo dice y sigue', async () => {
    const { sched } = setup([rutina({ context: 'estado' })], lunes9, false, { state: async () => { throw new Error('EAS caído'); } });
    sched.sync();
    const d = (await sched.runNow('semanal')).description;
    expect(d).toContain('(no se pudo leer: EAS caído)');
    expect(d).toContain('## Tareas abiertas en Faro');
  });

  it('sync da de alta desactivadas y con la próxima fecha', async () => {
    const { store, sched } = setup([rutina()], new Date(2026, 9, 15, 12, 0));
    sched.sync();
    expect(store.getRoutine('semanal')).toMatchObject({ enabled: false, nextRunAt: lunes9.toISOString() });
  });

  it('una rutina activa crea su tarea a su hora y programa la siguiente', async () => {
    const { store, sched, setNow } = setup([rutina()], new Date(2026, 9, 15, 12, 0));
    sched.sync();
    sched.toggle('semanal');
    setNow(new Date(2026, 9, 19, 9, 0, 30));
    await sched.tick();
    const [t] = store.listTasksByRoutine('semanal', 5);
    expect(t).toMatchObject({ title: 'Informe 2026-W43', description: 'Datos hasta 2026-10-19', state: 'queued', level: 1 });
    expect(store.getRoutine('semanal')?.nextRunAt).toBe(new Date(2026, 9, 26, 9, 0).toISOString());
  });

  it('Mac dormido < 12 h: se ejecuta una sola vez al despertar', async () => {
    const { store, sched, setNow } = setup([rutina({ cron: '0 * * * *' })], new Date(2026, 9, 19, 8, 30));
    sched.sync();
    sched.toggle('semanal');
    setNow(new Date(2026, 9, 19, 14, 10)); // se perdieron 9:00…14:00
    await sched.tick();
    await sched.tick();
    expect(store.listTasksByRoutine('semanal', 10)).toHaveLength(1);
    expect(store.getRoutine('semanal')?.nextRunAt).toBe(new Date(2026, 9, 19, 15, 0).toISOString());
  });

  it('Mac dormido > 12 h: se marca perdida y no crea tarea', async () => {
    const { store, sched, setNow } = setup([rutina()], new Date(2026, 9, 18, 12, 0));
    sched.sync();
    sched.toggle('semanal');
    setNow(new Date(2026, 9, 22, 10, 0)); // jueves: el lunes 9:00 quedó a 3 días
    await sched.tick();
    expect(store.listTasksByRoutine('semanal', 10)).toEqual([]);
    expect(store.getRoutine('semanal')).toMatchObject({ lastSkipReason: 'Perdida: el Mac estaba apagado o dormido', nextRunAt: new Date(2026, 9, 26, 9, 0).toISOString() });
  });

  it('si la anterior sigue abierta, se omite con el motivo', async () => {
    const { store, sched, setNow } = setup([rutina({ cron: '0 * * * *' })], new Date(2026, 9, 19, 8, 30));
    sched.sync();
    sched.toggle('semanal');
    setNow(new Date(2026, 9, 19, 9, 0, 5));
    await sched.tick();
    setNow(new Date(2026, 9, 19, 10, 0, 5));
    await sched.tick();
    const tasks = store.listTasksByRoutine('semanal', 10);
    expect(tasks).toHaveLength(1);
    expect(store.getRoutine('semanal')?.lastSkipReason).toBe(`La anterior sigue abierta (${tasks[0].id})`);
    await expect(sched.runNow('semanal')).rejects.toThrow('sigue abierta');
  });

  it('desactivada no se ejecuta; sin cron solo a mano; borrador si draft', async () => {
    const { store, sched, setNow } = setup([rutina(), rutina({ id: 'capturas', cron: undefined, draft: true })], new Date(2026, 9, 15, 12, 0));
    sched.sync();
    setNow(new Date(2026, 9, 19, 9, 1));
    await sched.tick();
    expect(store.listTasksByRoutine('semanal', 5)).toEqual([]);
    expect(store.getRoutine('capturas')?.nextRunAt).toBeNull();
    expect((await sched.runNow('capturas')).state).toBe('draft');
  });

  it('al activar se recalcula desde ahora (no ejecuta un pendiente viejo)', async () => {
    const { store, sched, setNow } = setup([rutina()], new Date(2026, 9, 15, 12, 0));
    sched.sync();
    setNow(new Date(2026, 9, 20, 12, 0));
    sched.toggle('semanal');
    expect(store.getRoutine('semanal')?.nextRunAt).toBe(new Date(2026, 9, 26, 9, 0).toISOString());
  });

  it('list incluye la config y las últimas tareas', async () => {
    const { sched } = setup([rutina()], new Date(2026, 9, 15, 12, 0));
    sched.sync();
    await sched.runNow('semanal');
    const [v] = sched.list();
    expect(v).toMatchObject({ id: 'semanal', name: 'Informe', cron: '0 9 * * 1', profileId: 'dev', level: 1, draft: false });
    expect(v.recent).toHaveLength(1);
  });

  it('una tarea abierta más antigua no queda oculta por una posterior cerrada', async () => {
    const { store, sched, config } = setup([rutina()], new Date(2026, 9, 15, 12, 0));
    sched.sync();
    const first = await sched.runNow('semanal');
    const second = store.createTask(config.projects[0], {
      title: 'x', description: '', profileId: 'dev', level: 1, routineId: 'semanal',
    });
    store.setState(second.id, 'discarded');
    await expect(sched.runNow('semanal')).rejects.toThrow(`sigue abierta (${first.id})`);
  });

  it('un fallo en una rutina no impide ejecutar las demás', async () => {
    const { store, sched, setNow } = setup([rutina({ id: 'a' }), rutina({ id: 'b' })], new Date(2026, 9, 15, 12, 0));
    sched.sync();
    sched.toggle('a');
    sched.toggle('b');
    const orig = store.updateRoutine.bind(store);
    store.updateRoutine = ((id: string, patch: never) => { if (id === 'a') throw new Error('boom'); return orig(id, patch); }) as typeof store.updateRoutine;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setNow(new Date(2026, 9, 19, 9, 0, 30));
    await sched.tick();
    expect(store.listTasksByRoutine('b', 5)).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('toggle y runNow sin fila o sin config lanzan NotFoundError', async () => {
    const { sched } = setup([rutina()], new Date(2026, 9, 15, 12, 0));
    expect(() => sched.toggle('semanal')).toThrow(NotFoundError);
    await expect(sched.runNow('semanal')).rejects.toThrow(NotFoundError);
    expect(() => sched.toggle('nope')).toThrow(NotFoundError);
    await expect(sched.runNow('nope')).rejects.toThrow(NotFoundError);
  });

  it('si crear la tarea falla, se registra el motivo', async () => {
    const { store, sched, setNow } = setup([rutina()], new Date(2026, 9, 15, 12, 0), true);
    sched.sync();
    sched.toggle('semanal');
    setNow(new Date(2026, 9, 19, 9, 0, 30));
    await sched.tick();
    expect(store.getRoutine('semanal')).toMatchObject({
      lastSkipReason: 'No se pudo crear la tarea: sin perfil', nextRunAt: new Date(2026, 9, 26, 9, 0).toISOString(),
    });
  });

  it('sync sobre una rutina existente conserva enabled y nextRunAt', async () => {
    const { store, sched } = setup([rutina()], new Date(2026, 9, 15, 12, 0));
    sched.sync();
    sched.toggle('semanal');
    const before = store.getRoutine('semanal');
    sched.sync();
    expect(store.getRoutine('semanal')).toMatchObject({ enabled: true, nextRunAt: before?.nextRunAt });
  });

  it('cambiar el cron en la config y sincronizar recalcula nextRunAt en el acto', async () => {
    const { store, sched, config } = setup([rutina()], new Date(2026, 9, 15, 12, 0));
    sched.sync();
    sched.toggle('semanal');
    config.projects[0]!.routines![0]!.cron = '0 8 * * *';
    sched.sync();
    expect(store.getRoutine('semanal')).toMatchObject({ enabled: true, cron: '0 8 * * *', nextRunAt: new Date(2026, 9, 16, 8, 0).toISOString() });
  });

  it('quitar de la config una rutina con una tarea abierta: list no la incluye y la tarea sigue', async () => {
    const { store, sched, config } = setup([rutina(), rutina({ id: 'otra' })], new Date(2026, 9, 15, 12, 0));
    sched.sync();
    const t = await sched.runNow('otra');
    config.projects[0]!.routines!.splice(1, 1);
    sched.sync();
    expect(sched.list().map((r) => r.id)).toEqual(['semanal']);
    expect(store.getRoutine('otra')).toBeNull();
    expect(store.getTask(t.id)).toMatchObject({ routineId: 'otra', state: t.state });
  });
});
