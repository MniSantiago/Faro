import { describe, expect, it } from 'vitest';
import { contextLevel, formatTokens, formatUsd } from '../src/web/format';

describe('formatUsd', () => {
  it('coma decimal, aproximado o parcial', () => {
    expect(formatUsd(1.5155844)).toBe('≈ 1,52 $');
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(0.5, true)).toBe('≥ 0,50 $');
    expect(formatUsd(0)).toBe('≈ 0,00 $');
  });
});

describe('formatTokens', () => {
  it('k y M redondeados', () => {
    expect(formatTokens(56788)).toBe('57 k');
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(200000)).toBe('200 k');
    expect(formatTokens(1000000)).toBe('1 M');
    expect(formatTokens(999600)).toBe('1 M');
    expect(formatTokens(1500000)).toBe('1,5 M');
  });
});

describe('contextLevel', () => {
  it('verde < 60 %, ámbar < 85 %, roja ≥ 85 %', () => {
    expect(contextLevel(119999, 200000)).toBe('ok');
    expect(contextLevel(120000, 200000)).toBe('warn');
    expect(contextLevel(169999, 200000)).toBe('warn');
    expect(contextLevel(170000, 200000)).toBe('high');
    expect(contextLevel(null, 200000)).toBeNull();
    expect(contextLevel(1000, 0)).toBeNull();
  });
});
