import { beforeEach, describe, expect, it } from 'vitest';
import { competitorAlerts, rankAlerts, rankMessage } from '../src/server/aso/alerts';
import { fichaWords } from '../src/server/aso/ficha';
import { Store } from '../src/server/store';

const NOW = new Date('2026-10-20T08:00:00Z');
const words = fichaWords({ name: 'Demo', subtitle: null, keywords: 'bloquear,apps' });
let store: Store;
let kw: number;

function obs(daysAgo: number, rank: number | null, ok = true) {
  store.aso.addObservation({
    keywordId: kw, takenAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(), ok,
    popularity: 10, difficulty: 10, rank, error: null,
  });
}
const series = (prior: (number | null)[], today: number | null) => {
  prior.forEach((r, i) => obs(prior.length - i, r));
  obs(0, today);
};

beforeEach(() => {
  store = new Store(':memory:');
  kw = store.aso.addKeyword('demo', 'es', 'bloquear', 'user').id;
});

describe('rankAlerts', () => {
  it('sin historia no avisa', () => {
    obs(0, 50);
    expect(rankAlerts(store.aso, 'demo', 'es', words, NOW)).toEqual([]);
  });
  it('de 8 a 15 avisa (sale del top 10)', () => {
    series([8, 8, 8], 15);
    expect(rankAlerts(store.aso, 'demo', 'es', words, NOW)).toEqual([{ keyword: 'bloquear', from: 8, to: 15 }]);
  });
  it('de 30 a 35 con media de 28 no avisa', () => {
    series([27, 28, 29, 30], 35);
    expect(rankAlerts(store.aso, 'demo', 'es', words, NOW)).toEqual([]);
  });
  it('de 30 a 41 con media de 30 avisa', () => {
    series([30, 30, 30], 41);
    expect(rankAlerts(store.aso, 'demo', 'es', words, NOW)).toEqual([{ keyword: 'bloquear', from: 30, to: 41 }]);
  });
  it('de 5 a null avisa', () => {
    series([5, 5, 5], null);
    expect(rankAlerts(store.aso, 'demo', 'es', words, NOW)).toEqual([{ keyword: 'bloquear', from: 5, to: null }]);
  });
  it('una keyword que no está en la ficha no avisa', () => {
    const other = store.aso.addKeyword('demo', 'es', 'meditar', 'user').id;
    for (const [d, r] of [[3, 5], [2, 5], [1, 5], [0, null]] as const) {
      store.aso.addObservation({ keywordId: other, takenAt: new Date(NOW.getTime() - d * 86_400_000).toISOString(), ok: true, popularity: 1, difficulty: 1, rank: r, error: null });
    }
    expect(rankAlerts(store.aso, 'demo', 'es', words, NOW)).toEqual([]);
  });
  it('una observación de hoy con error no avisa', () => {
    series([5, 5, 5], 5);
    obs(0, null, false);
    expect(rankAlerts(store.aso, 'demo', 'es', words, NOW)).toEqual([]);
  });
});

describe('rankAlerts · un día cuenta una vez', () => {
  it('tres actualizaciones el mismo día no cumplen el mínimo de 3 días previos', () => {
    for (const h of [9, 12, 15]) {
      store.aso.addObservation({ keywordId: kw, takenAt: new Date(NOW.getTime() - 86_400_000 - h * 600_000).toISOString(), ok: true, popularity: 10, difficulty: 10, rank: 5, error: null });
    }
    obs(0, 40);
    expect(store.aso.observations(kw, '2000-01-01')).toHaveLength(2);
    expect(rankAlerts(store.aso, 'demo', 'es', words, NOW)).toEqual([]);
  });
});

describe('textos', () => {
  it('una caída y varias', () => {
    expect(rankMessage('Demo', [{ keyword: 'bloquear', from: 8, to: null, storeId: 'es' }])).toEqual({
      title: 'Demo baja en «bloquear» (es)', body: 'Del 8 al —', url: '/#/aso',
    });
    expect(rankMessage('Demo', [
      { keyword: 'a', from: 1, to: 20, storeId: 'es' }, { keyword: 'b', from: 2, to: 30, storeId: 'es-MX' },
    ])!.title).toBe('Demo baja en 2 keywords (es, es-MX)');
    expect(rankMessage('Demo', [])).toBeNull();
    expect(rankMessage('Otra', [{ keyword: 'x', from: 1, to: 20, storeId: 'en' }])!.title).toBe('Otra baja en «x» (en)');
  });
  it('competencia', () => {
    expect(competitorAlerts([{ name: 'Opal', storeId: 'es', field: 'subtítulo' }])!.title).toBe('Opal ha cambiado su subtítulo (es)');
    expect(competitorAlerts([
      { name: 'Opal', storeId: 'es', field: 'nombre' }, { name: 'Forest', storeId: 'es', field: 'nombre' },
    ])!.title).toBe('2 cambios en la competencia');
    expect(competitorAlerts([])).toBeNull();
  });
});
