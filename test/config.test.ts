import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, getProfile, getProject, isMultiRepo, loadConfig, normalizeConfig } from '../src/server/config';
import type { FaroConfig, FaroConfigInput, RepoConfig, RoutineConfig } from '../src/server/types';

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

  it('perfiles: effort de la lista de la CLI y maxBudgetUsd positivo', () => {
    const withP = (over: object) => normalizeConfig({ ...base(), profiles: [{ ...base().profiles[0], ...over }] });
    expect(() => withP({ effort: 'medium', maxBudgetUsd: 2 })).not.toThrow();
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) expect(() => withP({ effort })).not.toThrow();
    expect(() => withP({ effort: 'mucho' })).toThrow('Perfil ios: effort debe ser low, medium, high, xhigh o max');
    expect(() => withP({ maxBudgetUsd: 0 })).toThrow('Perfil ios: maxBudgetUsd debe ser un número positivo');
    expect(() => withP({ maxBudgetUsd: '2' })).toThrow('maxBudgetUsd');
  });

  it("perfiles: isolation 'minimal' o 'user'", () => {
    const withP = (over: object) => normalizeConfig({ ...base(), profiles: [{ ...base().profiles[0], ...over }] });
    for (const isolation of ['minimal', 'user']) expect(() => withP({ isolation })).not.toThrow();
    expect(() => withP({ isolation: 'todo' })).toThrow("Perfil ios: isolation debe ser 'minimal' o 'user'");
  });

  it('retryWatchdog: esperas enteras no negativas', () => {
    expect(() => normalizeConfig({ ...base(), retryWatchdog: { maxWaitMs: 60_000, maxUsageLimitWaitMs: 0 } })).not.toThrow();
    expect(() => normalizeConfig({ ...base(), retryWatchdog: { maxWaitMs: -1 } })).toThrow('retryWatchdog.maxWaitMs debe ser un entero no negativo');
    expect(() => normalizeConfig({ ...base(), retryWatchdog: { maxUsageLimitWaitMs: 1.5 } })).toThrow('retryWatchdog.maxUsageLimitWaitMs');
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
    expect(() => withR([{ ...ok, maxBudgetUsd: 0.5 }])).not.toThrow();
    expect(() => withR([{ ...ok, maxBudgetUsd: -1 }])).toThrow('Rutina r: maxBudgetUsd debe ser un número positivo');
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
    expect(() => normalizeConfig({ ...c, title: ' ' })).toThrow('title debe ser un texto no vacío');
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

describe('multiproyecto: repos, instrucciones y límite por proyecto', () => {
  const repos = (): RepoConfig[] => [
    { id: 'mobile', path: '~/A', baseBranch: 'main', remote: 'origin', release: { cwd: '.', build: 'b', submit: 's' } },
    { id: 'backend', path: '~/B', baseBranch: 'develop', remote: 'origin' },
  ];
  const multi = (over: object = {}, repoList = repos()): FaroConfigInput => {
    const { repoPath: _r, baseBranch: _b, remote: _o, prepare: _p, checks: _c, ...rest } = base().projects[0];
    return { ...base(), projects: [{ ...rest, repos: repoList, ...over }] };
  };

  it('normaliza un proyecto sin repos a repos: [main]', () => {
    const c = normalizeConfig(base());
    const p = c.projects[0];
    expect(p.repos).toEqual([{ id: 'main', path: p.repoPath, baseBranch: 'main', remote: 'origin', prepare: [], checks: [] }]);
    expect(isMultiRepo(p)).toBe(false);
  });

  it('un proyecto con repos refleja repos[0] en los campos sueltos', () => {
    const p = normalizeConfig(multi()).projects[0];
    expect(p.repoPath).toBe(path.join(os.homedir(), 'A'));
    expect(p.repos![1].path).toBe(path.join(os.homedir(), 'B'));
    expect(p.baseBranch).toBe('main');
    expect(p.remote).toBe('origin');
    expect(p.release).toEqual({ cwd: '.', build: 'b', submit: 's' });
    expect(isMultiRepo(p)).toBe(true);
  });

  it('valida los repos de una rutina contra los del proyecto', () => {
    const rutina = (r: string[]) => ({ id: 'r', name: 'R', profileId: 'ios', level: 1 as const, title: 't', prompt: 'p', repos: r });
    expect(normalizeConfig(multi({ routines: [rutina(['backend'])] })).projects[0].routines![0].repos).toEqual(['backend']);
    expect(() => normalizeConfig(multi({ routines: [rutina(['nope'])] }))).toThrow(/Rutina r: repo desconocido nope/);
    expect(() => normalizeConfig(multi({ routines: [rutina([])] }))).toThrow(/Rutina r: repos necesita/);
  });

  it('rechaza repos y repoPath a la vez', () => {
    const raw = multi();
    (raw.projects[0] as { repoPath?: string }).repoPath = '~/X';
    expect(() => normalizeConfig(raw)).toThrow(/no ambos/);
  });

  it('rechaza repos vacíos e ids de repo repetidos', () => {
    expect(() => normalizeConfig(multi({}, []))).toThrow(/al menos un repo/);
    const dup = repos().map((r) => ({ ...r, id: 'x' }));
    expect(() => normalizeConfig(multi({}, dup))).toThrow(/Repo duplicado/);
  });

  it('rechaza github.prs o github.ci en un proyecto multi-repo', () => {
    const withGh = (github: object) => multi({}, repos().map((r, i) => (i === 0 ? { ...r, github } : r)));
    expect(() => normalizeConfig(withGh({ prs: true }))).toThrow(/varios repos/);
    expect(() => normalizeConfig(withGh({ ci: true }))).toThrow(/varios repos/);
    expect(() => normalizeConfig(withGh({ ciProfile: 'ios' }))).not.toThrow();
  });

  it('rechaza profileNotes de un perfil desconocido', () => {
    expect(() => normalizeConfig(multi({ profileNotes: { ios: 'n' } }))).not.toThrow();
    expect(() => normalizeConfig(multi({ profileNotes: { nope: 'n' } }))).toThrow(/Proyecto demo: profileNotes: perfil desconocido nope/);
  });

  it('copyRootClaudeMd es opcional y booleano', () => {
    expect(() => normalizeConfig(multi({ copyRootClaudeMd: true }))).not.toThrow();
    expect(normalizeConfig(multi({})).projects[0].copyRootClaudeMd).toBeUndefined();
    expect(() => normalizeConfig(multi({ copyRootClaudeMd: 'sí' as unknown as boolean }))).toThrow(/Proyecto demo: copyRootClaudeMd debe ser true o false/);
  });

  it('maxConcurrentRuns global es opcional; el del proyecto debe ser entero ≥ 1', () => {
    const raw = base();
    delete (raw as { maxConcurrentRuns?: number }).maxConcurrentRuns;
    expect(() => normalizeConfig(raw)).not.toThrow();
    for (const bad of [0, 1.5, -1]) {
      const r = base();
      r.projects[0].maxConcurrentRuns = bad;
      expect(() => normalizeConfig(r)).toThrow(/Proyecto demo: maxConcurrentRuns/);
    }
    const ok = base();
    ok.projects[0].maxConcurrentRuns = 3;
    expect(() => normalizeConfig(ok)).not.toThrow();
    const g = base();
    g.maxConcurrentRuns = 0;
    expect(() => normalizeConfig(g)).toThrow(/maxConcurrentRuns/);
  });

  it('una rutina con release y repos sin el repo que se publica es un error de config', () => {
    const routine = (r: object) => ({ id: 'r', name: 'R', profileId: 'ios', level: 1 as const, title: 'T', prompt: 'P', release: 'build' as const, ...r });
    expect(() => normalizeConfig(multi({ routines: [routine({ repos: ['backend'] })] }))).toThrow('Esta tarea no incluye el repo que se publica');
    expect(() => normalizeConfig(multi({ routines: [routine({ repos: ['mobile'] })] }))).not.toThrow();
    expect(() => normalizeConfig(multi({ routines: [routine({})] }))).not.toThrow();
  });

  it('release solo en un repo', () => {
    const two = repos().map((r) => ({ ...r, release: { cwd: '.', build: 'b', submit: 's' } }));
    expect(() => normalizeConfig(multi({}, two))).toThrow(/un solo repo con release/);
  });

  it('valida release incompleto y checks por repo, y expande rootPath', () => {
    const bad = repos();
    bad[0] = { ...bad[0], release: undefined };
    bad[1] = { ...bad[1], release: { cwd: '', build: 'b', submit: 's' } };
    expect(() => normalizeConfig(multi({}, bad))).toThrow(/release incompleto/);
    const withChecks = repos();
    withChecks[0] = { ...withChecks[0], checks: [{ name: 't', command: 'npm test' }] };
    expect(normalizeConfig(multi({}, withChecks)).projects[0].checks).toEqual([{ name: 't', command: 'npm test' }]);
    expect(normalizeConfig(multi({ rootPath: '~/Acme' })).projects[0].rootPath).toBe(path.join(os.homedir(), 'Acme'));
  });

  it('worktreesDir no puede ser ni contener un repo ni rootPath (dentro de ellos sí)', () => {
    const msg = /Proyecto demo: worktreesDir no puede contener un repo ni rootPath/;
    expect(() => normalizeConfig(multi({ worktreesDir: '~/A' }))).toThrow(msg);
    expect(() => normalizeConfig(multi({ worktreesDir: '~' }))).toThrow(msg);
    expect(() => normalizeConfig(multi({ worktreesDir: '~/wt', rootPath: '~/wt/Acme' }))).toThrow(msg);
    expect(() => normalizeConfig(multi({ worktreesDir: '~/Acme', rootPath: '~/Acme' }))).toThrow(msg);
    expect(normalizeConfig(multi({ worktreesDir: '~/B/.wt', rootPath: '~/Acme' })).projects[0].worktreesDir).toBe(path.join(os.homedir(), 'B/.wt'));
    expect(normalizeConfig(multi({ worktreesDir: '~/Acme/.wt', rootPath: '~/Acme' })).projects[0].worktreesDir).toBe(path.join(os.homedir(), 'Acme/.wt'));
    const one = base();
    one.projects[0].worktreesDir = '~/code';
    expect(() => normalizeConfig(one)).toThrow(msg);
    // Demo: ~/.faro/worktrees/demo con el repo en ~/code/demo.
    expect(() => normalizeConfig(base())).not.toThrow();
  });

  it('main con repoPath suelto distinto: error (no hay heurística por id)', () => {
    const raw = multi({ repoPath: '~/Otro' }, [{ id: 'main', path: '~/A', baseBranch: 'main', remote: 'origin' }]);
    expect(() => normalizeConfig(raw)).toThrow(/no ambos/);
  });

  it('normalizar dos veces una config multi-repo es idempotente; también la de un repo', () => {
    for (const raw of [multi(), base()]) {
      const once = normalizeConfig(raw);
      expect(normalizeConfig(once)).toEqual(once);
    }
  });

  it('un repo sin path o con path no textual: ConfigError, no TypeError', () => {
    for (const path of [undefined, 5, '  ']) {
      const r = repos();
      r[1] = { ...r[1], path: path as never };
      expect(() => normalizeConfig(multi({}, r))).toThrow(/Proyecto demo: repo backend: falta path/);
      expect(() => normalizeConfig(multi({ repoPath: '~/A' }, r))).toThrow(ConfigError);
    }
  });
});
