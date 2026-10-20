import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AsoCollector } from '../src/server/aso/collector';
import { currentFicha, readFicha, storedOrCurrentFicha } from '../src/server/aso/ficha';
import { difficulty, popularity } from '../src/server/aso/scores';
import { Store } from '../src/server/store';
import { gitSync, makeConfig, makeRepo } from './helpers';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const NOW = new Date('2026-10-20T08:00:00Z');
const plist = (terms: string[]) =>
  `<plist version="1.0"><dict><array>${terms.map((t) => `<dict><key>term</key><string>${t}</string></dict>`).join('')}</array></dict></plist>`;
const subHtml = (s: string | null) => (s === null ? '<h1>Opal</h1>' : `<h1>Opal</h1><p class="subtitle svelte-1">${s}</p>`);

interface World {
  hints: Record<string, string[]>;
  results: Record<string, { trackId: number; ratingCount?: number; rating?: number }[]>; // por país
  status: Record<string, number>; // «hints:es» | «search:es» → status
  subtitle: string | null;
  compName: string;
}
let world: World;
let store: Store;
let push: { send: ReturnType<typeof vi.fn> };
let urls: string[];

const fakeFetch = (async (input: string) => {
  const u = new URL(String(input));
  urls.push(String(input));
  const country = u.searchParams.get('country') ?? u.pathname.split('/')[1];
  if (u.host === 'search.itunes.apple.com') {
    const st = world.status['hints'];
    if (st) return new Response('x', { status: st });
    return new Response(plist(world.hints[u.searchParams.get('term')!] ?? []), { status: 200 });
  }
  if (u.pathname === '/search') {
    const st = world.status[`search:${country}`];
    if (st) return new Response('x', { status: st });
    return new Response(JSON.stringify({ results: (world.results[country!] ?? []).map((r) => ({ trackId: r.trackId, trackName: 'x', userRatingCount: r.ratingCount, averageUserRating: r.rating })) }));
  }
  if (u.pathname === '/lookup') {
    const ids = u.searchParams.get('id')!.split(',');
    return new Response(JSON.stringify({ results: ids.map((id) => ({ trackId: Number(id), trackName: id === '111' ? 'Demo' : world.compName, version: '1.0' })) }));
  }
  return new Response(subHtml(world.subtitle));
}) as unknown as typeof fetch;

function build(opts: { stores?: string[] } = {}) {
  const config = makeConfig('/tmp/x');
  const all = [
    { id: 'es', country: 'es', storefront: '143454-8,29', fichaFile: 'f/es.md' },
    { id: 'es-MX', country: 'mx', storefront: '143468-8,29', fichaFile: 'f/mx.md' },
  ];
  config.projects[0]!.aso = { appId: '111', stores: all.filter((s) => !opts.stores || opts.stores.includes(s.id)) };
  return new AsoCollector({
    store, config, push, fetch: fakeFetch, now: () => NOW, sleep: async () => {},
    readFicha: async () => ({ name: 'Demo', subtitle: null, keywords: 'bloquear,apps' }),
  });
}

beforeEach(() => {
  store = new Store(':memory:');
  push = { send: vi.fn(async () => ({ sent: 1, failed: 0 })) };
  urls = [];
  world = {
    hints: { bl: ['bloqueo', 'blusa'], blo: ['bloqueo', 'bloquear'], bloquear: ['bloquear'] },
    results: { es: [{ trackId: 5, ratingCount: 1000, rating: 4 }, { trackId: 111, ratingCount: 10, rating: 5 }], mx: [{ trackId: 7 }] },
    status: {}, subtitle: 'A', compName: 'Opal',
  };
});

describe('AsoCollector', () => {
  it('guarda una observación por keyword con las cuentas de scores', async () => {
    store.aso.addKeyword('demo', 'es', 'bloquear', 'user');
    store.aso.addKeyword('demo', 'es-MX', 'bloquear', 'user');
    await build().collectAll();
    const es = store.aso.latestObservation(store.aso.listKeywords('demo', 'es')[0]!.id)!;
    expect(es).toMatchObject({
      ok: true, takenAt: NOW.toISOString(), rank: 2,
      popularity: popularity({ prefixLen: 3, position: 1 }, 8),
      difficulty: difficulty([{ ratingCount: 1000, rating: 4 }, { ratingCount: 10, rating: 5 }]),
    });
    const mx = store.aso.latestObservation(store.aso.listKeywords('demo', 'es-MX')[0]!.id)!;
    expect(mx.rank).toBeNull();
    expect(store.aso.lastRun('demo')).toMatchObject({ ok: true, error: null });
  });

  it('las sugerencias no seguidas acaban en candidates', async () => {
    store.aso.addKeyword('demo', 'es', 'bloquear', 'user');
    await build({ stores: ['es'] }).collectAll();
    const c = store.aso.candidates('demo', 'es', '2000-01-01').map((x) => x.text);
    expect(c).toEqual(['bloqueo']);
  });

  it('429 corta la tienda', async () => {
    world.status['search:es'] = 429;
    store.aso.addKeyword('demo', 'es', 'bloquear', 'user');
    store.aso.addKeyword('demo', 'es', 'apps', 'user');
    store.aso.addKeyword('demo', 'es-MX', 'bloquear', 'user');
    await build().collectAll();
    const [a, b] = store.aso.listKeywords('demo', 'es');
    expect(store.aso.latestObservation(a!.id)).toMatchObject({ ok: false });
    expect(store.aso.latestObservation(b!.id)).toBeNull();
    expect(store.aso.latestObservation(store.aso.listKeywords('demo', 'es-MX')[0]!.id)).toMatchObject({ ok: true });
    const last = store.aso.lastRun('demo')!;
    expect(last.ok).toBe(false);
    expect(last.error).toContain('429');
  });

  it('un error que no es 403/429 sigue con la siguiente keyword', async () => {
    store.aso.addKeyword('demo', 'es', 'bloquear', 'user');
    store.aso.addKeyword('demo', 'es', 'apps', 'user');
    world.status['search:es'] = 500;
    await build({ stores: ['es'] }).collectAll();
    for (const k of store.aso.listKeywords('demo', 'es')) expect(store.aso.latestObservation(k.id)).toMatchObject({ ok: false });
    const last = store.aso.lastRun('demo')!;
    expect(last.ok).toBe(false);
    expect(last.error).toBe('es: 2 keywords con error (Apple respondió 500)');
  });

  it('dos pasadas el mismo día dejan una sola observación (gana la última)', async () => {
    const k = store.aso.addKeyword('demo', 'es', 'bloquear', 'user');
    const c = build({ stores: ['es'] });
    await c.collectAll();
    world.results.es = [{ trackId: 111 }];
    await c.collectAll();
    const all = store.aso.observations(k.id, '2000-01-01');
    expect(all).toHaveLength(1);
    expect(all[0]!.rank).toBe(1);
  });

  it('guarda la ficha vigente de cada tienda en cada pasada', async () => {
    world.subtitle = 'De tienda';
    await build({ stores: ['es'] }).collectAll();
    expect(store.aso.storedFicha('demo', 'es')).toEqual({
      takenAt: NOW.toISOString(),
      ficha: { name: 'Demo', subtitle: 'De tienda', keywords: 'bloquear,apps', sources: { name: 'tienda', subtitle: 'tienda', keywords: 'repo' } },
    });
    expect(store.aso.storedFicha('demo', 'es-MX')).toBeNull();
  });

  it('espera 300 ms entre peticiones', async () => {
    store.aso.addKeyword('demo', 'es', 'bloquear', 'user');
    const sleep = vi.fn(async () => {});
    const c = build({ stores: ['es'] });
    (c as unknown as { d: { sleep: typeof sleep } }).d.sleep = sleep;
    await c.collectAll();
    expect(sleep).toHaveBeenCalledWith(300);
    expect(sleep).toHaveBeenCalledTimes(urls.length - 1);
  });

  it('subtítulo null no cuenta como cambio', async () => {
    store.aso.addCompetitor('demo', '222', 'Opal');
    const c = build({ stores: ['es'] });
    for (const s of ['A', null, 'A']) { world.subtitle = s; await c.collectAll(); }
    expect(push.send).not.toHaveBeenCalled();
  });

  it('A → null → B avisa una vez; A → null → A no avisa', async () => {
    store.aso.addCompetitor('demo', '222', 'Opal');
    const c = build({ stores: ['es'] });
    for (const sub of ['A', null, 'B']) { world.subtitle = sub; await c.collectAll(); }
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(push.send.mock.calls[0]![0].title).toBe('Opal ha cambiado su subtítulo (es)');
  });

  it('la keyword completa aporta candidatas aunque haya acierto en un prefijo corto', async () => {
    world.hints = { bl: ['bloquear'], bloquear: ['bloquear', 'bloquear apps'] };
    store.aso.addKeyword('demo', 'es', 'bloquear', 'user');
    await build({ stores: ['es'] }).collectAll();
    expect(store.aso.candidates('demo', 'es', '2000-01-01').map((x) => x.text)).toEqual(['bloquear apps']);
  });

  it('un fallo de las sugerencias de la keyword completa no cambia la observación', async () => {
    world.hints = { bl: ['bloquear'] };
    store.aso.addKeyword('demo', 'es', 'bloquear', 'user');
    const base = fakeFetch;
    const c = build({ stores: ['es'] });
    (c as unknown as { d: { fetch: typeof fetch } }).d.fetch = (async (i: string, init?: RequestInit) =>
      (String(i).includes('MZSearchHints') && String(i).endsWith('term=bloquear')) ? new Response('x', { status: 500 }) : base(i, init)) as unknown as typeof fetch;
    await c.collectAll();
    expect(store.aso.latestObservation(store.aso.listKeywords('demo', 'es')[0]!.id)).toMatchObject({ ok: true, rank: 2 });
  });

  it('un cambio de subtítulo avisa una vez al día', async () => {
    store.aso.addCompetitor('demo', '222', 'Opal');
    const c = build({ stores: ['es'] });
    await c.collectAll();
    expect(push.send).not.toHaveBeenCalled(); // la primera foto no cuenta
    world.subtitle = 'B';
    await c.collectAll();
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(push.send).toHaveBeenCalledWith({ title: 'Opal ha cambiado su subtítulo (es)', body: expect.any(String), url: '/#/aso' });
    world.subtitle = 'C';
    await c.collectAll();
    expect(push.send).toHaveBeenCalledTimes(1);
  });

  it('avisa de una caída de ranking de una keyword de la ficha, una vez al día', async () => {
    const k = store.aso.addKeyword('demo', 'es', 'bloquear', 'user');
    for (const d of [3, 2, 1]) {
      store.aso.addObservation({ keywordId: k.id, takenAt: new Date(NOW.getTime() - d * 86_400_000).toISOString(), ok: true, popularity: 1, difficulty: 1, rank: 4, error: null });
    }
    world.results.es = [{ trackId: 1 }]; // ya no aparece
    const c = build({ stores: ['es'] });
    await c.collectAll();
    expect(push.send).toHaveBeenCalledWith({ title: 'Demo baja en «bloquear» (es)', body: 'Del 4 al —', url: '/#/aso' });
    await c.collectAll();
    expect(push.send).toHaveBeenCalledTimes(1);
  });

  it('start recoge si la última pasada tiene más de 24 h y stop para el reloj', async () => {
    const c = build({ stores: ['es'] });
    const spy = vi.spyOn(c, 'collectAll').mockResolvedValue();
    c.start();
    expect(spy).toHaveBeenCalledTimes(1);
    c.stop();
    store.aso.setLastRun('demo', { at: NOW.toISOString(), ok: true, error: null });
    const c2 = build({ stores: ['es'] });
    const spy2 = vi.spyOn(c2, 'collectAll').mockResolvedValue();
    c2.start();
    expect(spy2).not.toHaveBeenCalled();
    c2.stop();
  });
});

describe('readFicha / currentFicha', () => {
  it('lee la ficha de la rama base y devuelve null si no existe', async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, 'f.md'), '## Nombre\n\n```\nDemo\n```\n');
    gitSync(repo, 'add', '.'); gitSync(repo, 'commit', '-qm', 'ficha');
    expect(await readFicha(repo, 'main', 'f.md')).toMatchObject({ name: 'Demo' });
    expect(await readFicha(repo, 'main', 'no.md')).toBeNull();
  });

  it('usa la tienda y, si falla, el repo; las keywords siempre del repo', async () => {
    world.subtitle = 'De tienda';
    const project = makeConfig('/tmp/x').projects[0]!;
    project.aso = { appId: '111', stores: [] };
    const st = { id: 'es', country: 'es', storefront: 's', fichaFile: 'f.md' };
    const read = async () => ({ name: 'Repo', subtitle: 'Sub repo', keywords: 'a,b' });
    const ok = await currentFicha(fakeFetch, project, st, read);
    expect(ok).toMatchObject({ name: 'Demo', subtitle: 'De tienda', keywords: 'a,b', sources: { name: 'tienda', subtitle: 'tienda', keywords: 'repo' } });
    const failing = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    const fb = await currentFicha(failing, project, st, read);
    expect(fb).toMatchObject({ name: 'Repo', subtitle: 'Sub repo', sources: { name: 'repo', subtitle: 'repo' } });
    const none = await currentFicha(failing, project, st, async () => { throw new Error('git'); });
    expect(none).toMatchObject({ name: null, subtitle: null, keywords: null, sources: { name: null, subtitle: null, keywords: null } });
  });

  it('storedOrCurrentFicha usa la guardada y, si no hay, consulta solo esa tienda con tiempo máximo', async () => {
    const project = makeConfig('/tmp/x').projects[0]!;
    project.aso = { appId: '111', stores: [] };
    const st = { id: 'es', country: 'es', storefront: 's', fichaFile: 'f.md' };
    const read = async () => ({ name: 'Repo', subtitle: 'Sub repo', keywords: 'a,b' });
    const signals: (AbortSignal | null | undefined)[] = [];
    const spy = (async (i: string, init?: RequestInit) => { signals.push(init?.signal); return fakeFetch(i, init); }) as unknown as typeof fetch;
    const fresh = await storedOrCurrentFicha(store.aso, spy, project, st, read);
    expect(fresh).toMatchObject({ name: 'Demo', keywords: 'a,b' });
    expect(signals.length).toBe(2);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    const saved = { ...fresh, name: 'Guardada' };
    store.aso.setStoredFicha('demo', 'es', { takenAt: NOW.toISOString(), ficha: saved });
    expect(await storedOrCurrentFicha(store.aso, spy, project, st, read)).toEqual(saved);
    expect(signals.length).toBe(2);
  });
});
