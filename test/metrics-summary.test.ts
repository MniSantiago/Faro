import { describe, expect, it } from 'vitest';
import { buildCards, metricsContext } from '../src/server/metrics/summary';
import { formatValue } from '../src/shared/format';
import { Store } from '../src/server/store';

const NOW = new Date('2026-10-15T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('buildCards', () => {
  it('calcula deltaPct contra la foto de hace 7 días', () => {
    const s = new Store(':memory:');
    s.addSnapshot('p', 'revenuecat', true, { mrr: 100, active_trials: 5, active_subscriptions: 10 }, null, daysAgo(7));
    s.addSnapshot('p', 'revenuecat', true, { mrr: 125, active_trials: 5, active_subscriptions: 8 }, null, NOW);
    const cards = buildCards(s, 'p', NOW);
    expect(cards.find((c) => c.id === 'mrr')).toMatchObject({ value: 125, format: 'money', deltaPct: 25, source: 'revenuecat', takenAt: NOW.toISOString() });
    expect(cards.find((c) => c.id === 'active_trials')?.deltaPct).toBe(0);
    expect(cards.find((c) => c.id === 'active_subscriptions')?.deltaPct).toBe(-20);
  });

  it('sin foto vieja (solo la actual) el delta es null; sin datos no hay tarjetas', () => {
    const s = new Store(':memory:');
    expect(buildCards(s, 'p', NOW)).toEqual([]);
    s.addSnapshot('p', 'revenuecat', true, { mrr: 100 }, null, NOW);
    expect(buildCards(s, 'p', NOW).find((c) => c.id === 'mrr')?.deltaPct).toBeNull();
  });

  it('la referencia debe caer a ±1,5 días de hace 7 días', () => {
    const mk = (age: number) => {
      const s = new Store(':memory:');
      s.addSnapshot('p', 'revenuecat', true, { mrr: 100 }, null, daysAgo(age));
      s.addSnapshot('p', 'revenuecat', true, { mrr: 110 }, null, NOW);
      return buildCards(s, 'p', NOW).find((c) => c.id === 'mrr')?.deltaPct;
    };
    expect(mk(2)).toBeNull();
    expect(mk(6.5)).toBeCloseTo(10);
    expect(mk(9)).toBeNull();
  });

  it('referencia vieja a 0 o valor de texto: delta null', () => {
    const s = new Store(':memory:');
    s.addSnapshot('p', 'revenuecat', true, { mrr: 0 }, null, daysAgo(7));
    s.addSnapshot('p', 'revenuecat', true, { mrr: 10 }, null, NOW);
    s.addSnapshot('p', 'appstore', true, { review_state: 'READY' }, null, daysAgo(7));
    s.addSnapshot('p', 'appstore', true, { review_state: 'WAITING_FOR_REVIEW', rating: 4.5 }, null, NOW);
    const cards = buildCards(s, 'p', NOW);
    expect(cards.find((c) => c.id === 'mrr')?.deltaPct).toBeNull();
    expect(cards.find((c) => c.id === 'review_state')).toMatchObject({ value: 'WAITING_FOR_REVIEW', format: 'text', deltaPct: null });
    expect(cards.find((c) => c.id === 'rating')).toMatchObject({ value: 4.5, format: 'rating' });
  });

  it('sin valoraciones (rating_count 0): «Sin valoraciones» en vez de 0,0, también en el contexto', () => {
    const s = new Store(':memory:');
    s.addSnapshot('p', 'appstore', true, { rating: 0, rating_count: 0 }, null, daysAgo(7));
    s.addSnapshot('p', 'appstore', true, { rating: 0, rating_count: 0, version: '1.0.2' }, null, NOW);
    const c = buildCards(s, 'p', NOW).find((x) => x.id === 'rating')!;
    expect(c).toMatchObject({ value: 'Sin valoraciones', format: 'text', deltaPct: null });
    expect(formatValue(c.value, c.format)).toBe('Sin valoraciones');
    const t = metricsContext(s, 'p', NOW)!;
    expect(t).toContain('Valoración: Sin valoraciones');
    expect(t).not.toContain('0,0');
    expect(t).not.toContain('0 valoraciones');
  });

  it('si la última foto de la fuente es un error, usa la última correcta', () => {
    const s = new Store(':memory:');
    s.addSnapshot('p', 'posthog', true, { conversion_paywall_compra: 0.1 }, null, daysAgo(1));
    s.addSnapshot('p', 'posthog', false, {}, 'PostHog respondió 500', NOW);
    const c = buildCards(s, 'p', NOW).find((x) => x.id === 'conversion_paywall_compra');
    expect(c).toMatchObject({ value: 0.1, format: 'percent', takenAt: daysAgo(1).toISOString() });
  });
});

describe('metricsContext', () => {
  it('añade descargas, valoraciones, versión y aviso de foto antigua', () => {
    const s = new Store(':memory:');
    s.addSnapshot('p', 'appstore', true, { rating: 4.6, rating_count: 23, version: '1.0.2', downloads: 8 }, null, daysAgo(4));
    const t = metricsContext(s, 'p', NOW)!;
    expect(t).toContain('descargas del último informe 8');
    expect(t).toContain('23 valoraciones');
    expect(t).toContain('versión pública 1.0.2');
    expect(t).toContain('(foto de hace 4 días)');
  });

  it('incluye MRR y conversión con su tendencia; null sin fotos', () => {
    const s = new Store(':memory:');
    expect(metricsContext(s, 'p', NOW)).toBeNull();
    s.addSnapshot('p', 'revenuecat', true, { mrr: 100 }, null, daysAgo(7));
    s.addSnapshot('p', 'revenuecat', true, { mrr: 125 }, null, NOW);
    s.addSnapshot('p', 'posthog', true, { conversion_paywall_compra: 0.1, onboarding_iniciado: 100 }, null, NOW);
    const t = metricsContext(s, 'p', NOW)!;
    expect(t).toMatch(/MRR: 125[,.]00/);
    expect(t).toContain('+25,0 %');
    expect(t).toMatch(/Conversión paywall → compra: 10[,.]0 %/);
    expect(t).toContain('onboarding_iniciado');
  });
});
