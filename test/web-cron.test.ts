import { describe, expect, it } from 'vitest';
import { describeCron } from '../src/web/cron';

describe('describeCron', () => {
  it('casos de las rutinas', () => {
    expect(describeCron('0 9 * * 1')).toBe('lunes a las 9:00');
    expect(describeCron('0 10 * * *')).toBe('todos los días a las 10:00');
    expect(describeCron('0 11 * * 2,5')).toBe('martes y viernes a las 11:00');
    expect(describeCron('0 10 1 * *')).toBe('el día 1 de cada mes a las 10:00');
    expect(describeCron(null)).toBe('solo a mano');
    expect(describeCron('*/5 * * * *')).toBe('*/5 * * * *');
  });
});
