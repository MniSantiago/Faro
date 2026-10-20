import { afterEach, describe, expect, it, vi } from 'vitest';
import { asoContext } from '../src/server/aso/context';
import type { CurrentFicha } from '../src/server/aso/ficha';
import { Store } from '../src/server/store';
import type { ProjectConfig } from '../src/server/types';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const project = {
  id: 'demo', name: 'Demo',
  aso: { appId: '111', stores: [{ id: 'es', country: 'es', storefront: '143454-8,29', fichaFile: 'ficha.md' }] },
} as unknown as ProjectConfig;
const ficha: CurrentFicha = {
  name: 'Demo', subtitle: 'Foco sin distracciones', keywords: 'bloquear,apps',
  sources: { name: 'tienda', subtitle: 'repo', keywords: 'repo' },
};

describe('asoContext', () => {
  it('muestra la fila de la keyword con los dos puestos y la ficha con su origen', () => {
    const store = new Store(':memory:');
    const k = store.aso.addKeyword('demo', 'es', 'bloquear apps', 'user');
    store.aso.addObservation({ keywordId: k.id, takenAt: '2026-10-13T12:00:00.000Z', ok: true, popularity: 40, difficulty: 30, rank: 12, error: null });
    store.aso.addObservation({ keywordId: k.id, takenAt: '2026-10-20T11:00:00.000Z', ok: true, popularity: 45, difficulty: 31, rank: 7, error: null });
    const out = asoContext(store, project, { es: ficha }, NOW);
    expect(out).toContain('| bloquear apps | 45 | 31 | 7 (2026-10-20) | 12 | sí |');
    expect(out).toContain('Demo (tienda)');
    expect(out).toContain('Foco sin distracciones (repo)');
    expect(out).toContain('```aso-json');
    expect(out).not.toContain('.faro/artifacts/aso.json');
    expect(out).toContain('documentación de marketing del repo');
    expect(out).toContain('competidores que ya conozcas');
  });

  it('sin keywords pide una lista inicial; sin ficha lo dice', () => {
    const store = new Store(':memory:');
    const out = asoContext(store, project, {}, NOW);
    expect(out).toContain('No hay keywords seguidas: propón una lista inicial');
    expect(out).toContain('ficha actual no disponible');
  });

  it('incluye candidatas, cambios de competidores y propuestas rechazadas', () => {
    const store = new Store(':memory:');
    store.aso.addCandidate('demo', 'es', 'detox digital');
    const c = store.aso.addCompetitor('demo', '999', 'Forest');
    const snap = (subtitle: string, takenAt: string) => ({ competitorId: c.id, storeId: 'es', takenAt, name: 'Forest', subtitle, version: '1' });
    store.aso.saveCompetitorSnap(snap('viejo', new Date(Date.now() - 20 * 86_400_000).toISOString()));
    store.aso.saveCompetitorSnap(snap('nuevo', new Date(Date.now() - 2 * 86_400_000).toISOString()));
    const p = store.aso.addProposal({ projectId: 'demo', storeId: 'es', kind: 'follow', payload: { keyword: 'mala idea' }, why: 'x', taskId: null })!;
    store.aso.decideProposal(p.id, 'rejected');
    const cp = store.aso.addProposal({ projectId: 'demo', storeId: null, kind: 'competitor', payload: { appId: '777', name: 'Opal' }, why: 'x', taskId: null })!;
    store.aso.decideProposal(cp.id, 'rejected');
    const out = asoContext(store, project, { es: ficha }, new Date());
    expect(out).toContain('Competidores rechazados');
    expect(out).toContain('Opal (777)');
    expect(out).toContain('detox digital');
    expect(out).toContain('viejo');
    expect(out).toContain('nuevo');
    expect(out).toContain('mala idea');
  });

  afterEach(() => { vi.useRealTimers(); });

  it('pasa las 50 candidatas más nuevas', () => {
    const store = new Store(':memory:');
    vi.useFakeTimers();
    for (let i = 0; i < 60; i++) {
      vi.setSystemTime(new Date(NOW.getTime() - (60 - i) * 60_000));
      store.aso.addCandidate('demo', 'es', `cand${String(i).padStart(2, '0')}`);
    }
    vi.useRealTimers();
    const out = asoContext(store, project, { es: ficha }, NOW);
    expect(out).toContain('- cand59');
    expect(out).toContain('- cand10');
    expect(out).not.toContain('- cand09');
  });

  it('un subtítulo null intermitente no es un cambio; A → null → B sí lo es', () => {
    const store = new Store(':memory:');
    const c = store.aso.addCompetitor('demo', '999', 'Forest');
    const snap = (subtitle: string | null, d: number) => ({ competitorId: c.id, storeId: 'es', takenAt: new Date(NOW.getTime() - d * 86_400_000).toISOString(), name: 'Forest', subtitle, version: '1' });
    for (const [sub, d] of [['A', 5], [null, 4], ['A', 3]] as const) store.aso.saveCompetitorSnap(snap(sub, d));
    expect(asoContext(store, project, { es: ficha }, NOW)).toContain('### Cambios de competidores de los últimos 7 días\n(ninguno)');
    store.aso.saveCompetitorSnap(snap(null, 2));
    store.aso.saveCompetitorSnap(snap('B', 1));
    const out = asoContext(store, project, { es: ficha }, NOW);
    expect(out).toContain('subtítulo «A» → «B»');
    expect(out).not.toContain('«»');
  });

  it('una ficha sustituida no sale como rechazada', () => {
    const store = new Store(':memory:');
    const f = { projectId: 'demo', storeId: 'es', kind: 'ficha' as const, payload: { name: 'Sustituida' }, why: 'x', taskId: null };
    store.aso.addProposal(f);
    store.aso.addProposal({ ...f, payload: { name: 'Nueva' } });
    expect(asoContext(store, project, { es: ficha }, NOW)).not.toContain('Sustituida');
  });
});
