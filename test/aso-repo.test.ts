import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store';

let store: Store;
beforeEach(() => { store = new Store(':memory:'); });

describe('AsoRepo keywords', () => {
  it('addKeyword normaliza y no duplica', () => {
    const a = store.aso.addKeyword('demo', 'es', '  Bloquear APPS', 'user');
    const b = store.aso.addKeyword('demo', 'es', 'bloquear apps', 'agent');
    expect(b.id).toBe(a.id);
    expect(a.text).toBe('bloquear apps');
    store.aso.archiveKeyword(a.id);
    expect(store.aso.listKeywords('demo', 'es')).toHaveLength(0);
    expect(store.aso.listKeywords('demo', 'es', true)).toHaveLength(1);
    const c = store.aso.addKeyword('demo', 'es', 'Bloquear apps', 'user');
    expect(c.id).toBe(a.id);
    expect(c.archived).toBe(false);
    expect(store.aso.listKeywords('demo', 'es')).toHaveLength(1);
  });
});

describe('AsoRepo observations', () => {
  it('devuelve solo las posteriores a since, en orden ascendente', () => {
    const k = store.aso.addKeyword('demo', 'es', 'foco', 'user');
    const obs = (takenAt: string, rank: number) => ({ keywordId: k.id, takenAt, ok: true, popularity: 40, difficulty: 30, rank, error: null });
    store.aso.addObservation(obs('2026-10-03T00:00:00.000Z', 3));
    store.aso.addObservation(obs('2026-10-01T00:00:00.000Z', 1));
    store.aso.addObservation(obs('2026-10-02T00:00:00.000Z', 2));
    expect(store.aso.observations(k.id, '2026-10-02T00:00:00.000Z').map((o) => o.rank)).toEqual([2, 3]);
    expect(store.aso.latestObservation(k.id)?.rank).toBe(3);
    expect(store.aso.latestObservation(9999)).toBeNull();
  });

  it('guarda observaciones fallidas con su error', () => {
    const k = store.aso.addKeyword('demo', 'es', 'foco', 'user');
    store.aso.addObservation({ keywordId: k.id, takenAt: '2026-10-01T00:00:00.000Z', ok: false, popularity: null, difficulty: null, rank: null, error: 'HTTP 500' });
    expect(store.aso.latestObservation(k.id)).toMatchObject({ ok: false, rank: null, error: 'HTTP 500' });
  });
});

describe('AsoRepo competidores', () => {
  it('addCompetitor es único por proyecto+appId', () => {
    const a = store.aso.addCompetitor('demo', '111', 'Forest');
    const b = store.aso.addCompetitor('demo', '111', 'Forest 2');
    expect(b.id).toBe(a.id);
    store.aso.archiveCompetitor(a.id);
    expect(store.aso.listCompetitors('demo')).toHaveLength(0);
    expect(store.aso.listCompetitors('demo', true)).toHaveLength(1);
  });

  it('saveCompetitorSnap solo inserta si algo cambia', () => {
    const c = store.aso.addCompetitor('demo', '111', 'Forest');
    const snap = (subtitle: string, takenAt: string) => ({ competitorId: c.id, storeId: 'es', takenAt, name: 'Forest', subtitle, version: '1.0' });
    expect(store.aso.saveCompetitorSnap(snap('a', '2026-10-01T00:00:00.000Z'))).toBe(true);
    expect(store.aso.saveCompetitorSnap(snap('a', '2026-10-02T00:00:00.000Z'))).toBe(false);
    expect(store.aso.saveCompetitorSnap(snap('b', '2026-10-03T00:00:00.000Z'))).toBe(true);
    expect(store.aso.competitorSnaps(c.id, 'es', 10).map((s) => s.subtitle)).toEqual(['b', 'a']);
    expect(store.aso.competitorSnaps(c.id, 'es', 1)).toHaveLength(1);
    expect(store.aso.saveCompetitorSnap({ ...snap('b', '2026-10-04T00:00:00.000Z'), storeId: 'en' })).toBe(true);
  });
});

describe('AsoRepo candidatas', () => {
  it('ignora duplicados y filtra por fecha', () => {
    store.aso.addCandidate('demo', 'es', 'Detox Digital');
    store.aso.addCandidate('demo', 'es', 'detox digital');
    const list = store.aso.candidates('demo', 'es', '1970-01-01T00:00:00.000Z');
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('detox digital');
    expect(store.aso.candidates('demo', 'es', '2999-01-01T00:00:00.000Z')).toHaveLength(0);
    expect(store.aso.candidates('demo', 'en', '1970-01-01T00:00:00.000Z')).toHaveLength(0);
  });
});

describe('AsoRepo propuestas', () => {
  const follow = (keyword: string) => ({ projectId: 'demo', storeId: 'es', kind: 'follow' as const, payload: { keyword }, why: 'x', taskId: null });

  it('repetida pendiente o rechazada devuelve null', () => {
    expect(store.aso.addProposal(follow('Foco Total'))).not.toBeNull();
    expect(store.aso.addProposal(follow('foco  total'))).toBeNull();
    const p = store.aso.listProposals('demo', 'pending')[0];
    store.aso.decideProposal(p.id, 'rejected');
    expect(store.aso.addProposal(follow('foco total'))).toBeNull();
    expect(store.aso.addProposal({ ...follow('foco total'), storeId: 'en' })).not.toBeNull();
  });

  it('competidor se compara por appId', () => {
    const c = (appId: string) => ({ projectId: 'demo', storeId: 'es', kind: 'competitor' as const, payload: { appId, name: 'F' }, why: 'x', taskId: null });
    expect(store.aso.addProposal(c('1'))).not.toBeNull();
    expect(store.aso.addProposal(c('1'))).toBeNull();
    expect(store.aso.addProposal(c('2'))).not.toBeNull();
  });

  it('una ficha nueva deja la anterior pendiente como superseded (no rechazada)', () => {
    const f = () => ({ projectId: 'demo', storeId: 'es', kind: 'ficha' as const, payload: { name: 'n' }, why: 'x', taskId: null });
    const a = store.aso.addProposal(f())!;
    const b = store.aso.addProposal(f())!;
    expect(b.id).not.toBe(a.id);
    expect(store.aso.listProposals('demo', 'superseded').map((p) => p.id)).toEqual([a.id]);
    expect(store.aso.listProposals('demo', 'rejected')).toEqual([]);
    expect(store.aso.listProposals('demo', 'pending').map((p) => p.id)).toEqual([b.id]);
    expect(() => store.aso.decideProposal(a.id, 'accepted')).toThrow('sustituida');
    expect(b.payload).toEqual({ name: 'n' });
  });

  it('aceptar follow crea la keyword del agente; unfollow la archiva; competitor lo crea', () => {
    const p = store.aso.addProposal(follow('foco'))!;
    expect(store.aso.decideProposal(p.id, 'accepted').state).toBe('accepted');
    const kw = store.aso.listKeywords('demo', 'es');
    expect(kw).toHaveLength(1);
    expect(kw[0].source).toBe('agent');

    const u = store.aso.addProposal({ ...follow('Foco'), kind: 'unfollow' })!;
    store.aso.decideProposal(u.id, 'accepted');
    expect(store.aso.listKeywords('demo', 'es')).toHaveLength(0);

    const c = store.aso.addProposal({ projectId: 'demo', storeId: 'es', kind: 'competitor', payload: { appId: '7', name: 'Forest' }, why: 'x', taskId: null })!;
    store.aso.decideProposal(c.id, 'accepted');
    expect(store.aso.listCompetitors('demo')).toMatchObject([{ appId: '7', name: 'Forest' }]);
  });

  it('aceptar un competidor con appId no numérico falla y lo deja pendiente', () => {
    const c = store.aso.addProposal({ projectId: 'demo', storeId: null, kind: 'competitor', payload: { appId: 'abc', name: 'X' }, why: 'x', taskId: null })!;
    expect(() => store.aso.decideProposal(c.id, 'accepted')).toThrow(expect.objectContaining({ reason: 'invalid' }));
    expect(store.aso.listCompetitors('demo')).toEqual([]);
    expect(store.aso.listProposals('demo', 'pending').map((p) => p.id)).toEqual([c.id]);
  });

  it('una observación por keyword y día local: la última del día sustituye a las anteriores', () => {
    const k = store.aso.addKeyword('demo', 'es', 'foco', 'user');
    const o = (takenAt: string, rank: number) => ({ keywordId: k.id, takenAt, ok: true, popularity: 1, difficulty: 1, rank, error: null });
    const base = new Date(2026, 9, 10, 9, 0, 0); // 10-oct a las 9:00 hora local
    store.aso.addObservation(o(base.toISOString(), 1));
    store.aso.addObservation(o(new Date(2026, 9, 10, 23, 0, 0).toISOString(), 2));
    store.aso.addObservation(o(new Date(2026, 9, 11, 0, 30, 0).toISOString(), 3));
    expect(store.aso.observations(k.id, '2000-01-01').map((x) => x.rank)).toEqual([2, 3]);
  });

  it('rechazar no tiene efectos y decidir dos veces falla', () => {
    const p = store.aso.addProposal(follow('foco'))!;
    store.aso.decideProposal(p.id, 'rejected');
    expect(store.aso.listKeywords('demo', 'es')).toHaveLength(0);
    expect(() => store.aso.decideProposal(p.id, 'accepted')).toThrow();
    expect(() => store.aso.decideProposal(999, 'accepted')).toThrow();
  });
});

describe('AsoRepo lastRun y esquema', () => {
  it('guarda la última pasada en meta', () => {
    expect(store.aso.lastRun('demo')).toBeNull();
    store.aso.setLastRun('demo', { at: '2026-10-20T00:00:00.000Z', ok: false, error: 'boom' });
    expect(store.aso.lastRun('demo')).toEqual({ at: '2026-10-20T00:00:00.000Z', ok: false, error: 'boom' });
    expect(store.getMeta('aso.ultima.demo')).not.toBeNull();
  });

  it('abrir el Store dos veces sobre el mismo archivo no falla', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'faro-aso-')), 'faro.db');
    const s1 = new Store(file);
    s1.aso.addKeyword('demo', 'es', 'foco', 'user');
    const s2 = new Store(file);
    expect(s2.aso.listKeywords('demo', 'es')).toHaveLength(1);
  });
});
