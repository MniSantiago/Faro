import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewActions } from '../src/server/actions';
import { buildApp } from '../src/server/api';
import { Auth } from '../src/server/auth';
import { Bus } from '../src/server/bus';
import { getProject } from '../src/server/config';
import { Push } from '../src/server/push';
import { Scheduler } from '../src/server/scheduler';
import { Store } from '../src/server/store';
import type { QueueState } from '../src/server/types';
import { GitWorkspaces } from '../src/server/workspaces';
import { makeConfig, makeRepo } from './helpers';

function setup() {
  const config = makeConfig(makeRepo(), { port: 3200, allowedHosts: ['faro.tailnet.ts.net'] });
  const store = new Store(':memory:');
  const bus = new Bus();
  const orchestrator = { enqueue: vi.fn((id: string) => { store.setState(id, 'queued'); }), cancelChecks: vi.fn(() => false), interruptChecks: vi.fn(() => false) };
  const queue: QueueState = { paused: true, reason: 'auth', until: null, running: [] };
  const orchState = { queueState: () => queue, resume: vi.fn(() => { queue.paused = false; }) };
  const runner = { cancel: vi.fn() };
  const actions = new ReviewActions({ store, config, bus, workspaces: new GitWorkspaces(), orchestrator, runner });
  const app = buildApp({ store, config, actions, orchestrator: orchState, bus, scheduler: { list: () => [], runNow: vi.fn(), toggle: vi.fn() }, releases: { request: vi.fn(), retry: vi.fn(), stop: vi.fn() } });
  return { app, store, config, bus, orchestrator, orchState, runner, actions };
}

const HOST = '127.0.0.1:3200';
/** inject() usa Host «localhost:80» por defecto; la API solo acepta su propio host. */
const inj = (app: FastifyInstance, o: InjectOptions) => app.inject({ ...o, headers: { host: HOST, ...o.headers } });

let closeMe: (() => Promise<unknown>) | null = null;
afterEach(async () => { await closeMe?.(); closeMe = null; });

describe('API', () => {
  it('config expone proyectos y perfiles', async () => {
    const { app } = setup();
    const r = await inj(app, { method: 'GET', url: '/api/config' });
    expect(r.json()).toEqual({ projects: [{ id: 'demo', name: 'Demo', prefix: 'DEM', release: false, metrics: false, aso: false }], profiles: [{ id: 'dev', name: 'Dev', defaultLevel: 2 }], coordinatorProfile: 'coordinador', title: 'Faro' });
  });

  it('POST /api/tasks con release en un proyecto sin lanzamientos: 400; GET trae jobs', async () => {
    const { app } = setup();
    const body = { projectId: 'demo', title: 'T', profileId: 'dev', release: 'build' };
    const bad = await inj(app, { method: 'POST', url: '/api/tasks', payload: body });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('lanzamientos');
    const ok = await inj(app, { method: 'POST', url: '/api/tasks', payload: { ...body, release: 'none' } });
    const got = await inj(app, { method: 'GET', url: `/api/tasks/${ok.json().id}` });
    expect(got.json().jobs).toEqual([]);
  });

  it('lista las rutinas', async () => {
    const { app } = setup();
    const r = await inj(app, { method: 'GET', url: '/api/routines' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it('rutina desconocida: 404', async () => {
    const config = makeConfig(makeRepo(), { port: 3200, allowedHosts: ['faro.tailnet.ts.net'] });
    const store = new Store(':memory:');
    const scheduler = new Scheduler({ store, config, actions: { createTask: vi.fn() } });
    const app2 = buildApp({ store, config, actions: {} as never, orchestrator: {} as never, bus: new Bus(), scheduler, releases: {} as never });
    for (const url of ['/api/routines/nope/run', '/api/routines/nope/toggle']) {
      expect((await inj(app2, { method: 'POST', url, headers: { 'x-faro': '1' } })).statusCode).toBe(404);
    }
  });

  it('crea y lista tareas', async () => {
    const { app, orchestrator } = setup();
    const r = await inj(app, { method: 'POST', url: '/api/tasks', payload: { projectId: 'demo', title: 'Hola', profileId: 'dev' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: 'DEM-1', state: 'queued', level: 2 });
    expect(orchestrator.enqueue).toHaveBeenCalledWith('DEM-1');
    const list = await inj(app, { method: 'GET', url: '/api/tasks?state=queued' });
    expect(list.json().map((t: { id: string }) => t.id)).toEqual(['DEM-1']);
  });

  it('valida el cuerpo y los ids de configuración', async () => {
    const { app } = setup();
    expect((await inj(app, { method: 'POST', url: '/api/tasks', payload: { projectId: 'demo', title: '', profileId: 'dev' } })).statusCode).toBe(400);
    const bad = await inj(app, { method: 'POST', url: '/api/tasks', payload: { projectId: 'nada', title: 'x', profileId: 'dev' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Proyecto desconocido/);
  });

  it('detalle, 404 y 409', async () => {
    const { app, store, config } = setup();
    const t = store.createTask(getProject(config, 'demo'), { title: 'x', description: '', profileId: 'dev', level: 2 });
    const d = await inj(app, { method: 'GET', url: `/api/tasks/${t.id}` });
    expect(Object.keys(d.json())).toEqual(['task', 'runs', 'artifacts', 'approvals', 'comments', 'jobs', 'stats']);
    expect((await inj(app, { method: 'GET', url: '/api/tasks/DEM-99' })).statusCode).toBe(404);
    const conflict = await inj(app, { method: 'POST', url: `/api/tasks/${t.id}/answer`, payload: { text: 'hola' } });
    expect(conflict.statusCode).toBe(409);
  });

  it('/api/stats: tareas activas con su coste, sin las hechas, y gasto de hoy', async () => {
    const { app, store, config } = setup();
    const p = getProject(config, 'demo');
    const mk = (title: string) => store.createTask(p, { title, description: '', profileId: 'dev', level: 2 });
    const rev = mk('rev');
    const done = mk('done');
    for (const t of [rev, done]) {
      store.setState(t.id, 'queued'); store.setState(t.id, 'working');
      const r = store.startRun(t.id, 's');
      store.finishRun(r.id, 'done', { input: 1, output: 1, costUsd: 1.5 });
      store.setState(t.id, 'review');
    }
    store.setState(done.id, 'done');
    const r = await inj(app, { method: 'GET', url: '/api/stats' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.tasks[rev.id]).toMatchObject({ costUsd: 1.5, turns: 1, contextWindow: 200000 });
    expect(body.tasks[done.id]).toBeUndefined();
    expect(body.spend.today).toBeCloseTo(3);
  });

  it('/api/tasks/:id trae stats.turns', async () => {
    const { app, store, config } = setup();
    const t = store.createTask(getProject(config, 'demo'), { title: 'x', description: '', profileId: 'dev', level: 2 });
    store.startRun(t.id, 's1'); store.startRun(t.id, 's2');
    const d = await inj(app, { method: 'GET', url: `/api/tasks/${t.id}` });
    expect(d.json().stats.turns).toBe(2);
  });

  it('historial paginado: 50 más recientes primero y offset; limit inválido: 400', async () => {
    const { app, store, config } = setup();
    const p = getProject(config, 'demo');
    for (let i = 0; i < 60; i++) {
      const t = store.createTask(p, { title: `t${i}`, description: '', profileId: 'dev', level: 2 });
      store.setState(t.id, 'discarded');
    }
    const first = (await inj(app, { method: 'GET', url: '/api/tasks?state=done,discarded&limit=50&offset=0' })).json();
    expect(first).toHaveLength(50);
    expect(first[0].title).toBe('t59');
    const next = (await inj(app, { method: 'GET', url: '/api/tasks?state=done,discarded&limit=50&offset=50' })).json();
    expect(next.map((t: { title: string }) => t.title)).toEqual(Array.from({ length: 10 }, (_, i) => `t${9 - i}`));
    expect((await inj(app, { method: 'GET', url: '/api/tasks?limit=abc' })).statusCode).toBe(400);
    expect((await inj(app, { method: 'GET', url: '/api/tasks?limit=5000' })).json()).toHaveLength(60);
  });

  it('POST answer con id desconocido → 400', async () => {
    const { app, store, config } = setup();
    const t = store.createTask(getProject(config, 'demo'), { title: 'T', description: '', profileId: 'dev', level: 2 });
    store.setState(t.id, 'queued'); store.setState(t.id, 'working');
    store.setState(t.id, 'blocked', { questions: [{ id: 'a', text: 'A' }] });
    const r = await inj(app, { method: 'POST', url: `/api/tasks/${t.id}/answer`, payload: { answers: { b: 'x' } } });
    expect(r.statusCode).toBe(400);
  });

  it('sirve artefactos dentro de dataDir y rechaza rutas de fuera', async () => {
    const { app, store, config } = setup();
    const t = store.createTask(getProject(config, 'demo'), { title: 'x', description: '', profileId: 'dev', level: 2 });
    const dir = path.join(config.dataDir, 'artifacts', t.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'diff.patch'), '+hola');
    const ok = store.addArtifact(t.id, 'diff', path.join(dir, 'diff.patch'), 'Diff');
    const evil = store.addArtifact(t.id, 'file', '/etc/hosts', 'mal');
    const r = await inj(app, { method: 'GET', url: `/api/artifacts/${ok.id}/file` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('+hola');
    expect((await inj(app, { method: 'GET', url: `/api/artifacts/${evil.id}/file` })).statusCode).toBe(403);
  });

  it('errores 500: remoto genérico (y se registra el detalle), local con el mensaje', async () => {
    const { app, store, actions } = setup();
    vi.spyOn(actions, 'approve').mockRejectedValue(new Error('detalle interno /ruta/secreta'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const auth = new Auth({ store });
      const cookie = auth.pair(auth.createPairingCode().code, 'iPhone').cookie.split(';')[0];
      const opts = { method: 'POST', url: '/api/tasks/X/approve', payload: {} } as const;
      const remote = await app.inject({ ...opts, headers: { host: 'faro.tailnet.ts.net', cookie } });
      expect(remote.statusCode).toBe(500);
      expect(remote.json()).toEqual({ error: 'Error interno' });
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls.flat().some((x) => x instanceof Error && x.message.includes('detalle interno'))).toBe(true);
      const loc = await inj(app, opts);
      expect(loc.statusCode).toBe(500);
      expect(loc.json()).toEqual({ error: 'detalle interno /ruta/secreta' });
    } finally {
      log.mockRestore();
    }
  });

  it('Range: 206 parcial, 416 si no cabe, y Accept-Ranges en el 200', async () => {
    const { app, store, config } = setup();
    const t = store.createTask(getProject(config, 'demo'), { title: 'v', description: '', profileId: 'dev', level: 2 });
    const dir = path.join(config.dataDir, 'artifacts', t.id);
    mkdirSync(dir, { recursive: true });
    const content = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
    writeFileSync(path.join(dir, 'v.mp4'), content);
    const a = store.addArtifact(t.id, 'file', path.join(dir, 'v.mp4'), 'Vídeo');
    const get = (range?: string) => inj(app, { method: 'GET', url: `/api/artifacts/${a.id}/file`, headers: range ? { range } : {} });

    const full = await get();
    expect(full.statusCode).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.rawPayload.length).toBe(100);
    expect(full.headers['content-length']).toBe('100');

    const first = await get('bytes=0-9');
    expect(first.statusCode).toBe(206);
    expect(first.headers['content-range']).toBe('bytes 0-9/100');
    expect(first.headers['content-length']).toBe('10');
    expect(first.headers['accept-ranges']).toBe('bytes');
    expect(first.headers['content-type']).toBe('video/mp4');
    expect(first.rawPayload.equals(content.subarray(0, 10))).toBe(true);

    const open = await get('bytes=90-');
    expect(open.statusCode).toBe(206);
    expect(open.headers['content-range']).toBe('bytes 90-99/100');
    expect(open.rawPayload.equals(content.subarray(90))).toBe(true);

    const suffix = await get('bytes=-5');
    expect(suffix.statusCode).toBe(206);
    expect(suffix.headers['content-range']).toBe('bytes 95-99/100');
    expect(suffix.headers['content-length']).toBe('5');
    expect(suffix.rawPayload.equals(content.subarray(95))).toBe(true);

    const clipped = await get('bytes=95-500');
    expect(clipped.headers['content-range']).toBe('bytes 95-99/100');

    for (const bad of ['bytes=200-', 'bytes=50-10', 'bytes=-0', 'bytes=abc', 'items=0-5']) {
      const r = await get(bad);
      expect(r.statusCode, bad).toBe(416);
      expect(r.headers['content-range'], bad).toBe('bytes */100');
    }
  });

  it('cola: estado y reanudar', async () => {
    const { app, orchState } = setup();
    expect((await inj(app, { method: 'GET', url: '/api/queue' })).json()).toMatchObject({ paused: true, reason: 'auth' });
    const r = await inj(app, { method: 'POST', url: '/api/queue/resume', headers: { 'x-faro': '1' } });
    expect(orchState.resume).toHaveBeenCalled();
    expect(r.json().paused).toBe(false);
  });

  it('SSE envía los mensajes del bus', async () => {
    const { app, bus, store, config } = setup();
    await app.listen({ host: '127.0.0.1', port: 0 });
    closeMe = () => app.close();
    const port = (app.server.address() as { port: number }).port;
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const t = store.createTask(getProject(config, 'demo'), { title: 'x', description: '', profileId: 'dev', level: 2 });
    bus.emitTask(t);
    let text = '';
    while (!text.includes('"type":"task"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain(`"id":"${t.id}"`);
    ctrl.abort();
  });

  it('app.close() termina aunque haya un cliente SSE conectado', async () => {
    const { app } = setup();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/stream`);
    const reader = res.body!.getReader();
    await reader.read();
    await app.close();
    await reader.cancel().catch(() => {});
  });

  it('JSON mal formado devuelve 400', async () => {
    const { app } = setup();
    const r = await inj(app, { method: 'POST', url: '/api/tasks', headers: { 'content-type': 'application/json' }, payload: '{mal json' });
    expect(r.statusCode).toBe(400);
    expect(typeof r.json().error).toBe('string');
  });

  it('un artefacto que es un directorio devuelve 404', async () => {
    const { app, store, config } = setup();
    const t = store.createTask(getProject(config, 'demo'), { title: 'x', description: '', profileId: 'dev', level: 2 });
    const dir = path.join(config.dataDir, 'artifacts', t.id);
    mkdirSync(dir, { recursive: true });
    const a = store.addArtifact(t.id, 'file', dir, 'dir');
    expect((await inj(app, { method: 'GET', url: `/api/artifacts/${a.id}/file` })).statusCode).toBe(404);
  });

  it('POST /stop para una tarea trabajando y rechaza las demás', async () => {
    const { app, store, config, runner } = setup();
    const t = store.createTask(getProject(config, 'demo'), { title: 'x', description: '', profileId: 'dev', level: 2 });
    expect((await inj(app, { method: 'POST', url: `/api/tasks/${t.id}/stop`, headers: { 'x-faro': '1' } })).statusCode).toBe(409);
    store.setState(t.id, 'queued');
    store.setState(t.id, 'working');
    const r = await inj(app, { method: 'POST', url: `/api/tasks/${t.id}/stop`, headers: { 'x-faro': '1' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ state: 'blocked', blockedReason: 'Parada por el usuario' });
    expect(runner.cancel).toHaveBeenCalledWith(t.id);
  });

  describe('protección del API local (Host, Origin, CSRF)', () => {
    it('rechaza un Host ajeno (DNS rebinding) y el de inject por defecto', async () => {
      const { app } = setup();
      const bad = await app.inject({ method: 'GET', url: '/api/config', headers: { host: 'evil.example:3200' } });
      expect(bad.statusCode).toBe(403);
      expect(typeof bad.json().error).toBe('string');
      expect((await app.inject({ method: 'GET', url: '/api/config' })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/config', headers: { host: '127.0.0.1:9999' } })).statusCode).toBe(403);
    });

    it('acepta 127.0.0.1, localhost y los allowedHosts', async () => {
      const { app } = setup();
      for (const host of ['127.0.0.1:3200', 'localhost:3200']) {
        expect((await app.inject({ method: 'GET', url: '/api/config', headers: { host } })).statusCode).toBe(200);
      }
      // El host de Tailscale pasa el control de Host (no 403) pero es remoto: sin sesión, 401.
      expect((await app.inject({ method: 'GET', url: '/api/config', headers: { host: 'faro.tailnet.ts.net' } })).statusCode).toBe(401);
    });

    it('rechaza un POST con Origin ajeno y acepta el propio', async () => {
      const { app } = setup();
      const payload = { projectId: 'demo', title: 'Hola', profileId: 'dev' };
      const evil = await inj(app, { method: 'POST', url: '/api/tasks', payload, headers: { origin: 'http://evil.example' } });
      expect(evil.statusCode).toBe(403);
      const ok = await inj(app, { method: 'POST', url: '/api/tasks', payload, headers: { origin: 'http://127.0.0.1:3200' } });
      expect(ok.statusCode).toBe(200);
    });

    it('un POST sin cuerpo exige x-faro; text/plain (no-cors) se rechaza', async () => {
      const { app, orchState } = setup();
      expect((await inj(app, { method: 'POST', url: '/api/queue/resume' })).statusCode).toBe(403);
      const plain = await inj(app, {
        method: 'POST', url: '/api/queue/resume', headers: { 'content-type': 'text/plain' }, payload: 'x',
      });
      expect(plain.statusCode).toBe(403);
      expect(orchState.resume).not.toHaveBeenCalled();
      const ok = await inj(app, { method: 'POST', url: '/api/queue/resume', headers: { 'x-faro': '1' } });
      expect(ok.statusCode).toBe(200);
      expect(orchState.resume).toHaveBeenCalled();
    });
  });
});

it('POST message: 200 en revisión y 409 en borrador', async () => {
  const { app, store, config } = setup();
  const t = store.createTask(getProject(config, 'demo'), { title: 'T', description: '', profileId: 'dev', level: 2 });
  const r409 = await inj(app, { method: 'POST', url: `/api/tasks/${t.id}/message`, payload: { text: 'hola' }, headers: { 'x-faro': '1' } });
  expect(r409.statusCode).toBe(409);
  store.setState(t.id, 'queued'); store.setState(t.id, 'working'); store.setState(t.id, 'review');
  const r = await inj(app, { method: 'POST', url: `/api/tasks/${t.id}/message`, payload: { text: 'hola' }, headers: { 'x-faro': '1' } });
  expect(r.statusCode).toBe(200);
  expect(store.listUndelivered(t.id).map((c) => c.body)).toEqual(['hola']);
});

it('GET /api/tasks?parent= devuelve los hijos', async () => {
  const { app, store, config } = setup();
  const p = store.createTask(getProject(config, 'demo'), { title: 'P', description: '', profileId: 'dev', level: 2 });
  const h = store.createTask(getProject(config, 'demo'), { title: 'H', description: '', profileId: 'dev', level: 2, parentId: p.id });
  const r = await inj(app, { method: 'GET', url: `/api/tasks?parent=${p.id}` });
  expect(r.json().map((t: { id: string }) => t.id)).toEqual([h.id]);
});

it('POST /api/chats sin perfil coordinador → 400', async () => {
  const { app } = setup();
  const r = await inj(app, { method: 'POST', url: '/api/chats', payload: { projectId: 'demo', text: 'hola' } });
  expect(r.statusCode).toBe(400);
});

describe('API push', () => {
  function withPush() {
    const s = setup();
    const sender = vi.fn(async () => ({ statusCode: 201 }));
    const push = new Push({ store: s.store, vapid: { publicKey: 'PUB', privateKey: 'PRIV' }, contact: 'mailto:t@t.t', sender });
    const auth = new Auth({ store: s.store });
    const app = buildApp({
      store: s.store, config: s.config, actions: s.actions, auth, push, bus: s.bus,
      orchestrator: { queueState: () => ({ paused: false, reason: null, until: null, running: [] }), resume: vi.fn() },
      scheduler: { list: () => [], runNow: vi.fn(), toggle: vi.fn() },
      releases: { request: vi.fn(), retry: vi.fn(), stop: vi.fn() },
    });
    return { ...s, app, sender, auth };
  }
  const sub = { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } };

  it('key, subscribe, test y unsubscribe', async () => {
    const { app, store, sender } = withPush();
    expect((await inj(app, { method: 'GET', url: '/api/push/key' })).json()).toEqual({ publicKey: 'PUB' });
    const bad = [{ endpoint: 'x' }, { ...sub, endpoint: 'http://push.example/1' }, { ...sub, endpoint: 'javascript:alert(1)' },
      { endpoint: sub.endpoint }, { ...sub, keys: { p256dh: '', auth: 'a' } }, { ...sub, keys: { p256dh: 'p'.repeat(201), auth: 'a' } },
      { ...sub, endpoint: `https://push.example/${'a'.repeat(1000)}` }];
    for (const payload of bad) expect((await inj(app, { method: 'POST', url: '/api/push/subscribe', payload })).statusCode).toBe(400);
    expect((await inj(app, { method: 'POST', url: '/api/push/subscribe', payload: sub })).statusCode).toBe(200);
    expect(store.listPushSubscriptions()).toMatchObject([{ endpoint: sub.endpoint, deviceId: null }]);
    const t = await inj(app, { method: 'POST', url: '/api/push/test', headers: { 'x-faro': '1' } });
    expect(t.json()).toEqual({ sent: 1, failed: 0 });
    expect(JSON.parse((sender.mock.calls[0] as unknown as [unknown, string])[1])).toMatchObject({ title: 'Faro funciona', url: '/#/bandeja' });
    await inj(app, { method: 'POST', url: '/api/push/unsubscribe', payload: { endpoint: sub.endpoint } });
    expect(store.listPushSubscriptions()).toEqual([]);
  });

  it('remoto sin cookie: 401 en key y subscribe', async () => {
    const { app } = withPush();
    const remote = { host: 'faro.tailnet.ts.net', 'x-forwarded-for': '100.1.1.1' };
    expect((await app.inject({ method: 'GET', url: '/api/push/key', headers: remote })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/push/subscribe', payload: sub, headers: remote })).statusCode).toBe(401);
  });

  it('subscribe desde un dispositivo guarda su id y revocarlo borra la suscripción', async () => {
    const { app, store, auth } = withPush();
    const code = auth.createPairingCode().code;
    const { device, cookie } = auth.pair(code, 'iPhone');
    const r = await app.inject({
      method: 'POST', url: '/api/push/subscribe', payload: sub,
      headers: { host: 'faro.tailnet.ts.net', 'x-forwarded-for': '100.1.1.1', cookie: cookie.split(';')[0], 'x-faro': '1' },
    });
    expect(r.statusCode).toBe(200);
    expect(store.listPushSubscriptions()[0].deviceId).toBe(device.id);
    await inj(app, { method: 'POST', url: `/api/devices/${device.id}/revoke`, headers: { 'x-faro': '1' } });
    expect(store.listPushSubscriptions()).toEqual([]);
  });
});

describe('API de métricas', () => {
  const withMetrics = (collectAll: () => Promise<void>) => {
    const { app: _unused, store, config, bus, orchState, actions } = setup();
    const metrics = { status: vi.fn((id: string) => [{ source: 'revenuecat' as const, label: 'RevenueCat', configured: true, last: null, lastOk: null, id }]), collectAll };
    const app = buildApp({ store, config, actions, orchestrator: orchState, bus, scheduler: { list: () => [], runNow: vi.fn(), toggle: vi.fn() }, releases: { request: vi.fn(), retry: vi.fn(), stop: vi.fn() }, metrics });
    return { app, metrics };
  };

  it('GET /api/metrics: 400 sin proyecto, 404 si no existe, estado si existe', async () => {
    const { app, metrics } = withMetrics(async () => {});
    expect((await inj(app, { method: 'GET', url: '/api/metrics' })).statusCode).toBe(400);
    expect((await inj(app, { method: 'GET', url: '/api/metrics?project=nope' })).statusCode).toBe(404);
    const r = await inj(app, { method: 'GET', url: '/api/metrics?project=demo' });
    expect(r.statusCode).toBe(200);
    expect(r.json().cards).toEqual([]);
    expect(r.json().status[0].source).toBe('revenuecat');
    expect(r.json().keychain['asc-p8']).toBe('security add-generic-password -U -s faro -a asc-p8 -w');
    expect(metrics.status).toHaveBeenCalledWith('demo');
  });

  it('GET /api/metrics devuelve las tarjetas de las últimas fotos', async () => {
    const { app: _u, store, config, bus, orchState, actions } = setup();
    store.addSnapshot('demo', 'revenuecat', true, { mrr: 42 }, null, new Date());
    const metrics = { status: () => [], collectAll: async () => {} };
    const app = buildApp({ store, config, actions, orchestrator: orchState, bus, scheduler: { list: () => [], runNow: vi.fn(), toggle: vi.fn() }, releases: { request: vi.fn(), retry: vi.fn(), stop: vi.fn() }, metrics });
    const r = await inj(app, { method: 'GET', url: '/api/metrics?project=demo' });
    expect(r.json().cards).toContainEqual(expect.objectContaining({ id: 'mrr', value: 42, deltaPct: null }));
  });

  it('POST /api/metrics/refresh responde cuando termina la recogida', async () => {
    let done = false;
    const { app } = withMetrics(async () => { await new Promise((r) => setTimeout(r, 30)); done = true; });
    const r = await inj(app, { method: 'POST', url: '/api/metrics/refresh', headers: { 'x-faro': '1' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(done).toBe(true);
  });
});

describe('API de ASO', () => {
  const STORE = { id: 'es', country: 'es', storefront: '143454-8,29', fichaFile: 'ficha.md' };
  const FICHA = { name: 'Demo', subtitle: 'Foco', keywords: 'foco,estudio', sources: { name: 'tienda' as const, subtitle: 'tienda' as const, keywords: 'repo' as const } };
  const withAso = (over: { collectAll?: () => Promise<void>; ficha?: () => Promise<typeof FICHA> } = {}) => {
    const { store, config, bus, orchState, actions } = setup();
    config.projects[0]!.aso = { appId: '123', stores: [STORE] };
    const collectAll = over.collectAll ?? (async () => {});
    const ficha = vi.fn(over.ficha ?? (async () => FICHA));
    const app = buildApp({ store, config, actions, orchestrator: orchState, bus, scheduler: { list: () => [], runNow: vi.fn(), toggle: vi.fn() }, releases: { request: vi.fn(), retry: vi.fn(), stop: vi.fn() }, aso: { collector: { collectAll }, ficha } });
    return { app, store, ficha };
  };
  const post = (app: FastifyInstance, url: string, payload?: unknown) => inj(app, { method: 'POST', url, payload: payload ?? {}, headers: { 'x-faro': '1' } });
  const obs = (store: Store, keywordId: number, daysAgo: number, rank: number | null, ok = true) =>
    store.aso.addObservation({ keywordId, takenAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(), ok, popularity: 50, difficulty: 20, rank, error: null });

  it('sin la dependencia aso no hay rutas /api/aso', async () => {
    const { app } = setup();
    expect((await inj(app, { method: 'GET', url: '/api/aso?project=demo&store=es' })).statusCode).toBe(404);
  });

  it('config expone aso: true cuando se pasa la dependencia y el proyecto lo tiene', async () => {
    const { app } = withAso();
    const r = await inj(app, { method: 'GET', url: '/api/config' });
    expect(r.json().projects[0].aso).toBe(true);
  });

  it('GET /api/aso: 400 sin proyecto o tienda, 404 si son desconocidos', async () => {
    const { app } = withAso();
    expect((await inj(app, { method: 'GET', url: '/api/aso' })).statusCode).toBe(400);
    expect((await inj(app, { method: 'GET', url: '/api/aso?project=demo' })).statusCode).toBe(400);
    expect((await inj(app, { method: 'GET', url: '/api/aso?project=nope&store=es' })).statusCode).toBe(404);
    expect((await inj(app, { method: 'GET', url: '/api/aso?project=demo&store=zz' })).statusCode).toBe(404);
  });

  it('GET /api/aso devuelve tiendas, keywords con inFicha y rankDelta7, propuestas y competidores', async () => {
    const { app, store } = withAso();
    const foco = store.aso.addKeyword('demo', 'es', 'Foco', 'user');
    const otra = store.aso.addKeyword('demo', 'es', 'meditación', 'user');
    const poca = store.aso.addKeyword('demo', 'es', 'estudio', 'user');
    for (const [d, rank] of [[5, 10], [4, 12], [2, 14], [0, 6]] as const) obs(store, foco.id, d, rank);
    obs(store, poca.id, 1, 9);
    obs(store, poca.id, 0, 8);
    store.aso.addProposal({ projectId: 'demo', storeId: 'es', kind: 'follow', payload: { keyword: 'pomodoro' }, why: 'x', taskId: null });
    store.aso.addProposal({ projectId: 'demo', storeId: 'es', kind: 'ficha', payload: { name: 'Demo 2' }, why: 'y', taskId: null });
    const comp = store.aso.addCompetitor('demo', '999', 'Forest');
    store.aso.saveCompetitorSnap({ competitorId: comp.id, storeId: 'es', takenAt: '2026-10-01T00:00:00.000Z', name: 'Forest', subtitle: 'a', version: '1' });
    store.aso.saveCompetitorSnap({ competitorId: comp.id, storeId: 'es', takenAt: '2026-10-10T00:00:00.000Z', name: 'Forest', subtitle: 'b', version: '1' });
    store.aso.setLastRun('demo', { at: '2026-10-20T00:00:00.000Z', ok: true, error: null });

    const r = await inj(app, { method: 'GET', url: '/api/aso?project=demo&store=es' });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.stores).toEqual([{ id: 'es', country: 'es' }]);
    expect(j.lastRun).toEqual({ at: '2026-10-20T00:00:00.000Z', ok: true, error: null });
    expect(j.ficha.current).toEqual(FICHA);
    expect(j.ficha.proposal).toEqual(expect.objectContaining({ kind: 'ficha' }));
    const byText = Object.fromEntries(j.keywords.map((k: { text: string }) => [k.text, k]));
    expect(byText['foco']).toEqual(expect.objectContaining({ inFicha: true, rank: 6, popularity: 50, difficulty: 20, opportunity: 40, ok: true, source: 'user' }));
    expect(byText['foco'].rankDelta7).toBeCloseTo(6 - 12, 5);
    expect(byText['meditacion']).toEqual(expect.objectContaining({ inFicha: false, rank: null, takenAt: null, rankDelta7: null, ok: false }));
    expect(byText['estudio'].rankDelta7).toBeNull();
    expect(j.pending).toHaveLength(1);
    expect(j.pending[0].kind).toBe('follow');
    expect(j.competitors).toHaveLength(1);
    expect(j.competitors[0]).toEqual(expect.objectContaining({ appId: '999', name: 'Forest' }));
    expect(j.competitors[0].current.subtitle).toBe('b');
    expect(j.competitors[0].changes).toHaveLength(2);
  });

  it('GET /api/aso: si falla la lectura de la ficha, current es null e inFicha false', async () => {
    const { app, store } = withAso({ ficha: async () => { throw new Error('sin red'); } });
    store.aso.addKeyword('demo', 'es', 'foco', 'user');
    const r = await inj(app, { method: 'GET', url: '/api/aso?project=demo&store=es' });
    expect(r.statusCode).toBe(200);
    expect(r.json().ficha.current).toBeNull();
    expect(r.json().keywords[0].inFicha).toBe(false);
  });

  it('GET /api/aso/keywords/:id/history devuelve las observaciones de 90 días', async () => {
    const { app, store } = withAso();
    const k = store.aso.addKeyword('demo', 'es', 'foco', 'user');
    obs(store, k.id, 100, 30);
    obs(store, k.id, 10, 20);
    obs(store, k.id, 1, 10);
    const r = await inj(app, { method: 'GET', url: `/api/aso/keywords/${k.id}/history` });
    expect(r.statusCode).toBe(200);
    expect(r.json().map((o: { rank: number }) => o.rank)).toEqual([20, 10]);
  });

  it('POST /api/aso/keywords crea, normaliza y valida', async () => {
    const { app, store } = withAso();
    const ok = await post(app, '/api/aso/keywords', { project: 'demo', store: 'es', text: '  Meditación  Guiada ' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(expect.objectContaining({ text: 'meditacion guiada', source: 'user', storeId: 'es' }));
    expect((await post(app, '/api/aso/keywords', { project: 'demo', store: 'es', text: '   ' })).statusCode).toBe(400);
    expect((await post(app, '/api/aso/keywords', { project: 'demo', store: 'zz', text: 'x' })).statusCode).toBe(404);
    expect((await post(app, '/api/aso/keywords', { project: 'nope', store: 'es', text: 'x' })).statusCode).toBe(404);
    const id = ok.json().id as number;
    expect((await post(app, `/api/aso/keywords/${id}/archive`)).json()).toEqual({ ok: true });
    expect(store.aso.listKeywords('demo', 'es')).toEqual([]);
    expect((await post(app, '/api/aso/keywords/9999/archive')).statusCode).toBe(404);
  });

  it('POST /api/aso/competitors crea y archiva; appId no numérico: 400', async () => {
    const { app, store } = withAso();
    const ok = await post(app, '/api/aso/competitors', { project: 'demo', appId: '12345', name: 'Forest' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(expect.objectContaining({ appId: '12345', name: 'Forest' }));
    expect((await post(app, '/api/aso/competitors', { project: 'demo', appId: 'abc', name: 'X' })).statusCode).toBe(400);
    expect((await post(app, '/api/aso/competitors', { project: 'nope', appId: '1', name: 'X' })).statusCode).toBe(404);
    expect((await post(app, `/api/aso/competitors/${ok.json().id}/archive`)).json()).toEqual({ ok: true });
    expect(store.aso.listCompetitors('demo')).toEqual([]);
  });

  it('POST /api/aso/proposals/:id acepta, rechaza, 409 si ya decidida y 404 si no existe', async () => {
    const { app, store } = withAso();
    const p = store.aso.addProposal({ projectId: 'demo', storeId: 'es', kind: 'follow', payload: { keyword: 'pomodoro' }, why: 'x', taskId: null })!;
    const r = await post(app, `/api/aso/proposals/${p.id}`, { decision: 'accepted' });
    expect(r.statusCode).toBe(200);
    expect(r.json().state).toBe('accepted');
    expect(store.aso.listKeywords('demo', 'es').map((k) => k.text)).toEqual(['pomodoro']);
    expect((await post(app, `/api/aso/proposals/${p.id}`, { decision: 'rejected' })).statusCode).toBe(409);
    expect((await post(app, '/api/aso/proposals/9999', { decision: 'accepted' })).statusCode).toBe(404);
    expect((await post(app, `/api/aso/proposals/${p.id}`, { decision: 'quizá' })).statusCode).toBe(400);
  });

  it('POST /api/aso/proposals/accept-all acepta follow, unfollow y competitor, pero no la ficha', async () => {
    const { app, store } = withAso();
    store.aso.addProposal({ projectId: 'demo', storeId: 'es', kind: 'follow', payload: { keyword: 'pomodoro' }, why: 'x', taskId: null });
    store.aso.addProposal({ projectId: 'demo', storeId: 'es', kind: 'follow', payload: { keyword: 'estudiar' }, why: 'x', taskId: null });
    store.aso.addProposal({ projectId: 'demo', storeId: null, kind: 'competitor', payload: { appId: '77', name: 'Focus' }, why: 'x', taskId: null });
    store.aso.addProposal({ projectId: 'demo', storeId: 'es', kind: 'ficha', payload: { name: 'N' }, why: 'x', taskId: null });
    const r = await post(app, '/api/aso/proposals/accept-all', { project: 'demo', store: 'es' });
    expect(r.statusCode).toBe(200);
    expect(r.json().accepted).toBe(3);
    expect(store.aso.listKeywords('demo', 'es').map((k) => k.text)).toEqual(['pomodoro', 'estudiar']);
    expect(store.aso.listCompetitors('demo').map((c) => c.appId)).toEqual(['77']);
    expect(store.aso.listProposals('demo', 'pending').map((x) => x.kind)).toEqual(['ficha']);
    expect((await post(app, '/api/aso/proposals/accept-all', { project: 'demo', store: 'zz' })).statusCode).toBe(404);
  });

  it('accept-all deja pendiente un competidor con appId no numérico y acepta el resto', async () => {
    const { app, store } = withAso();
    store.aso.addProposal({ projectId: 'demo', storeId: null, kind: 'competitor', payload: { appId: 'abc', name: 'Malo' }, why: 'x', taskId: null });
    store.aso.addProposal({ projectId: 'demo', storeId: 'es', kind: 'follow', payload: { keyword: 'pomodoro' }, why: 'x', taskId: null });
    const r = await post(app, '/api/aso/proposals/accept-all', { project: 'demo', store: 'es' });
    expect(r.json().accepted).toBe(1);
    expect(store.aso.listProposals('demo', 'pending').map((x) => x.payload.appId)).toEqual(['abc']);
    const bad = store.aso.listProposals('demo', 'pending')[0]!;
    expect((await post(app, `/api/aso/proposals/${bad.id}`, { decision: 'accepted' })).statusCode).toBe(409);
  });

  it('GET /api/aso usa la ficha guardada por el colector sin consultar a Apple', async () => {
    const { app, store, ficha } = withAso();
    const stored = { ...FICHA, name: 'Guardada' };
    store.aso.setStoredFicha('demo', 'es', { takenAt: '2026-10-20T00:00:00.000Z', ficha: stored });
    const r = await inj(app, { method: 'GET', url: '/api/aso?project=demo&store=es' });
    expect(r.json().ficha.current).toEqual(stored);
    expect(ficha).not.toHaveBeenCalled();
  });

  it('una ficha sustituida no sale como propuesta ni pendiente', async () => {
    const { app, store } = withAso();
    store.aso.addProposal({ projectId: 'demo', storeId: 'es', kind: 'ficha', payload: { name: 'A' }, why: 'x', taskId: null });
    const b = store.aso.addProposal({ projectId: 'demo', storeId: 'es', kind: 'ficha', payload: { name: 'B' }, why: 'x', taskId: null })!;
    const j = (await inj(app, { method: 'GET', url: '/api/aso?project=demo&store=es' })).json();
    expect(j.ficha.proposal.id).toBe(b.id);
    expect(j.pending).toEqual([]);
  });

  it('rankDelta7 necesita 3 días previos: 3 actualizaciones el mismo día no bastan', async () => {
    const { app, store } = withAso();
    const k = store.aso.addKeyword('demo', 'es', 'foco', 'user');
    const yesterday = Date.now() - 86_400_000;
    for (const m of [0, 1, 2]) store.aso.addObservation({ keywordId: k.id, takenAt: new Date(yesterday + m * 60_000).toISOString(), ok: true, popularity: 1, difficulty: 1, rank: 5, error: null });
    obs(store, k.id, 0, 30);
    const j = (await inj(app, { method: 'GET', url: '/api/aso?project=demo&store=es' })).json();
    expect(j.keywords[0].rankDelta7).toBeNull();
  });

  it('POST /api/aso/refresh responde cuando termina la pasada', async () => {
    let done = false;
    const { app } = withAso({ collectAll: async () => { await new Promise((r) => setTimeout(r, 30)); done = true; } });
    const r = await post(app, '/api/aso/refresh');
    expect(r.json()).toEqual({ ok: true });
    expect(done).toBe(true);
  });
});

describe('API de la home', () => {
  it('GET /api/home: 400 sin proyecto, 404 si no existe; sin metrics ni plan, gasto y semana', async () => {
    const { app } = setup();
    expect((await inj(app, { method: 'GET', url: '/api/home' })).statusCode).toBe(400);
    expect((await inj(app, { method: 'GET', url: '/api/home?project=nope' })).statusCode).toBe(404);
    const r = await inj(app, { method: 'GET', url: '/api/home?project=demo' });
    expect(r.statusCode).toBe(200);
    const v = r.json();
    expect(v.headline).toMatchObject({ text: 'Todo en orden', needCount: 0 });
    expect(v.tiles.map((t: { metric: string; configured: boolean }) => [t.metric, t.configured]))
      .toEqual([['descargas', false], ['conversion', false], ['mrr', false], ['gasto', true]]);
    expect(v.tiles[3].value).toBe(0);
    expect(v.health).toEqual([]);
    expect(v.week.map((w: { label: string }) => w.label)).toEqual(['Tareas integradas', 'Ejecuciones de agentes']);
  });

  it('GET /api/home/series valida la cifra y los días', async () => {
    const { app } = setup();
    const get = (q: string) => inj(app, { method: 'GET', url: `/api/home/series?${q}` });
    expect((await get('metric=gasto&days=7')).statusCode).toBe(400);
    expect((await get('project=demo&metric=otra&days=7')).statusCode).toBe(400);
    expect((await get('project=demo&metric=gasto&days=15')).statusCode).toBe(400);
    expect((await get('project=demo&metric=gasto')).statusCode).toBe(400);
    expect((await get('project=nope&metric=gasto&days=7')).statusCode).toBe(404);
    const r = await get('project=demo&metric=gasto&days=30');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ metric: 'gasto', days: 30, current: 0, note: 'Equivalente API' });
    expect(r.json().breakdowns.map((b: { title: string }) => b.title)).toEqual(['Por rutina', 'Por perfil', 'Resumen']);
    expect(r.json().points).toHaveLength(30);
  });
});
