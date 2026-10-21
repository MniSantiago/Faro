import { describe, expect, it } from 'vitest';
import { emptyProfileForm, formFromProfile, profileSame, profileToBody } from '../src/web/profile-form';
import { formFromGeneral, formFromProject, generalSame, generalToBody, projectSame, projectToBody } from '../src/web/settings-form';

const profile = { name: 'Dev', instructions: 'Haz…', defaultLevel: 2 as const, model: 'claude-sonnet-5-5', effort: 'high' as const, maxBudgetUsd: 1.5, timeoutMinutes: 30 };

describe('formulario de perfil', () => {
  it('sin tocar no hay cambios y el cuerpo devuelve lo que vino', () => {
    const base = formFromProfile(profile);
    expect(base.budget).toBe('1,5');
    expect(profileSame({ ...base }, base)).toBe(true);
    expect(profileToBody(base)).toEqual({ ok: true, body: profile });
  });

  it('los opcionales vacíos se mandan como null; los inválidos no se mandan', () => {
    const base = formFromProfile({ name: 'A', instructions: 'x', defaultLevel: 1, timeoutMinutes: 10 });
    expect(profileToBody(base)).toEqual({ ok: true, body: { name: 'A', instructions: 'x', defaultLevel: 1, model: null, effort: null, maxBudgetUsd: null, timeoutMinutes: 10 } });
    expect(profileToBody({ ...base, budget: '0' })).toEqual({ ok: false, error: 'El tope de gasto debe ser un número mayor que 0' });
    expect(profileToBody({ ...base, timeout: '' })).toEqual({ ok: false, error: 'El tiempo máximo debe ser un número de minutos mayor que 0' });
    expect(profileToBody({ ...base, name: ' ' })).toEqual({ ok: false, error: 'Falta el nombre' });
    expect(profileToBody({ ...base, instructions: '' })).toEqual({ ok: false, error: 'Faltan las instrucciones' });
    expect(profileSame({ ...base, effort: 'max' }, base)).toBe(false);
    expect(profileSame(emptyProfileForm(), emptyProfileForm())).toBe(true);
  });
});

describe('formulario de proyecto', () => {
  const project = {
    baseBranch: 'main', github: { ci: true, ciProfile: 'dev' }, backlogFile: null, contextWindow: 200000,
    metrics: { posthogHost: 'https://eu.posthog.com', posthogFunnel: { steps: [{ event: 'a', label: 'A' }] } },
  };
  it('manda todos los campos editables y null para los vacíos', () => {
    const f = formFromProject(project);
    expect(projectSame({ ...f }, f)).toBe(true);
    const b = projectToBody(f);
    expect(b).toEqual({
      ok: true,
      body: {
        baseBranch: 'main', github: { ci: true, prs: null, ciProfile: 'dev' }, backlogFile: null, contextWindow: 200000, maxConcurrentRuns: null,
        metrics: {
          revenuecatProjectId: null, posthogHost: 'https://eu.posthog.com', posthogProjectId: null, ascAppId: null, ascVendorNumber: null,
          posthogFunnel: { steps: [{ event: 'a', label: 'A' }] },
        },
      },
    });
  });
  it('agentes a la vez: vacío es el de Faro (null); si no, un entero mayor que 0', () => {
    const f = formFromProject({ baseBranch: 'main', github: null, backlogFile: null, contextWindow: null, maxConcurrentRuns: 3, metrics: null });
    expect(f.maxConcurrent).toBe('3');
    expect(projectToBody(f)).toMatchObject({ ok: true, body: { maxConcurrentRuns: 3 } });
    expect(projectToBody({ ...f, maxConcurrent: '' })).toMatchObject({ ok: true, body: { maxConcurrentRuns: null } });
    expect(projectToBody({ ...f, maxConcurrent: '0' })).toEqual({ ok: false, error: 'Los agentes a la vez deben ser un entero mayor que 0' });
    expect(projectSame({ ...f, maxConcurrent: '4' }, f)).toBe(false);
  });
  it('la ventana de contexto solo admite dígitos', () => {
    const f = formFromProject({ baseBranch: 'main', github: null, backlogFile: null, contextWindow: null, metrics: null });
    for (const bad of ['200.000', '1e5', '2.0', '-5', '0x10']) {
      expect(projectToBody({ ...f, contextWindow: bad })).toEqual({ ok: false, error: 'La ventana de contexto debe ser un entero mayor que 0' });
    }
    expect(projectToBody({ ...f, contextWindow: ' 200000 ' })).toMatchObject({ ok: true, body: { contextWindow: 200000 } });
  });
  it('sin github ni metrics manda null; valida la ventana y el embudo', () => {
    const f = formFromProject({ baseBranch: 'main', github: null, backlogFile: null, contextWindow: null, metrics: null });
    expect(projectToBody(f)).toMatchObject({ ok: true, body: { github: null, metrics: null, contextWindow: null } });
    expect(projectToBody({ ...f, contextWindow: 'abc' })).toEqual({ ok: false, error: 'La ventana de contexto debe ser un entero mayor que 0' });
    expect(projectToBody({ ...f, funnel: '{no' })).toEqual({ ok: false, error: 'El embudo no es un JSON válido' });
    expect(projectSame({ ...f, backlogFile: 'x.md' }, f)).toBe(false);
  });
});

describe('formulario de generales', () => {
  const general = { title: 'Faro', maxConcurrentRuns: 2, coordinatorProfile: 'coordinador', retryWatchdog: { enabled: false, maxWaitMs: 90000 } };
  it('pasa la espera de ms a minutos y vuelta', () => {
    const f = formFromGeneral(general);
    expect(f.maxWait).toBe('1,5');
    expect(generalSame({ ...f }, f)).toBe(true);
    expect(generalToBody(f)).toEqual({
      ok: true,
      body: { title: 'Faro', maxConcurrentRuns: 2, coordinatorProfile: 'coordinador', retryWatchdog: { enabled: false, maxWaitMs: 90000, maxUsageLimitWaitMs: null } },
    });
  });
  it('1000 ms se muestra redondeado pero sin tocar se manda exacto; editado, lo nuevo', () => {
    const f = formFromGeneral({ title: 'Faro', maxConcurrentRuns: 1, coordinatorProfile: 'c', retryWatchdog: { maxWaitMs: 1000, maxUsageLimitWaitMs: 7 } });
    expect(f.maxWait).toBe('0,017');
    expect(generalToBody(f)).toMatchObject({ ok: true, body: { retryWatchdog: { maxWaitMs: 1000, maxUsageLimitWaitMs: 7 } } });
    expect(generalToBody({ ...f, maxWait: '2' })).toMatchObject({ ok: true, body: { retryWatchdog: { maxWaitMs: 120000 } } });
    expect(generalToBody({ ...f, maxConcurrent: '1.5' })).toMatchObject({ ok: false });
  });
  it('sin vigilancia manda null y valida los números', () => {
    const f = formFromGeneral({ title: 'Faro', maxConcurrentRuns: 1, coordinatorProfile: 'c', retryWatchdog: null });
    expect(generalToBody({ ...f, title: '' })).toMatchObject({ ok: true, body: { title: null, retryWatchdog: null } });
    expect(generalToBody({ ...f, maxConcurrent: '0' })).toEqual({ ok: false, error: 'El límite global de agentes debe ser un entero mayor que 0' });
    expect(generalToBody({ ...f, maxConcurrent: '' })).toMatchObject({ ok: true, body: { maxConcurrentRuns: null } });
    expect(generalToBody({ ...f, maxWait: '-1' })).toEqual({ ok: false, error: 'La espera máxima debe ser un número de minutos (0 o más)' });
    expect(generalSame({ ...f, enabled: 'off' }, f)).toBe(false);
  });
});
