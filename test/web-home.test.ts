import { describe, expect, it } from 'vitest';
import { dayLabel, deltaTone, formatDelta, niceTicks, rowFormat, sparkPath } from '../src/web/home';

describe('sparkPath', () => {
  it('serie vacía (o solo sin datos) → sin trazo', () => {
    expect(sparkPath([], 100, 20)).toBe('');
    expect(sparkPath([null, null], 100, 20)).toBe('');
  });

  it('valores iguales → línea horizontal en el centro', () => {
    expect(sparkPath([5, 5, 5], 100, 20)).toBe('M0,10L50,10L100,10');
  });

  it('de izquierda a derecha y con el máximo arriba', () => {
    expect(sparkPath([0, 10], 100, 20)).toBe('M0,20L100,0');
  });

  it('un null en medio parte la línea en dos tramos', () => {
    const d = sparkPath([1, 3, null, 3, 1], 100, 20);
    expect(d).toBe('M0,20L25,0M75,0L100,20');
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it('un punto suelto entre huecos se ve (tramo de un solo punto)', () => {
    expect(sparkPath([null, 4, null], 100, 20)).toBe('M50,10h0');
  });
});

describe('deltaTone', () => {
  it('sube y subir es bueno → ok', () => expect(deltaTone(12, true)).toBe('ok'));
  it('sube y subir es malo (gasto) → bad', () => expect(deltaTone(12, false)).toBe('bad'));
  it('baja: al revés', () => {
    expect(deltaTone(-5, true)).toBe('bad');
    expect(deltaTone(-5, false)).toBe('ok');
  });
  it('null o 0 → muted', () => {
    expect(deltaTone(null, true)).toBe('muted');
    expect(deltaTone(0, false)).toBe('muted');
    // Lo que se pinta como «0 %» también va apagado.
    expect(deltaTone(0.04, true)).toBe('muted');
  });
});

describe('formatDelta', () => {
  it('flecha y una décima; null sin referencia', () => {
    expect(formatDelta(12.46)).toBe('▲ 12,5 %');
    expect(formatDelta(-3)).toBe('▼ 3 %');
    expect(formatDelta(0.01)).toBe('0 %');
    expect(formatDelta(null)).toBeNull();
  });
});

describe('rowFormat', () => {
  it('dinero en gasto y en el MRR; enteros en descargas, pruebas y suscripciones', () => {
    expect(rowFormat('gasto', 'Coste medio por ejecución')).toBe('money');
    expect(rowFormat('mrr', 'MRR')).toBe('money');
    expect(rowFormat('mrr', 'Pruebas activas')).toBe('int');
    expect(rowFormat('descargas', 'ES')).toBe('int');
  });
});

describe('niceTicks', () => {
  it('marcas redondas que cubren el rango', () => {
    expect(niceTicks(0, 37)).toEqual([0, 10, 20, 30, 40]);
    expect(niceTicks(0.031, 0.062)).toEqual([0.03, 0.04, 0.05, 0.06, 0.07]);
  });
  it('serie plana: en 0, de 0 a 1; si no, un poco abierta', () => {
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    const t = niceTicks(50, 50);
    expect(t[0]).toBeLessThan(50);
    expect(t.at(-1)).toBeGreaterThan(50);
  });
});

describe('dayLabel', () => {
  it('día y mes corto', () => expect(dayLabel('2026-10-20')).toBe('20 oct'));
});
