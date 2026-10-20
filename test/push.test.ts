import { chmodSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { describe, expect, it, vi } from 'vitest';
import { loadVapid, Push, type Sender } from '../src/server/push';
import { Store } from '../src/server/store';
import { tmpDir } from './helpers';

const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });

describe('loadVapid', () => {
  it('crea vapid.json con permisos 600 y lo reutiliza', () => {
    const dir = tmpDir();
    const a = loadVapid(dir);
    expect(statSync(path.join(dir, 'vapid.json')).mode & 0o777).toBe(0o600);
    expect(a.publicKey.length).toBeGreaterThan(20);
    expect(loadVapid(dir)).toEqual(a);
  });

  it('JSON corrupto o sin claves: avisa, regenera; y aprieta permisos', () => {
    const dir = tmpDir();
    const f = path.join(dir, 'vapid.json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(f, '{no json');
    const a = loadVapid(dir);
    writeFileSync(f, '{"publicKey":"x"}');
    const b = loadVapid(dir);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('vapid.json no válido');
    expect(b.publicKey).not.toBe(a.publicKey);
    warn.mockRestore();
    chmodSync(f, 0o644);
    expect(loadVapid(dir)).toEqual(b);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});

describe('Push', () => {
  it('send: 410 borra, 500 deja last_error, la otra recibe {title, body, url}', async () => {
    const store = new Store(':memory:');
    const sender = vi.fn<Sender>(async (s) => ({ statusCode: s.endpoint.endsWith('/1') ? 410 : s.endpoint.endsWith('/2') ? 500 : 201 }));
    const push = new Push({ store, vapid: { publicKey: 'pub', privateKey: 'priv' }, contact: 'mailto:x@y.z', sender });
    [1, 2, 3].forEach((n) => push.subscribe(null, sub(n)));
    const counts = await push.send({ title: 'T', body: 'B', url: '/#/tarea/DEM-1' });
    expect(counts).toEqual({ sent: 1, failed: 2 });
    const left = store.listPushSubscriptions();
    expect(left.map((s) => s.endpoint)).toEqual([sub(2).endpoint, sub(3).endpoint]);
    expect(left[0].lastError).toContain('500');
    expect(left[1].lastError).toBeNull();
    const call = sender.mock.calls.find(([s]) => s.endpoint === sub(3).endpoint)!;
    expect(JSON.parse(call[1])).toEqual({ title: 'T', body: 'B', url: '/#/tarea/DEM-1' });
  });

  it('acota el aviso: título ≤ 80 y cuerpo ≤ 200 caracteres, con puntos suspensivos', async () => {
    const store = new Store(':memory:');
    const sender = vi.fn<Sender>(async () => ({ statusCode: 201 }));
    const push = new Push({ store, vapid: { publicKey: 'pub', privateKey: 'priv' }, contact: 'c', sender });
    push.subscribe(null, sub(1));
    const larga = 'p'.repeat(5000);
    await push.send({ title: `Pregunta: ${larga}`, body: larga, url: '/#/tarea/DEM-1' });
    const sent = JSON.parse(sender.mock.calls[0][1]);
    expect(sent.title.length).toBeLessThanOrEqual(80);
    expect(sent.body.length).toBeLessThanOrEqual(200);
    expect(sent.title.endsWith('…')).toBe(true);
    expect(sent.body.endsWith('…')).toBe(true);
    await push.send({ title: 'Corta', body: 'Cuerpo', url: '/' });
    expect(JSON.parse(sender.mock.calls[1][1])).toMatchObject({ title: 'Corta', body: 'Cuerpo' });
  });

  it('el envío real lleva un tiempo máximo de 15 s', async () => {
    const store = new Store(':memory:');
    const spy = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    try {
      const push = new Push({ store, vapid: { publicKey: 'pub', privateKey: 'priv' }, contact: 'mailto:x@y.z' });
      push.subscribe(null, sub(1));
      await push.send({ title: 'T', body: 'B', url: '/' });
      expect(spy.mock.calls[0][2]).toMatchObject({ timeout: 15_000, TTL: 3600 });
    } finally {
      spy.mockRestore();
    }
  });

  it('subscribe hace upsert por endpoint y unsubscribe borra; un sender que lanza guarda el error', async () => {
    const store = new Store(':memory:');
    const sender: Sender = async () => { throw new Error('red caída'); };
    const push = new Push({ store, vapid: { publicKey: 'pub', privateKey: 'priv' }, contact: 'c', sender });
    push.subscribe(null, sub(1));
    push.subscribe(null, { ...sub(1), keys: { p256dh: 'nuevo', auth: 'x' } });
    expect(store.listPushSubscriptions()).toHaveLength(1);
    expect(store.listPushSubscriptions()[0].keys.p256dh).toBe('nuevo');
    await push.send({ title: 'T', body: '', url: '/#/' });
    expect(store.listPushSubscriptions()[0].lastError).toBe('red caída');
    push.unsubscribe(sub(1).endpoint);
    expect(store.listPushSubscriptions()).toEqual([]);
  });
});
