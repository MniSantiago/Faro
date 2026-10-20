import { describe, expect, it } from 'vitest';
import { PREFIX_LENGTHS, difficulty, opportunity, popularity } from '../src/server/aso/scores';

describe('popularity', () => {
  it('0 si no aparece, 100 en el mejor caso', () => {
    expect(popularity(null, 10)).toBe(0);
    expect(popularity({ prefixLen: 2, position: 0 }, 10)).toBe(100);
  });
  it('monótona y siempre ≥ 1 si aparece', () => {
    for (const termLen of [8, 10, 20]) {
      for (let p = 2; p <= 8; p++) {
        for (let pos = 0; pos < 10; pos++) {
          const v = popularity({ prefixLen: p, position: pos }, termLen);
          expect(v).toBeGreaterThanOrEqual(1);
          expect(Number.isInteger(v)).toBe(true);
          if (p < 8) expect(popularity({ prefixLen: p + 1, position: pos }, termLen)).toBeLessThanOrEqual(v);
          if (pos < 9) expect(popularity({ prefixLen: p, position: pos + 1 }, termLen)).toBeLessThanOrEqual(v);
        }
      }
    }
  });
});

describe('difficulty', () => {
  it('0 sin resultados, 100 con gigantes', () => {
    expect(difficulty([])).toBe(0);
    expect(difficulty(Array.from({ length: 10 }, () => ({ ratingCount: 1_000_000, rating: 5 })))).toBe(100);
  });
  it('monótona en valoraciones y nota', () => {
    const d = (n: number, r: number) => difficulty([{ ratingCount: n, rating: r }]);
    expect(d(10, 4)).toBeLessThanOrEqual(d(1000, 4));
    expect(d(1000, 4)).toBeLessThanOrEqual(d(100000, 4));
    expect(d(1000, 3)).toBeLessThanOrEqual(d(1000, 4.5));
  });
});

describe('opportunity', () => {
  it('pop * (100 - diff) / 100', () => {
    expect(opportunity(80, 25)).toBe(60);
  });
});

describe('PREFIX_LENGTHS', () => {
  it('2…min(len, 8) y len si > 8', () => {
    expect(PREFIX_LENGTHS(5)).toEqual([2, 3, 4, 5]);
    expect(PREFIX_LENGTHS(8)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(PREFIX_LENGTHS(10)).toEqual([2, 3, 4, 5, 6, 7, 8, 10]);
  });
});
