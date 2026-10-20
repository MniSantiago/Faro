import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, getProfile, getProject, loadConfig, normalizeConfig } from '../src/server/config';
import type { FaroConfig, RoutineConfig } from '../src/server/types';

const base = (): FaroConfig => ({
  host: '127.0.0.1',
  port: 3200,
  dataDir: '~/.faro',
  claudeBin: 'claude',
  maxConcurrentRuns: 2,
  projects: [{
    id: 'demo', name: 'Demo', prefix: 'DEM', repoPath: '~/code/demo', baseBranch: 'main',
    remote: 'origin', worktreesDir: '~/.faro/worktrees/demo', startNumber: 9, prepare: [], checks: [],
  }],
  profiles: [{ id: 'ios', name: 'iOS', instructions: 'x', defaultLevel: 2, timeoutMinutes: 45 }],
});

describe('normalizeConfig', () => {
  it('expande ~ en las rutas', () => {
    const c = normalizeConfig(base());
    expect(c.dataDir).toBe(path.join(os.homedir(), '.faro'));
    expect(c.projects[0].repoPath).toBe(path.join(os.homedir(), 'code/demo'));
    expect(c.projects[0].worktreesDir).toBe(path.join(os.homedir(), '.faro/worktrees/demo'));
  });

  it('rechaza prefijos duplicados', () => {
    const raw = base();
    raw.projects.push({ ...raw.projects[0], id: 'otro' });
    expect(() => normalizeConfig(raw)).toThrow(ConfigError);
  });

  it('rechaza niveles por defecto inválidos', () => {
    const raw = base();
    (raw.profiles[0] as { defaultLevel: number }).defaultLevel = 7;
    expect(() => normalizeConfig(raw)).toThrow(/Nivel inválido/);
  });

  it('rechaza tiempos máximos no positivos', () => {
    const raw = base();
    raw.profiles[0].timeoutMinutes = 0;
    expect(() => normalizeConfig(raw)).toThrow(ConfigError);
  });

  it('getProject y getProfile lanzan ConfigError si no existen', () => {
    const c = normalizeConfig(base());
    expect(getProject(c, 'demo').prefix).toBe('DEM');
    expect(getProfile(c, 'ios').name).toBe('iOS');
    expect(() => getProject(c, 'nada')).toThrow(ConfigError);
    expect(() => getProfile(c, 'nada')).toThrow(ConfigError);
  });

  it('rutinas: id único, perfil existente, nivel y cron válidos', () => {
    const b = base();
    const withR = (routines: RoutineConfig[]) => normalizeConfig({ ...b, projects: [{ ...b.projects[0], routines }] });
    const ok: RoutineConfig = { id: 'r', name: 'R', cron: '0 9 * * 1', profileId: b.profiles[0].id, level: 1, title: 'T', prompt: 'P' };
    expect(() => withR([ok])).not.toThrow();
    expect(() => withR([ok, ok])).toThrow('Rutina duplicada: r');
    expect(() => withR([{ ...ok, profileId: 'nadie' }])).toThrow('perfil desconocido');
    expect(() => withR([{ ...ok, cron: 'cada lunes' }])).toThrow('cron inválido');
    expect(() => withR([{ ...ok, level: 5 as never }])).toThrow('Nivel inválido');
    expect(() => withR([{ ...ok, context: 'metrics' }])).not.toThrow();
    expect(() => withR([{ ...ok, context: 'otra' as never }])).toThrow('context debe ser «metrics», «estado» o «aso»');
  });

  it('release: completo, y las rutinas con release exigen que el proyecto lo tenga', () => {
    const b = base();
    const rel = { cwd: 'app', build: 'b', submit: 's {buildId}' };
    const withP = (release: unknown, routineRelease?: 'build') => normalizeConfig({
      ...b,
      projects: [{
        ...b.projects[0], release: release as never,
        routines: routineRelease ? [{ id: 'r', name: 'R', profileId: 'ios', level: 1, title: 'T', prompt: 'P', release: routineRelease }] : [],
      }],
    });
    expect(() => withP(rel, 'build')).not.toThrow();
    expect(() => withP({ ...rel, build: ' ' })).toThrow('release incompleto');
    expect(() => withP(undefined, 'build')).toThrow('pide release');
  });
});

describe('perfiles configurables', () => {
  it('coordinatorProfile y github.ciProfile deben ser perfiles existentes', () => {
    const c = base();
    const id = c.profiles[0].id;
    expect(() => normalizeConfig({ ...c, coordinatorProfile: id, projects: [{ ...c.projects[0], github: { ciProfile: id } }] })).not.toThrow();
    expect(() => normalizeConfig({ ...c, coordinatorProfile: 'nadie' })).toThrow('coordinatorProfile: perfil desconocido nadie');
    expect(() => normalizeConfig({ ...c, projects: [{ ...c.projects[0], github: { ciProfile: 'nadie' } }] })).toThrow('github.ciProfile: perfil desconocido nadie');
  });
});

describe('metrics', () => {
  it('rechaza un posthogHost que no sea https y valores vacíos', () => {
    const c = base();
    c.projects[0].metrics = { posthogHost: 'http://eu.posthog.com' };
    expect(() => normalizeConfig(c)).toThrow(/posthogHost/);
    c.projects[0].metrics = { posthogHost: 'https://eu.posthog.com', ascAppId: '' };
    expect(() => normalizeConfig(c)).toThrow(/ascAppId/);
    c.projects[0].metrics = { posthogProjectID: '1' } as never;
    expect(() => normalizeConfig(c)).toThrow(/posthogProjectID/);
  });

  it('valida el embudo de PostHog', () => {
    const c = base();
    const withFunnel = (posthogFunnel: unknown) => { c.projects[0].metrics = { posthogFunnel } as never; return () => normalizeConfig(c); };
    const steps = [{ event: 'a', label: 'A' }, { event: 'b', label: 'B' }];
    expect(withFunnel({ steps, conversion: { from: 'a', to: 'b', label: 'A → B' }, filter: "x = 'y'" })).not.toThrow();
    expect(withFunnel({ steps: [] })).toThrow('posthogFunnel.steps debe tener al menos una etapa');
    expect(withFunnel({ steps: [{ event: "a' OR 1", label: 'A' }] })).toThrow(/solo admite letras/);
    expect(withFunnel({ steps: [...steps, { event: 'a', label: 'A2' }] })).toThrow('repite el evento «a»');
    expect(withFunnel({ steps: [{ event: 'a', label: '' }] })).toThrow(/label/);
    expect(withFunnel({ steps, conversion: { from: 'a', to: 'z', label: 'X' } })).toThrow(/conversion.from y conversion.to/);
    expect(withFunnel({ steps, filter: ' ' })).toThrow(/filter/);
  });

  it('contextWindow del proyecto: se acepta un entero positivo y se rechaza lo demás', () => {
    const c = base();
    c.projects[0].contextWindow = 1_000_000;
    expect(normalizeConfig(c).projects[0].contextWindow).toBe(1_000_000);
    c.projects[0].contextWindow = 0;
    expect(() => normalizeConfig(c)).toThrow(/contextWindow/);
    c.projects[0].contextWindow = '200000' as never;
    expect(() => normalizeConfig(c)).toThrow(/contextWindow/);
  });
});

describe('aso', () => {
  const store = { id: 'es', country: 'es', storefront: '143454-8,29', fichaFile: 'FICHA_APP_STORE.md' };
  const withAso = (aso: unknown) => {
    const c = base();
    c.projects[0] = { ...c.projects[0], id: 'demo', aso: aso as never };
    return normalizeConfig(c);
  };
  it('acepta una configuración válida', () => {
    expect(() => withAso({ appId: '1234567890', stores: [store] })).not.toThrow();
  });
  it.each([
    ['appId no numérico', { appId: 'abc', stores: [store] }],
    ['stores vacío', { appId: '1', stores: [] }],
    ['ids repetidos', { appId: '1', stores: [store, store] }],
    ['country en mayúsculas', { appId: '1', stores: [{ ...store, country: 'ES' }] }],
    ['country de 3 letras', { appId: '1', stores: [{ ...store, country: 'esp' }] }],
    ['fichaFile absoluto', { appId: '1', stores: [{ ...store, fichaFile: '/etc/x.md' }] }],
    ['fichaFile con ..', { appId: '1', stores: [{ ...store, fichaFile: '../x.md' }] }],
  ])('rechaza %s', (_n, aso) => {
    expect(() => withAso(aso)).toThrow(/^Proyecto demo: aso\./);
  });
  it('una rutina con context aso exige el bloque aso del proyecto', () => {
    const b = base();
    const routine: RoutineConfig = { id: 'x', name: 'X', profileId: 'ios', level: 1, title: 'T', prompt: 'P', context: 'aso' };
    expect(() => normalizeConfig({ ...b, projects: [{ ...b.projects[0], routines: [routine] }] }))
      .toThrow('Rutina x: context «aso» necesita el bloque aso del proyecto');
    expect(() => normalizeConfig({ ...b, projects: [{ ...b.projects[0], aso: { appId: '1', stores: [store] }, routines: [routine] }] })).not.toThrow();
  });
});

describe('faro.config.example.ts', () => {
  it('es una config válida con el proyecto demo', async () => {
    const c = await loadConfig(path.resolve('faro.config.example.ts'));
    const demo = getProject(c, 'demo');
    expect(demo.prefix).toBe('DEM');
    expect(demo.routines?.every((r) => c.profiles.some((p) => p.id === r.profileId))).toBe(true);
  });
  it('sin config, el error dice cómo crearla', async () => {
    await expect(loadConfig(path.resolve('no-existe.config.ts'))).rejects.toThrow('faro.config.example.ts');
  });
});
