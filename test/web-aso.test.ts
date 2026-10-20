import { describe, expect, it } from 'vitest';
import { charCount, competitorChanges, formatDelta, formatRank, showSubtitle, sortKeywords, type KeywordRow } from '../src/web/aso';

const row = (text: string, over: Partial<KeywordRow> = {}): KeywordRow => ({
  id: 1, text, source: 'user', inFicha: false, popularity: 50, difficulty: 50, opportunity: 50, rank: 10, rankDelta7: null, takenAt: null, ok: true, ...over,
});

describe('sortKeywords', () => {
  const rows = [
    row('a', { opportunity: 10, popularity: 80, difficulty: 20, rank: 5 }),
    row('b', { opportunity: 90, popularity: 20, difficulty: 90, rank: null }),
    row('c', { opportunity: null, popularity: null, difficulty: null, rank: 2 }),
    row('d', { opportunity: 40, popularity: 50, difficulty: 50, rank: 30 }),
  ];
  const names = (by: Parameters<typeof sortKeywords>[1]) => sortKeywords(rows, by).map((r) => r.text);

  it('oportunidad descendente, sin datos al final', () => expect(names('oportunidad')).toEqual(['b', 'd', 'a', 'c']));
  it('popularidad descendente', () => expect(names('popularidad')).toEqual(['a', 'd', 'b', 'c']));
  it('dificultad ascendente (la fácil primero)', () => expect(names('dificultad')).toEqual(['a', 'd', 'b', 'c']));
  it('puesto ascendente con los null al final', () => expect(names('puesto')).toEqual(['c', 'a', 'd', 'b']));
  it('no muta la lista original', () => { sortKeywords(rows, 'puesto'); expect(rows.map((r) => r.text)).toEqual(['a', 'b', 'c', 'd']); });
});

describe('formatRank / formatDelta', () => {
  it('formatRank', () => { expect(formatRank(null)).toBe('—'); expect(formatRank(7)).toBe('7'); });
  it('formatDelta: null, empeora (puesto sube) y mejora', () => {
    expect(formatDelta(null)).toBe('—');
    expect(formatDelta(12)).toBe('↓ 12');
    expect(formatDelta(-3)).toBe('↑ 3');
    expect(formatDelta(12.4)).toBe('↓ 12');
    expect(formatDelta(0)).toBe('=');
  });
});

describe('charCount', () => {
  it('cuenta y marca el exceso', () => {
    expect(charCount('a'.repeat(31), 30)).toEqual({ n: 31, over: true });
    expect(charCount('a'.repeat(30), 30)).toEqual({ n: 30, over: false });
    expect(charCount('', 100)).toEqual({ n: 0, over: false });
  });
});

describe('competitorChanges', () => {
  const snap = (d: number, subtitle: string | null, version = '1', name = 'Opal') => ({ takenAt: `2026-10-${String(d).padStart(2, '0')}T00:00:00.000Z`, name, subtitle, version });
  it('un subtítulo null intermitente no es un cambio y se muestra como desconocido', () => {
    expect(competitorChanges([snap(3, 'A'), snap(2, null), snap(1, 'A')])).toEqual([]);
    expect(showSubtitle(null)).toBe('desconocido');
  });
  it('A → null → B es un cambio de subtítulo', () => {
    expect(competitorChanges([snap(3, 'B'), snap(2, null), snap(1, 'A')])).toEqual([{ takenAt: snap(3, 'B').takenAt, text: 'subtítulo «A» → «B»' }]);
  });
  it('los cambios de solo versión salen en la lista', () => {
    expect(competitorChanges([snap(2, 'A', '2.0'), snap(1, 'A', '1.9')])).toEqual([{ takenAt: snap(2, 'A').takenAt, text: 'versión 1.9 → 2.0' }]);
  });
  it('nombre y subtítulo a la vez', () => {
    expect(competitorChanges([snap(2, 'B', '1', 'Opal 2'), snap(1, 'A')])[0]!.text).toBe('nombre «Opal» → «Opal 2»; subtítulo «A» → «B»');
  });
});
