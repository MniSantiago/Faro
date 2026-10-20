import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/api';
import { Auth } from '../src/server/auth';
import { Bus } from '../src/server/bus';
import { LiveConfig } from '../src/server/overrides';
import { Scheduler } from '../src/server/scheduler';
import { Store } from '../src/server/store';
import type { BusMessage } from '../src/server/types';
import { makeConfig, makeRepo, tmpDir } from './helpers';

function setup(seed?: (store: Store) => void) {
  const repo = makeRepo();
  const base = makeConfig(repo);
  const raw = makeConfig(repo, {
    port: 3200, allowedHosts: ['faro.tailnet.ts.net'],
    projects: [{
      ...base.projects[0]!,
      metrics: { ascAppId: '123' },
      routines: [
        { id: 'diaria', name: 'Diaria', cron: '0 9 * * *', profileId: 'dev', level: 1, title: 'Diaria {fecha}', prompt: 'Revisa' },
        { id: 'despliegue', name: 'Despliegue', cron: '0 6 * * 1', profileId: 'ops', level: 3, title: 'Despliegue', prompt: 'Integra' },
      ],
    }],
    profiles: [
      { id: 'dev', name: 'Dev', instructions: 'Agente.', defaultLevel: 2, timeoutMinutes: 1 },
      { id: 'ops', name: 'Ops', instructions: 'Integra.', defaultLevel: 2, timeoutMinutes: 1 },
      { id: 'coordinador', name: 'Coordinador', instructions: 'Reparte.', defaultLevel: 1, timeoutMinutes: 1 },
    ],
  });
  const store = new Store(':memory:');
  seed?.(store);
  const bus = new Bus();
  const messages: BusMessage[] = [];
  bus.subscribe((m) => messages.push(m));
  let scheduler: Scheduler | null = null;
  const live = new LiveConfig({ raw, store, onChange: () => scheduler?.sync() });
  const config = live.config;
  scheduler = new Scheduler({ store, config, actions: { createTask: vi.fn() } });
  scheduler.sync();
  const secretExists = vi.fn(async (n: string) => n === 'revenuecat');
  const app = buildApp({
    store, config, live, secretExists, claudeVersion: () => '9.9.9 (Claude Code)',
    actions: {} as never, orchestrator: {} as never, bus, scheduler, releases: {} as never,
  });
  const auth = new Auth({ store });
  const cookie = auth.pair(auth.createPairingCode().code, 'iPhone').cookie.split(';')[0]!;
  const local = (o: InjectOptions) => app.inject({ ...o, headers: { host: '127.0.0.1:3200', 'x-faro': '1', ...o.headers } });
  const remote = (o: InjectOptions) => app.inject({ ...o, headers: { host: 'faro.tailnet.ts.net', cookie, 'x-faro': '1', ...o.headers } });
  return { app, store, live, config, messages, local, remote, secretExists };
}

const nueva = { projectId: 'demo', name: 'Revisión de dependencias', title: 'Deps {fecha}', prompt: 'Revisa las dependencias', profileId: 'dev', level: 2, cron: '0 8 * * 1' };

const full = async (inj: (o: InjectOptions) => Promise<LightMyRequestResponse>) => (await inj({ method: 'GET', url: '/api/config/full' })).json();

describe('API de configuración', () => {
  it('crear rutina en local: 200, id del nombre (único) y aparece en /api/routines; emite «config»', async () => {
    const { local, messages, store } = setup();
    const r = await local({ method: 'POST', url: '/api/config/routines', payload: nueva });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: 'revision-de-dependencias', projectId: 'demo', origin: 'panel', level: 2, editable: { ok: true } });
    expect(r.json().nextRunAt).toEqual(expect.any(String));
    const routines = (await local({ method: 'GET', url: '/api/routines' })).json();
    expect(routines.map((x: { id: string }) => x.id)).toContain('revision-de-dependencias');
    expect(messages).toContainEqual({ type: 'config' });
    const again = await local({ method: 'POST', url: '/api/config/routines', payload: nueva });
    expect(again.json().id).toBe('revision-de-dependencias-2');
    expect(store.listOverrides().map((o) => o.deviceId)).toEqual([null, null]);
  });

  it('un vinculado crea una rutina de nivel 2 (con su dispositivo) pero no de nivel 3', async () => {
    const { remote, store } = setup();
    expect((await remote({ method: 'POST', url: '/api/config/routines', payload: nueva })).statusCode).toBe(200);
    expect(store.listOverrides()[0]!.deviceId).toEqual(expect.any(String));
    const r = await remote({ method: 'POST', url: '/api/config/routines', payload: { ...nueva, level: 3 } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toContain('niveles 1 y 2');
  });

  it('vinculado: PUT con level 3 → 403 y no cambia nada', async () => {
    const { remote, config, messages } = setup();
    const r = await remote({ method: 'PUT', url: '/api/config/routines/diaria', payload: { level: 3 } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'Desde un dispositivo vinculado solo se pueden usar los niveles 1 y 2' });
    expect(config.projects[0]!.routines!.find((x) => x.id === 'diaria')!.level).toBe(1);
    expect(messages).toEqual([]);
  });

  it('vinculado: un cuerpo de nivel 2 sobre una rutina del archivo de nivel 3 → 403 (el «antes» sale de la config)', async () => {
    const { remote, local, config } = setup();
    const r = await remote({ method: 'PUT', url: '/api/config/routines/despliegue', payload: { level: 2, prompt: 'Otra cosa' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toContain('rutina de nivel 3 o 4');
    expect(config.projects[0]!.routines!.find((x) => x.id === 'despliegue')).toMatchObject({ level: 3, prompt: 'Integra' });
    // Un «before» falsificado, el id o el proyecto en el cuerpo no son campos editables: 400.
    for (const extra of [{ before: { level: 1 } }, { id: 'otra' }, { projectId: 'demo' }]) {
      const r2 = await remote({ method: 'PUT', url: '/api/config/routines/despliegue', payload: { level: 2, ...extra } });
      expect(r2.statusCode).toBe(400);
    }
    for (const extra of [{ id: 'otra' }, { projectId: 'demo' }]) {
      expect((await local({ method: 'PUT', url: '/api/config/routines/diaria', payload: { name: 'X', ...extra } })).statusCode).toBe(400);
    }
    expect(config.projects[0]!.routines!.find((x) => x.id === 'diaria')!.name).toBe('Diaria');
  });

  it('un override guardado que no se aplica no cuela su nivel al editar desde un vinculado', async () => {
    const { remote, local, config, live } = setup((store) => store.setOverride({
      kind: 'routine', id: 'diaria', origin: 'file', data: { level: 4, cron: 'mal' }, updatedAt: '2026-10-20T10:00:00.000Z', deviceId: null,
    }));
    expect(live.ignored().map((i) => i.id)).toEqual(['diaria']);
    const r = await remote({ method: 'PUT', url: '/api/config/routines/diaria', payload: { cron: '0 8 * * *' } });
    expect(r.statusCode).toBe(200);
    expect(config.projects[0]!.routines!.find((x) => x.id === 'diaria')).toMatchObject({ cron: '0 8 * * *', level: 1 });
    expect(live.ignored()).toEqual([]);
    // Y el override ignorado de una rutina del archivo se puede quitar (vuelve al archivo).
    expect((await local({ method: 'DELETE', url: '/api/config/routines/diaria' })).statusCode).toBe(200);
  });

  it('vinculado: perfil coordinador o usado por una rutina de nivel 3 → 403; uno normal sí', async () => {
    const { remote } = setup();
    const coord = await remote({ method: 'PUT', url: '/api/config/profiles/coordinador', payload: { name: 'X' } });
    expect(coord.statusCode).toBe(403);
    expect(coord.json().error).toContain('perfil coordinador');
    const ops = await remote({ method: 'PUT', url: '/api/config/profiles/ops', payload: { instructions: 'X' } });
    expect(ops.statusCode).toBe(403);
    expect((await remote({ method: 'PUT', url: '/api/config/profiles/dev', payload: { defaultLevel: 3 } })).statusCode).toBe(403);
    const dev = await remote({ method: 'PUT', url: '/api/config/profiles/dev', payload: { name: 'Desarrollo' } });
    expect(dev.statusCode).toBe(200);
    expect(dev.json()).toMatchObject({ id: 'dev', name: 'Desarrollo', origin: 'editada', overridden: ['name'] });
  });

  it('vinculado: Generales y Proyecto → 403', async () => {
    const { remote, config } = setup();
    const g = await remote({ method: 'PATCH', url: '/api/config/general', payload: { title: 'Mío' } });
    expect(g.statusCode).toBe(403);
    expect(g.json()).toEqual({ error: 'Solo desde el Mac' });
    expect((await remote({ method: 'PATCH', url: '/api/config/projects/demo', payload: { baseBranch: 'dev' } })).statusCode).toBe(403);
    expect(config.title).toBeUndefined();
  });

  it('rutina con cron inválido: 400 «cron inválido»; campos desconocidos o release: 400', async () => {
    const { local, store } = setup();
    const r = await local({ method: 'POST', url: '/api/config/routines', payload: { ...nueva, cron: 'cada lunes' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('cron inválido');
    expect((await local({ method: 'PUT', url: '/api/config/routines/diaria', payload: { release: 'build' } })).statusCode).toBe(400);
    expect((await local({ method: 'PUT', url: '/api/config/profiles/dev', payload: { mcpConfig: '/x' } })).statusCode).toBe(400);
    expect((await local({ method: 'PATCH', url: '/api/config/general', payload: { port: 1 } })).statusCode).toBe(400);
    expect(store.listOverrides()).toEqual([]);
  });

  it('DELETE de una editada vuelve a los valores del archivo; de una del archivo, 400; de una del panel, la borra', async () => {
    const { local, config } = setup();
    const put = await local({ method: 'PUT', url: '/api/config/routines/diaria', payload: { cron: '0 7 * * *', maxBudgetUsd: 2 } });
    expect(put.json()).toMatchObject({ origin: 'editada', cron: '0 7 * * *' });
    expect(put.json().overridden.sort()).toEqual(['cron', 'maxBudgetUsd']);
    const del = await local({ method: 'DELETE', url: '/api/config/routines/diaria' });
    expect(del.statusCode).toBe(200);
    const diaria = config.projects[0]!.routines!.find((x) => x.id === 'diaria')!;
    expect(diaria.cron).toBe('0 9 * * *');
    expect(diaria).not.toHaveProperty('maxBudgetUsd');
    const fromFile = await local({ method: 'DELETE', url: '/api/config/routines/diaria' });
    expect(fromFile.statusCode).toBe(400);
    expect((await local({ method: 'DELETE', url: '/api/config/routines/nope' })).statusCode).toBe(404);
    const id = (await local({ method: 'POST', url: '/api/config/routines', payload: nueva })).json().id;
    expect((await local({ method: 'DELETE', url: `/api/config/routines/${id}` })).statusCode).toBe(200);
    expect(config.projects[0]!.routines!.map((x) => x.id)).toEqual(['diaria', 'despliegue']);
  });

  it('volver a la config de una editada cuyo archivo es de nivel 3: el vinculado no (403), el Mac sí', async () => {
    const { local, remote, config } = setup();
    expect((await local({ method: 'PUT', url: '/api/config/routines/despliegue', payload: { level: 2 } })).statusCode).toBe(200);
    const r = await remote({ method: 'DELETE', url: '/api/config/routines/despliegue' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toContain('niveles 1 y 2');
    expect(config.projects[0]!.routines!.find((x) => x.id === 'despliegue')!.level).toBe(2);
    expect((await local({ method: 'DELETE', url: '/api/config/routines/despliegue' })).statusCode).toBe(200);
    expect(config.projects[0]!.routines!.find((x) => x.id === 'despliegue')!.level).toBe(3);
  });

  it('perfiles: crear con id del nombre, no borrar uno que usa una rutina, borrar uno libre', async () => {
    const { local, config } = setup();
    const p = await local({ method: 'POST', url: '/api/config/profiles', payload: { name: 'Diseño', instructions: 'Diseña.', defaultLevel: 1, timeoutMinutes: 10, effort: 'high' } });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ id: 'diseno', origin: 'panel', usedBy: [] });
    expect((await local({ method: 'POST', url: '/api/config/routines', payload: { ...nueva, profileId: 'diseno' } })).statusCode).toBe(200);
    const used = await local({ method: 'DELETE', url: '/api/config/profiles/diseno' });
    expect(used.statusCode).toBe(400);
    expect(used.json().error).toContain('revision-de-dependencias');
    await local({ method: 'DELETE', url: '/api/config/routines/revision-de-dependencias' });
    expect((await local({ method: 'DELETE', url: '/api/config/profiles/diseno' })).statusCode).toBe(200);
    expect(config.profiles.map((x) => x.id)).toEqual(['dev', 'ops', 'coordinador']);
  });

  it('Mac: PATCH de proyecto (github fusionado) y de Generales', async () => {
    const { local, config } = setup();
    await local({ method: 'PATCH', url: '/api/config/projects/demo', payload: { github: { ci: true } } });
    const r = await local({ method: 'PATCH', url: '/api/config/projects/demo', payload: { github: { prs: true }, metrics: { posthogProjectId: '42' } } });
    expect(r.statusCode).toBe(200);
    expect(config.projects[0]!.github).toEqual({ ci: true, prs: true });
    expect(config.projects[0]!.metrics).toEqual({ ascAppId: '123', posthogProjectId: '42' });
    expect((await local({ method: 'PATCH', url: '/api/config/projects/demo', payload: { checks: [] } })).statusCode).toBe(400);
    expect((await local({ method: 'PATCH', url: '/api/config/projects/nope', payload: { baseBranch: 'x' } })).statusCode).toBe(404);
    const g = await local({ method: 'PATCH', url: '/api/config/general', payload: { maxConcurrentRuns: 4, retryWatchdog: { maxWaitMs: 1000 } } });
    expect(g.statusCode).toBe(200);
    expect(config.maxConcurrentRuns).toBe(4);
    expect(g.json()).toMatchObject({ maxConcurrentRuns: 4, origin: 'editada' });
    const bad = await local({ method: 'PATCH', url: '/api/config/general', payload: { coordinatorProfile: 'fantasma' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('perfil desconocido');
  });

  it('PATCH de Proyecto y Generales sobre un override guardado que no se aplica: sale bien y lo sustituye', async () => {
    const at = '2026-10-20T10:00:00.000Z';
    const { local, live, config } = setup((store) => {
      store.setOverride({ kind: 'project', id: 'demo', origin: 'file', data: { contextWindow: -5 }, updatedAt: at, deviceId: null });
      store.setOverride({ kind: 'general', id: 'general', origin: 'file', data: { maxConcurrentRuns: 0 }, updatedAt: at, deviceId: null });
    });
    expect(live.ignored().map((i) => i.kind).sort()).toEqual(['general', 'project']);
    const p = await local({ method: 'PATCH', url: '/api/config/projects/demo', payload: { baseBranch: 'dev' } });
    expect(p.statusCode).toBe(200);
    const g = await local({ method: 'PATCH', url: '/api/config/general', payload: { title: 'Mío' } });
    expect(g.statusCode).toBe(200);
    expect(live.ignored()).toEqual([]);
    expect(config).toMatchObject({ title: 'Mío', maxConcurrentRuns: 2 });
    expect(config.projects[0]).toMatchObject({ baseBranch: 'dev' });
    expect(config.projects[0]!.contextWindow).toBeUndefined();
  });

  it('las respuestas de escritura son la misma vista que GET /full (secretos y versión reales); secretos cacheados', async () => {
    const { local, secretExists } = setup();
    const f = await full(local);
    const p = (await local({ method: 'PATCH', url: '/api/config/projects/demo', payload: { contextWindow: 100000 } })).json();
    expect(p).toEqual({ ...f.projects[0], contextWindow: 100000, origin: 'editada', overridden: ['contextWindow'] });
    const g = (await local({ method: 'PATCH', url: '/api/config/general', payload: { title: 'Mío' } })).json();
    expect(g).toEqual({ ...f.general, title: 'Mío', origin: 'editada', overridden: ['title'] });
    const r = (await local({ method: 'PUT', url: '/api/config/routines/diaria', payload: { name: 'Otra' } })).json();
    expect(r).toEqual({ ...f.routines[0], name: 'Otra', origin: 'editada', overridden: ['name'], nextRunAt: expect.any(String) });
    await full(local);
    // Una consulta por secreto en todo el minuto, y sin leer su valor.
    expect(secretExists).toHaveBeenCalledTimes(5);
  });

  it('GET /api/config/full: orígenes, contextos, secretos y lo editable según quién pregunta', async () => {
    const { local, remote } = setup();
    await local({ method: 'PUT', url: '/api/config/routines/diaria', payload: { cron: '0 7 * * *' } });
    const mac = await full(local);
    expect(mac.general).toMatchObject({ maxConcurrentRuns: 2, readonly: { host: '127.0.0.1', port: 3200, claudeVersion: '9.9.9 (Claude Code)' }, origin: 'config', editable: { ok: true } });
    expect(mac.routines.map((r: { id: string; origin: string }) => [r.id, r.origin])).toEqual([['diaria', 'editada'], ['despliegue', 'config']]);
    expect(mac.routines[0]).toMatchObject({ projectId: 'demo', overridden: ['cron'], nextRunAt: expect.any(String), editable: { ok: true } });
    expect(mac.profiles.find((p: { id: string }) => p.id === 'ops')).toMatchObject({ usedBy: ['despliegue'], origin: 'config' });
    expect(mac.projects[0]).toMatchObject({
      id: 'demo', baseBranch: 'main', metrics: { ascAppId: '123' }, editable: { ok: true },
      readonly: { checks: [], prepare: [] }, secrets: { revenuecat: true, posthog: false },
    });
    expect(mac.projects[0]).not.toHaveProperty('routines');
    expect(mac.contexts).toEqual({ demo: ['estado', 'metrics'] });
    expect(mac.ignored).toEqual([]);

    const phone = await full(remote);
    const ed = (list: { id: string; editable: { ok: boolean } }[], id: string) => list.find((x) => x.id === id)!.editable.ok;
    expect(ed(phone.routines, 'diaria')).toBe(true);
    expect(ed(phone.routines, 'despliegue')).toBe(false);
    expect(ed(phone.profiles, 'dev')).toBe(true);
    expect(ed(phone.profiles, 'ops')).toBe(false);
    expect(ed(phone.profiles, 'coordinador')).toBe(false);
    expect(phone.general.editable).toEqual({ ok: false, reason: 'Solo desde el Mac' });
    expect(phone.projects[0].editable.ok).toBe(false);
  });

  it('PUT, PATCH y DELETE también exigen la cabecera x-faro o JSON (CSRF)', async () => {
    const { app } = setup();
    const r = await app.inject({ method: 'DELETE', url: '/api/config/routines/diaria', headers: { host: '127.0.0.1:3200' } });
    expect(r.statusCode).toBe(403);
  });

  describe('asistente', () => {
    const conAsistente = async (fn: () => Promise<void>) => {
      const json = path.join(tmpDir(), 'draft.json');
      writeFileSync(json, JSON.stringify({ name: 'Semanal', title: 'Semanal', cron: null, profileId: 'dev', level: 3, context: null, maxBudgetUsd: null, prompt: 'Haz algo' }));
      process.env.FAKE_JSON_RESULT = json;
      try { await fn(); } finally { delete process.env.FAKE_JSON_RESULT; }
    };

    it('POST /routines/draft: vale en local y desde un dispositivo vinculado, con nivel capado a 2 y sin guardar nada', async () => {
      await conAsistente(async () => {
        const { local, remote, live } = setup();
        for (const inj of [local, remote]) {
          const r = await inj({ method: 'POST', url: '/api/config/routines/draft', payload: { projectId: 'demo', description: 'algo semanal' } });
          expect(r.statusCode).toBe(200);
          expect(r.json()).toMatchObject({ profileId: 'dev', level: 2 });
        }
        expect(live.ignored()).toEqual([]);
        expect((await full(local)).routines).toHaveLength(2);
      });
    });

    it('fallo de la CLI: local ve el detalle, un vinculado un mensaje genérico; ambos 502', async () => {
      await conAsistente(async () => {
        process.env.FAKE_JSON_SUBTYPE = 'error_max_budget_usd';
        try {
          const { local, remote } = setup();
          const payload = { projectId: 'demo', description: 'algo' };
          const l = await local({ method: 'POST', url: '/api/config/routines/draft', payload });
          expect(l.statusCode).toBe(502);
          expect(l.json().error).toContain('tope de gasto');
          const r = await remote({ method: 'POST', url: '/api/config/routines/draft', payload });
          expect(r.statusCode).toBe(502);
          expect(r.json().error).toBe('El asistente no pudo redactar la rutina');
        } finally { delete process.env.FAKE_JSON_SUBTYPE; }
      });
    });

    it('proyecto desconocido: 404; sin cabecera x-faro: rechazado', async () => {
      const { local } = setup();
      expect((await local({ method: 'POST', url: '/api/config/routines/draft', payload: { projectId: 'nope', description: 'x' } })).statusCode).toBe(404);
      expect((await local({ method: 'POST', url: '/api/config/routines/draft', headers: { 'x-faro': '' }, payload: { projectId: 'demo', description: 'x' } })).statusCode).toBeGreaterThanOrEqual(400);
    });
  });
});
