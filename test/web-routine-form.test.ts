import { describe, expect, it } from 'vitest';
import { formFromRoutine, sameForm, switchKind, toBody, type RoutineFormState } from '../src/web/routine-form';

const fromFile = {
  name: 'Resumen', title: 'Resumen {fecha}', prompt: '\n  Resume…\n', cron: '*/15 * * * *', profileId: 'dev', level: 1 as const,
  context: 'estado' as const, maxBudgetUsd: 1.5,
};

describe('formulario de rutina', () => {
  it('sin tocar no hay cambios, y el cuerpo devuelve lo mismo que vino', () => {
    const base = formFromRoutine(fromFile, true);
    const copia: RoutineFormState = { ...base, schedule: { ...base.schedule } };
    expect(sameForm(copia, base)).toBe(true);
    const b = toBody(copia);
    expect(b).toEqual({ ok: true, body: { ...fromFile, maxBudgetUsd: 1.5 } });
    expect(copia.budget).toBe('1,5');
  });

  it('el mismo horario con las claves en otro orden no cuenta como cambio', () => {
    const base = formFromRoutine({ ...fromFile, cron: '0 11 * * 2,5' }, false);
    expect(sameForm({ ...base, schedule: { minute: 0, hour: 11, days: [2, 5], kind: 'weekly' } }, base)).toBe(true);
    // Ir a «Personalizado» pasa el cron actual, y volver desde ahí lo recupera.
    expect(sameForm({ ...base, schedule: switchKind(switchKind(base.schedule, 'custom'), 'weekly') }, base)).toBe(true);
    expect(switchKind(base.schedule, 'custom')).toEqual({ kind: 'custom', cron: '0 11 * * 2,5' });
  });

  it('cualquier cambio sí cuenta; un tope de gasto inválido no se manda', () => {
    const base = formFromRoutine({ ...fromFile, cron: undefined, maxBudgetUsd: undefined, context: undefined }, false);
    expect(base.schedule).toEqual({ kind: 'manual' });
    expect(toBody(base)).toMatchObject({ ok: true, body: { cron: null, context: null, maxBudgetUsd: null } });
    expect(sameForm({ ...base, level: 2 }, base)).toBe(false);
    expect(sameForm({ ...base, enabled: true }, base)).toBe(false);
    expect(toBody({ ...base, budget: '0' })).toEqual({ ok: false, error: 'El tope de gasto debe ser un número mayor que 0' });
    expect(toBody({ ...base, schedule: { kind: 'weekly', days: [], hour: 9, minute: 0 } })).toEqual({ ok: false, error: 'Elige al menos un día de la semana' });
  });
});
