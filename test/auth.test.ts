import { mkdtempSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ReviewActions } from '../src/server/actions';
import { buildApp } from '../src/server/api';
import { Auth, isLocalRequest } from '../src/server/auth';
import { Bus } from '../src/server/bus';
import { Store } from '../src/server/store';
import type { QueueState } from '../src/server/types';
import { GitWorkspaces } from '../src/server/workspaces';
import { makeConfig, makeRepo } from './helpers';

const LOCAL = '127.0.0.1:3200';
const REMOTE = 'faro.tailnet.ts.net';

function setup() {
  const config = makeConfig(makeRepo(), { port: 3200, allowedHosts: [REMOTE] });
  const store = new Store(':memory:');
  const bus = new Bus();
  const clock = { t: new Date('2026-10-15T10:00:00Z') };
  const auth = new Auth({ store, now: () => clock.t });
  const orchestrator = { enqueue: vi.fn(), cancelChecks: vi.fn(() => false), interruptChecks: vi.fn(() => false) };
  const queue: QueueState = { paused: false, reason: null, until: null, running: [] };
  const actions = new ReviewActions({ store, config, bus, workspaces: new GitWorkspaces(), orchestrator, runner: { cancel: vi.fn() } });
  const app = buildApp({
    store, config, actions, auth, bus,
    orchestrator: { queueState: () => queue, resume: vi.fn() },
    scheduler: { list: () => [], runNow: vi.fn(), toggle: vi.fn() },
    releases: { request: vi.fn(), retry: vi.fn(), stop: vi.fn() },
  });
  return { app, store, auth, clock };
}

const local = (app: FastifyInstance, o: InjectOptions) => app.inject({ ...o, headers: { host: LOCAL, ...o.headers } });
const remote = (app: FastifyInstance, o: InjectOptions) => app.inject({ ...o, headers: { host: REMOTE, ...o.headers } });

async function newCode(app: FastifyInstance): Promise<string> {
  const r = await local(app, { method: 'POST', url: '/api/devices/pairing', headers: { 'x-faro': '1' } });
  expect(r.statusCode).toBe(200);
  return r.json().code;
}

const pair = (app: FastifyInstance, code: string, name = 'iPhone de Santi') =>
  remote(app, { method: 'POST', url: '/api/devices/pair', payload: { code, name } });

/** «faro_sesion=<id>.<token>» a partir del Set-Cookie. */
function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = String(res.headers['set-cookie']);
  return raw.split(';')[0];
}

describe('isLocalRequest', () => {
  const req = (headers: Record<string, string>, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } });

  it('local con Host 127.0.0.1 o localhost en el puerto propio', () => {
    expect(isLocalRequest(req({ host: '127.0.0.1:3200' }), 3200)).toBe(true);
    expect(isLocalRequest(req({ host: 'localhost:3200' }), 3200)).toBe(true);
  });

  it('remoto con el Host de Tailscale', () => {
    expect(isLocalRequest(req({ host: REMOTE }), 3200)).toBe(false);
  });

  it('remoto con Host local pero X-Forwarded-For o Tailscale-User-Login', () => {
    expect(isLocalRequest(req({ host: LOCAL, 'x-forwarded-for': '100.64.0.2' }), 3200)).toBe(false);
    expect(isLocalRequest(req({ host: LOCAL, 'tailscale-user-login': 'santi@example.com' }), 3200)).toBe(false);
  });

  it('remoto con cabeceras de proxy X-Forwarded-Host, X-Forwarded-Proto o Forwarded', () => {
    expect(isLocalRequest(req({ host: LOCAL, 'x-forwarded-host': REMOTE }), 3200)).toBe(false);
    expect(isLocalRequest(req({ host: LOCAL, 'x-forwarded-proto': 'https' }), 3200)).toBe(false);
    expect(isLocalRequest(req({ host: LOCAL, forwarded: 'for=100.64.0.2;proto=https' }), 3200)).toBe(false);
  });

  it('remoto si la conexión no viene de loopback o el puerto no es el propio', () => {
    expect(isLocalRequest(req({ host: LOCAL }, '100.64.0.2'), 3200)).toBe(false);
    expect(isLocalRequest(req({ host: '127.0.0.1:9999' }), 3200)).toBe(false);
  });
});

describe('sesiones remotas', () => {
  it('sin cookie: el API da 401, el estado de sesión 200 y generar código 403', async () => {
    const { app } = setup();
    const tasks = await remote(app, { method: 'GET', url: '/api/tasks' });
    expect(tasks.statusCode).toBe(401);
    expect(tasks.json()).toEqual({ error: 'Inicia sesión en este dispositivo' });
    const state = await remote(app, { method: 'GET', url: '/api/auth/state' });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toEqual({ local: false, device: null });
    const pairing = await remote(app, { method: 'POST', url: '/api/devices/pairing', headers: { 'x-faro': '1' } });
    expect(pairing.statusCode).toBe(403);
  });

  it.each([
    ['x-forwarded-for', '100.64.0.2'],
    ['x-forwarded-host', REMOTE],
    ['x-forwarded-proto', 'https'],
    ['forwarded', 'for=100.64.0.2;proto=https'],
  ])('Host local con %s (proxy) y sin cookie: 401 en el API', async (header, value) => {
    const { app } = setup();
    const r = await local(app, { method: 'GET', url: '/api/tasks', headers: { [header]: value } });
    expect(r.statusCode).toBe(401);
  });

  it('con cookie válida, un remoto tampoco puede generar códigos: 403', async () => {
    const { app } = setup();
    const cookie = cookieOf(await pair(app, await newCode(app)));
    const r = await remote(app, { method: 'POST', url: '/api/devices/pairing', headers: { cookie, 'x-faro': '1' } });
    expect(r.statusCode).toBe(403);
  });

  it('todos los fallos de emparejar dan el mismo mensaje', async () => {
    const { app, clock } = setup();
    const msgs: string[] = [];
    const fail = async (code: string) => {
      const r = await pair(app, code);
      expect(r.statusCode).toBe(401);
      msgs.push(r.json().error);
    };
    await fail('123456'); // sin código activo
    const code = await newCode(app);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    await fail(wrong); // incorrecto
    clock.t = new Date(clock.t.getTime() + 10 * 60_000 + 1);
    await fail(code); // caducado
    const code2 = await newCode(app);
    const wrong2 = String((Number(code2) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 5; i++) await pair(app, wrong2);
    await fail(code2); // agotado
    expect(new Set(msgs)).toEqual(new Set(['Código no válido o caducado']));
  });

  it('en local el estado de sesión dice local y no hace falta cookie', async () => {
    const { app } = setup();
    expect((await local(app, { method: 'GET', url: '/api/auth/state' })).json()).toEqual({ local: true, device: null });
    expect((await local(app, { method: 'GET', url: '/api/tasks' })).statusCode).toBe(200);
  });

  it('emparejar: cookie segura y con ella el API responde', async () => {
    const { app } = setup();
    const code = await newCode(app);
    expect(code).toMatch(/^\d{6}$/);
    const r = await pair(app, code);
    expect(r.statusCode).toBe(200);
    expect(r.json().device).toMatchObject({ name: 'iPhone de Santi', lastSeenAt: null });
    const set = String(r.headers['set-cookie']);
    expect(set).toMatch(/^faro_sesion=[^.;]+\.[A-Za-z0-9_-]{43};/);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=31536000']) expect(set).toContain(attr);
    const tasks = await remote(app, { method: 'GET', url: '/api/tasks', headers: { cookie: cookieOf(r) } });
    expect(tasks.statusCode).toBe(200);
    const state = await remote(app, { method: 'GET', url: '/api/auth/state', headers: { cookie: `otra=1; ${cookieOf(r)}` } });
    expect(state.json()).toMatchObject({ local: false, device: { id: r.json().device.id } });
    expect(state.json().device.lastSeenAt).not.toBeNull();
  });

  it('una cookie con token alterado no vale', async () => {
    const { app } = setup();
    const r = await pair(app, await newCode(app));
    const [id] = cookieOf(r).slice('faro_sesion='.length).split('.');
    const bad = `faro_sesion=${id}.${'A'.repeat(43)}`;
    expect((await remote(app, { method: 'GET', url: '/api/tasks', headers: { cookie: bad } })).statusCode).toBe(401);
    expect((await remote(app, { method: 'GET', url: '/api/tasks', headers: { cookie: 'faro_sesion=basura' } })).statusCode).toBe(401);
  });

  it('el código es de un solo uso', async () => {
    const { app } = setup();
    const code = await newCode(app);
    expect((await pair(app, code)).statusCode).toBe(200);
    expect((await pair(app, code, 'Otro')).statusCode).toBe(401);
  });

  it('el código caduca a los 10 minutos', async () => {
    const { app, clock } = setup();
    const code = await newCode(app);
    clock.t = new Date(clock.t.getTime() + 10 * 60_000 + 1);
    expect((await pair(app, code)).statusCode).toBe(401);
  });

  it('un código nuevo invalida el anterior', async () => {
    const { app } = setup();
    const first = await newCode(app);
    let second = await newCode(app);
    while (second === first) second = await newCode(app);
    expect((await pair(app, first)).statusCode).toBe(401);
    expect((await pair(app, second)).statusCode).toBe(200);
  });

  it('5 fallos matan el código', async () => {
    const { app } = setup();
    const code = await newCode(app);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 5; i++) expect((await pair(app, wrong)).statusCode).toBe(401);
    expect((await pair(app, code)).statusCode).toBe(401);
  });

  it('revocar: la cookie deja de valer', async () => {
    const { app } = setup();
    const r = await pair(app, await newCode(app));
    const cookie = cookieOf(r);
    const list = await local(app, { method: 'GET', url: '/api/devices' });
    expect(list.json().map((d: { id: string }) => d.id)).toEqual([r.json().device.id]);
    const rev = await local(app, { method: 'POST', url: `/api/devices/${r.json().device.id}/revoke`, headers: { 'x-faro': '1' } });
    expect(rev.statusCode).toBe(200);
    expect((await remote(app, { method: 'GET', url: '/api/tasks', headers: { cookie } })).statusCode).toBe(401);
    expect((await local(app, { method: 'GET', url: '/api/devices' })).json()).toEqual([]);
  });

  it('revocar borra también sus suscripciones push', async () => {
    const { store, auth } = setup();
    const code = auth.createPairingCode().code;
    const { device } = auth.pair(code, 'iPad');
    store.upsertPushSubscription(device.id, 'https://push.example/1', { p256dh: 'p', auth: 'a' });
    auth.revoke(device.id);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 });
  });

  it('la base solo guarda el hash del token', async () => {
    const { app, store } = setup();
    const r = await pair(app, await newCode(app));
    const token = cookieOf(r).split('.')[1];
    const rows = store.db.prepare('SELECT * FROM devices').all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('el código de emparejamiento solo vive en memoria: ni rastro en la base', async () => {
    const { app, store } = setup();
    await newCode(app);
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).not.toContain('pairing_codes');
  });

  it('reiniciar (un Auth nuevo sobre la misma base) olvida el código', () => {
    const { store, auth, clock } = setup();
    const { code } = auth.createPairingCode();
    const otro = new Auth({ store, now: () => clock.t });
    expect(() => otro.pair(code, 'iPad')).toThrow('Código no válido o caducado');
  });

  it('una base antigua con la tabla pairing_codes la pierde al abrirse', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'faro-auth-'));
    const file = path.join(dir, 'faro.db');
    const old = new Database(file);
    old.exec("CREATE TABLE pairing_codes (code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0); INSERT INTO pairing_codes VALUES ('x', 'y', 0)");
    old.close();
    const store = new Store(file);
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).not.toContain('pairing_codes');
    store.db.close();
  });

  it('revocar cierra el SSE abierto con la cookie de ese dispositivo', async () => {
    const { app } = setup();
    const r = await pair(app, await newCode(app));
    const cookie = cookieOf(r);
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const port = (app.server.address() as { port: number }).port;
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const rq = httpRequest({ host: '127.0.0.1', port, path: '/api/stream', headers: { host: REMOTE, cookie } }, resolve);
        rq.on('error', reject);
        rq.end();
      });
      expect(res.statusCode).toBe(200);
      const ended = new Promise<void>((resolve) => { res.on('end', resolve); res.on('close', resolve); res.resume(); });
      const rev = await local(app, { method: 'POST', url: `/api/devices/${r.json().device.id}/revoke`, headers: { 'x-faro': '1' } });
      expect(rev.statusCode).toBe(200);
      await expect(Promise.race([ended.then(() => 'cerrado'), new Promise((ok) => setTimeout(() => ok('abierto'), 2000))])).resolves.toBe('cerrado');
    } finally {
      await app.close();
    }
  });

  it('el ping del SSE comprueba de nuevo la sesión: un dispositivo borrado por otra vía pierde el flujo', async () => {
    const { app, store } = setup();
    const r = await pair(app, await newCode(app));
    const cookie = cookieOf(r);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const port = (app.server.address() as { port: number }).port;
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const rq = httpRequest({ host: '127.0.0.1', port, path: '/api/stream', headers: { host: REMOTE, cookie } }, resolve);
        rq.on('error', reject);
        rq.end();
      });
      const ended = new Promise<void>((resolve) => { res.on('end', resolve); res.on('close', resolve); res.resume(); });
      store.deleteDevice(r.json().device.id); // sin pasar por Auth.revoke: no hay aviso
      vi.advanceTimersByTime(25_000);
      await expect(Promise.race([ended.then(() => 'cerrado'), new Promise((ok) => setTimeout(() => ok('abierto'), 2000))])).resolves.toBe('cerrado');
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });

  it('Origin https del host de Tailscale aceptado; uno ajeno, 403', async () => {
    const { app } = setup();
    const cookie = cookieOf(await pair(app, await newCode(app)));
    const ok = await remote(app, { method: 'POST', url: '/api/queue/resume', headers: { cookie, 'x-faro': '1', origin: `https://${REMOTE}` } });
    expect(ok.statusCode).toBe(200);
    const evil = await remote(app, { method: 'POST', url: '/api/queue/resume', headers: { cookie, 'x-faro': '1', origin: 'https://evil.example' } });
    expect(evil.statusCode).toBe(403);
  });
});
