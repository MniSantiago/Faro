import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsCollector, redact } from '../src/server/metrics/collector';
import type { MetricSource } from '../src/server/metrics/types';
import { Store } from '../src/server/store';
import { makeConfig } from './helpers';

let store: Store;
const config = () => {
  const c = makeConfig('/tmp/x');
  c.projects[0].metrics = { revenuecatProjectId: 'p1' };
  return c;
};
const src = (id: MetricSource['id'], collect: MetricSource['collect']): MetricSource => ({ id, label: id, collect });
const secret = async () => null;

beforeEach(() => { store = new Store(':memory:'); });

describe('MetricsCollector', () => {
  it('guarda foto ok y de error; configured:false no guarda nada', async () => {
    const c = new MetricsCollector({
      store, config: config(), secret,
      sources: [
        src('revenuecat', async () => ({ configured: true, data: { mrr: 12 } })),
        src('posthog', async () => { throw new Error('boom'); }),
        src('appstore', async () => ({ configured: false })),
      ],
    });
    await c.collectAll();
    expect(store.latestSnapshot('demo', 'revenuecat', false)).toMatchObject({ ok: true, data: { mrr: 12 } });
    expect(store.latestSnapshot('demo', 'posthog', false)).toMatchObject({ ok: false, error: 'boom' });
    expect(store.latestSnapshot('demo', 'appstore', false)).toBeNull();
    const st = c.status('demo');
    expect(st.map((s) => s.configured)).toEqual([true, true, false]);
    expect(st[1].lastOk).toBeNull();
  });

  it('una fuente que no responde da «Tiempo agotado» y las demás se guardan', async () => {
    const c = new MetricsCollector({
      store, config: config(), secret, timeoutMs: 50,
      sources: [
        src('revenuecat', () => new Promise(() => {})),
        src('posthog', async () => ({ configured: true, data: { a: 1 } })),
      ],
    });
    await c.collectAll();
    expect(store.latestSnapshot('demo', 'revenuecat', false)).toMatchObject({ ok: false, error: 'Tiempo agotado' });
    expect(store.latestSnapshot('demo', 'posthog', false)).toMatchObject({ ok: true, data: { a: 1 } });
  });

  it('aborta el fetch de la fuente al agotarse el tiempo', async () => {
    let aborted = false;
    const c = new MetricsCollector({
      store, config: config(), secret, timeoutMs: 50,
      sources: [src('posthog', async (ctx) => {
        await ctx.fetch('https://x.test').catch(() => { aborted = true; });
        return { configured: true };
      })],
      fetch: ((_u: unknown, init?: RequestInit) => new Promise((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abortado'))))) as typeof fetch,
    });
    await c.collectAll();
    expect(store.latestSnapshot('demo', 'posthog', false)?.error).toBe('Tiempo agotado');
    expect(aborted).toBe(true);
  });

  it('dos collectAll simultáneos recogen cada fuente una vez; una llamada posterior vuelve a recoger', async () => {
    const collect = vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); return { configured: true, data: {} }; });
    const c = new MetricsCollector({ store, config: config(), secret, sources: [src('revenuecat', collect)] });
    await Promise.all([c.collectAll(), c.collectAll()]);
    expect(collect).toHaveBeenCalledTimes(1);
    await c.collectAll();
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('el colector de Acme pide revenuecat:acme', async () => {
    const c = config();
    c.projects.push({ ...c.projects[0], id: 'acme', name: 'Acme', metrics: { revenuecatProjectId: 'p2' } });
    const asked: [string, string][] = [];
    const collector = new MetricsCollector({
      store, config: c, secret: async (n, projectId) => { asked.push([n, projectId]); return null; },
      sources: [src('revenuecat', async (ctx) => { await ctx.secret('revenuecat'); return { configured: false }; })],
    });
    await collector.collectAll();
    expect(asked.sort()).toEqual([['revenuecat', 'acme'], ['revenuecat', 'demo']]);
  });

  it('redact sustituye primero los secretos más largos', () => {
    expect(redact('x sk_123456 y', ['sk_123', 'sk_123456'])).toBe('x *** y');
  });

  it('el error guardado no contiene el secreto', async () => {
    const c = new MetricsCollector({
      store, config: config(), secret: async () => 'sk_123',
      sources: [src('revenuecat', async (ctx) => {
        await ctx.secret('revenuecat');
        throw new Error('fallo con clave sk_123');
      })],
    });
    await c.collectAll();
    expect(store.latestSnapshot('demo', 'revenuecat', false)?.error).toBe('fallo con clave ***');
  });

  describe('start', () => {
    const run = (ageHours: number) => {
      const now = new Date('2026-10-15T12:00:00Z');
      store.addSnapshot('demo', 'revenuecat', true, {}, null, new Date(now.getTime() - ageHours * 3600_000));
      const collect = vi.fn(async () => ({ configured: true, data: {} }));
      const c = new MetricsCollector({ store, config: config(), secret, now: () => now, sources: [src('revenuecat', collect)] });
      c.start(1_000_000);
      c.stop();
      return collect;
    };
    it('recoge al arrancar si la última foto es de hace 7 h', async () => {
      const collect = run(7);
      await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
    });
    it('no recoge si es de hace 1 h', async () => {
      const collect = run(1);
      await new Promise((r) => setTimeout(r, 30));
      expect(collect).not.toHaveBeenCalled();
    });
  });
});

describe('descargas por día', () => {
  it('guarda downloads_by_day en daily_downloads, no en la foto, y pasa los días conocidos', async () => {
    store.upsertDailyDownloads('demo', '2026-10-10', [{ country: 'ES', units: 1 }]);
    const seen: Set<string>[] = [];
    const c = new MetricsCollector({
      store, config: config(), secret, now: () => new Date('2026-10-15T10:00:00Z'),
      sources: [src('appstore', async (ctx) => {
        seen.push(ctx.knownDownloadDays);
        return { configured: true, data: { downloads: 4, downloads_by_day: [{ day: '2026-10-13', rows: [{ country: 'ES', units: 4 }] }] } };
      })],
    });
    await c.collectAll();
    expect(seen[0].has('2026-10-10')).toBe(true);
    expect(store.dailyDownloads('demo', '2026-10-13', '2026-10-13')).toEqual([{ day: '2026-10-13', country: 'ES', units: 4 }]);
    expect(store.latestSnapshot('demo', 'appstore', true)?.data).toEqual({ downloads: 4 });
  });
});

describe('días vacíos', () => {
  it('un día viejo vacío queda conocido en la siguiente recogida y no cuenta como conocido antes', async () => {
    const asked: string[][] = [];
    const c = new MetricsCollector({
      store, config: config(), secret, now: () => new Date('2026-10-15T10:00:00Z'),
      sources: [src('appstore', async (ctx) => {
        asked.push([...ctx.knownDownloadDays]);
        return { configured: true, data: { downloads_by_day: [{ day: '2026-10-09', rows: [] }] } };
      })],
    });
    await c.collectAll();
    await c.collectAll();
    expect(asked[0]).not.toContain('2026-10-09');
    expect(asked[1]).toContain('2026-10-09');
  });
});

describe('snapshotNear', () => {
  it('elige la foto ok más cercana a 7 días antes', () => {
    const now = new Date('2026-10-15T12:00:00Z');
    const ago = (days: number) => new Date(now.getTime() - days * 86400_000);
    store.addSnapshot('demo', 'revenuecat', true, { v: 1 }, null, ago(10));
    store.addSnapshot('demo', 'revenuecat', true, { v: 2 }, null, ago(6.5));
    store.addSnapshot('demo', 'revenuecat', false, {}, 'x', ago(7));
    store.addSnapshot('demo', 'revenuecat', true, { v: 3 }, null, ago(1));
    expect(store.snapshotNear('demo', 'revenuecat', ago(7))?.data).toEqual({ v: 2 });
    expect(store.snapshotNear('demo', 'posthog', ago(7))).toBeNull();
    expect(store.listSnapshots('demo', 'revenuecat', 2).map((s) => s.data.v)).toEqual([3, 2]);
  });
});
