import { describe, expect, it } from 'vitest';
import { cronFromSchedule, scheduleError, scheduleFromCron } from '../src/web/schedule';

describe('scheduleFromCron', () => {
  it('sin cron → manual → null', () => {
    expect(scheduleFromCron(null)).toEqual({ kind: 'manual' });
    expect(cronFromSchedule({ kind: 'manual' })).toBeNull();
  });

  it('cada día', () => {
    expect(scheduleFromCron('0 9 * * *')).toEqual({ kind: 'daily', hour: 9, minute: 0 });
    expect(cronFromSchedule({ kind: 'daily', hour: 9, minute: 0 })).toBe('0 9 * * *');
  });

  it('cada semana con varios días', () => {
    expect(scheduleFromCron('0 11 * * 2,5')).toEqual({ kind: 'weekly', days: [2, 5], hour: 11, minute: 0 });
    expect(cronFromSchedule({ kind: 'weekly', days: [2, 5], hour: 11, minute: 0 })).toBe('0 11 * * 2,5');
    // Los días se ordenan y no se repiten.
    expect(cronFromSchedule({ kind: 'weekly', days: [5, 2, 5], hour: 11, minute: 0 })).toBe('0 11 * * 2,5');
  });

  it('cada mes', () => {
    expect(scheduleFromCron('0 10 1 * *')).toEqual({ kind: 'monthly', day: 1, hour: 10, minute: 0 });
    expect(cronFromSchedule({ kind: 'monthly', day: 1, hour: 10, minute: 0 })).toBe('0 10 1 * *');
  });

  it('lo que el selector no representa → personalizado con el mismo cron', () => {
    for (const cron of ['*/15 * * * *', '0 9 * * 1-5', '0 09 * * *', '0 9 * * 5,2', '0 9 * * 7', '0 9 1 * 1', '0 9 * 1 *', '30 25 * * *', '0 9 32 * *', '0 0 * * * *']) {
      expect(scheduleFromCron(cron)).toEqual({ kind: 'custom', cron });
    }
  });

  it('ida y vuelta sin cambios', () => {
    for (const cron of [null, '0 9 * * *', '30 7 * * *', '0 11 * * 2,5', '0 9 * * 1', '0 10 1 * *', '45 23 31 * *', '*/15 * * * *', '0 09 * * *']) {
      expect(cronFromSchedule(scheduleFromCron(cron))).toBe(cron);
    }
  });
});

describe('scheduleError', () => {
  it('pide al menos un día, un día del mes válido y un cron', () => {
    expect(scheduleError({ kind: 'weekly', days: [], hour: 9, minute: 0 })).toBe('Elige al menos un día de la semana');
    expect(scheduleError({ kind: 'monthly', day: 0, hour: 9, minute: 0 })).toBe('El día del mes va del 1 al 31');
    expect(scheduleError({ kind: 'custom', cron: '  ' })).toBe('Escribe el cron');
    expect(scheduleError({ kind: 'daily', hour: 24, minute: 0 })).toBe('Hora no válida');
    expect(scheduleError({ kind: 'daily', hour: 9, minute: 0 })).toBeNull();
    expect(scheduleError({ kind: 'manual' })).toBeNull();
  });
});
