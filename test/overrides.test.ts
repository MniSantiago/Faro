import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../src/server/config';
import { applyOverrides, LiveConfig, type OverrideRow } from '../src/server/overrides';
import { Store } from '../src/server/store';
import type { FaroConfig, RoutineConfig } from '../src/server/types';

const rutina = (over: Partial<RoutineConfig> = {}): RoutineConfig => ({
  id: 'semanal', name: 'Informe', cron: '0 9 * * 1', profileId: 'dev', level: 1,
  title: 'Informe {semana}', prompt: 'Datos hasta {fecha}', ...over,
});

// Config cruda, tal cual la exporta faro.config.ts (con «~» sin expandir).
const archivo = (over: Partial<RoutineConfig> = {}): FaroConfig => ({
  host: '127.0.0.1', port: 0, dataDir: '~/faro-datos', claudeBin: 'claude', maxConcurrentRuns: 2,
  projects: [{
    id: 'demo', name: 'Demo', prefix: 'DEM', repoPath: '~/demo', baseBranch: 'main', remote: 'origin',
    worktreesDir: '~/wt', prepare: [], checks: [], routines: [rutina(over)],
  }],
  profiles: [
    { id: 'dev', name: 'Dev', instructions: 'Agente.', defaultLevel: 2, timeoutMinutes: 1 },
    { id: 'qa', name: 'QA', instructions: 'Revisa.', defaultLevel: 1, timeoutMinutes: 1 },
  ],
});

const fila = (over: Partial<OverrideRow>): OverrideRow => ({
  kind: 'routine', id: 'semanal', origin: 'file', data: {}, updatedAt: '2026-10-20T10:00:00.000Z', deviceId: null, ...over,
});

const mac = { deviceId: null };

describe('applyOverrides', () => {
  it('aplica un parche por campo sin tocar la config cruda', () => {
    const raw = archivo();
    const { config, ignored } = applyOverrides(raw, [fila({ data: { cron: '0 8 * * *' } })]);
    expect(ignored).toEqual([]);
    expect(config.projects[0]!.routines![0]).toMatchObject({ cron: '0 8 * * *', prompt: 'Datos hasta {fecha}' });
    expect(raw.projects[0]!.routines![0]!.cron).toBe('0 9 * * 1');
    expect(config.projects[0]!.repoPath).not.toContain('~');
  });

  it('un campo a null lo quita', () => {
    const { config } = applyOverrides(archivo({ maxBudgetUsd: 2 }), [fila({ data: { maxBudgetUsd: null } })]);
    expect(config.projects[0]!.routines![0]).not.toHaveProperty('maxBudgetUsd');
  });

  it('descarta el override inválido con el mensaje de ConfigError y sigue con los demás', () => {
    const { config, ignored } = applyOverrides(archivo(), [
      fila({ data: { cron: 'esto no es un cron' } }),
      fila({ kind: 'profile', id: 'dev', data: { name: 'Desarrollo' } }),
    ]);
    expect(ignored).toEqual([{ kind: 'routine', id: 'semanal', reason: 'Rutina semanal: cron inválido «esto no es un cron»' }]);
    expect(config.projects[0]!.routines![0]!.cron).toBe('0 9 * * 1');
    expect(config.profiles[0]!.name).toBe('Desarrollo');
  });

  it('una rutina del panel entra en su proyecto', () => {
    const { config, ignored } = applyOverrides(archivo(), [
      fila({ id: 'diaria', origin: 'panel', data: { ...rutina({ id: 'diaria', cron: '0 7 * * *' }), projectId: 'demo' } }),
    ]);
    expect(ignored).toEqual([]);
    const r = config.projects[0]!.routines!.find((x) => x.id === 'diaria');
    expect(r).toMatchObject({ cron: '0 7 * * *' });
    expect(r).not.toHaveProperty('projectId');
  });
});

describe('LiveConfig', () => {
  const crear = (raw = archivo(), store = new Store(':memory:'), onChange?: () => void) =>
    ({ live: new LiveConfig({ raw, store, onChange }), store });

  it('parche de cron sobre una rutina del archivo: «editada» y solo ese campo', () => {
    const onChange = vi.fn();
    const { live, store } = crear(archivo(), new Store(':memory:'), onChange);
    expect(live.origin('routine', 'semanal')).toBe('config');
    live.save('routine', 'semanal', { ...rutina(), cron: '0 8 * * *' }, { deviceId: 'ipad' });
    expect(live.origin('routine', 'semanal')).toBe('editada');
    expect(live.overriddenFields('routine', 'semanal')).toEqual(['cron']);
    expect(live.config.projects[0]!.routines![0]!.cron).toBe('0 8 * * *');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(store.listOverrides()).toEqual([expect.objectContaining({ kind: 'routine', id: 'semanal', origin: 'file', data: { cron: '0 8 * * *' }, deviceId: 'ipad' })]);
  });

  it('un cambio posterior del archivo en un campo que el override no fija llega a la config efectiva', () => {
    const store = new Store(':memory:');
    crear(archivo(), store).live.save('routine', 'semanal', { cron: '0 8 * * *' }, mac);
    const live = new LiveConfig({ raw: archivo({ prompt: 'Prompt nuevo' }), store });
    expect(live.config.projects[0]!.routines![0]).toMatchObject({ cron: '0 8 * * *', prompt: 'Prompt nuevo' });
    expect(live.overriddenFields('routine', 'semanal')).toEqual(['cron']);
  });

  it('guardar con los mismos valores que el archivo borra el override: vuelve a «config»', () => {
    const { live, store } = crear();
    live.save('routine', 'semanal', { cron: '0 8 * * *' }, mac);
    live.save('routine', 'semanal', { ...rutina() }, mac);
    expect(live.origin('routine', 'semanal')).toBe('config');
    expect(live.overriddenFields('routine', 'semanal')).toEqual([]);
    expect(store.listOverrides()).toEqual([]);
  });

  it('las rutas con «~» expandidas cuentan como iguales al archivo', () => {
    const { live } = crear();
    live.save('project', 'demo', { ...live.config.projects[0]!, name: 'Demo 2' }, mac);
    expect(live.overriddenFields('project', 'demo')).toEqual(['name']);
  });

  it('rutina del panel con perfil inexistente: ConfigError y nada guardado', () => {
    const onChange = vi.fn();
    const { live, store } = crear(archivo(), new Store(':memory:'), onChange);
    expect(() => live.save('routine', 'nueva', { ...rutina({ id: 'nueva', profileId: 'fantasma' }), projectId: 'demo' }, mac))
      .toThrow(ConfigError);
    expect(store.listOverrides()).toEqual([]);
    expect(live.config.projects[0]!.routines!.map((r) => r.id)).toEqual(['semanal']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rutina del panel: origen «panel», y remove la borra', () => {
    const { live, store } = crear();
    live.save('routine', 'nueva', { ...rutina({ id: 'nueva', profileId: 'qa' }), projectId: 'demo' }, mac);
    expect(live.origin('routine', 'nueva')).toBe('panel');
    expect(live.config.projects[0]!.routines!.map((r) => r.id)).toEqual(['semanal', 'nueva']);
    live.remove('routine', 'nueva');
    expect(live.config.projects[0]!.routines!.map((r) => r.id)).toEqual(['semanal']);
    expect(store.listOverrides()).toEqual([]);
  });

  it('remove de un elemento del archivo vuelve al archivo; sin override no hace nada', () => {
    const { live } = crear();
    expect(live.remove('routine', 'semanal')).toBe(live.config);
    live.save('routine', 'semanal', { cron: '0 8 * * *' }, mac);
    live.remove('routine', 'semanal');
    expect(live.origin('routine', 'semanal')).toBe('config');
    expect(live.config.projects[0]!.routines![0]!.cron).toBe('0 9 * * 1');
  });

  it('no deja borrar un perfil del panel que usa una rutina del panel', () => {
    const { live } = crear();
    live.save('profile', 'nuevo', { id: 'nuevo', name: 'Nuevo', instructions: 'x', defaultLevel: 1, timeoutMinutes: 5 }, mac);
    live.save('routine', 'nueva', { ...rutina({ id: 'nueva', profileId: 'nuevo' }), projectId: 'demo' }, mac);
    expect(() => live.remove('profile', 'nuevo')).toThrow(/perfil desconocido nuevo/);
    expect(live.origin('profile', 'nuevo')).toBe('panel');
  });

  it('override guardado cuyo perfil ya no existe en el archivo: arranca e ignored() lo lista', () => {
    const store = new Store(':memory:');
    crear(archivo(), store).live.save('routine', 'nueva', { ...rutina({ id: 'nueva', profileId: 'qa' }), projectId: 'demo' }, mac);
    const sinQa = archivo();
    sinQa.profiles = sinQa.profiles.filter((p) => p.id !== 'qa');
    const live = new LiveConfig({ raw: sinQa, store });
    expect(live.ignored()).toEqual([{ kind: 'routine', id: 'nueva', reason: 'Rutina nueva: perfil desconocido qa' }]);
    expect(live.config.projects[0]!.routines!.map((r) => r.id)).toEqual(['semanal']);
    expect(store.listOverrides()).toHaveLength(1);
  });

  it('en caliente: las referencias tomadas antes ven el cambio', () => {
    const { live } = crear();
    const config = live.config;
    const proyecto = config.projects[0]!;
    const routines = proyecto.routines!;
    const profiles = config.profiles;
    const dev = config.profiles[0]!;
    live.save('routine', 'semanal', { cron: '0 8 * * *' }, mac);
    live.save('profile', 'dev', { name: 'Desarrollo' }, mac);
    live.save('general', 'general', { maxConcurrentRuns: 5 }, mac);
    live.save('routine', 'nueva', { ...rutina({ id: 'nueva' }), projectId: 'demo' }, mac);
    expect(live.config).toBe(config);
    expect(config.maxConcurrentRuns).toBe(5);
    expect(config.projects[0]).toBe(proyecto);
    expect(proyecto.routines).toBe(routines);
    expect(routines.map((r) => [r.id, r.cron])).toEqual([['semanal', '0 8 * * *'], ['nueva', '0 9 * * 1']]);
    expect(config.profiles).toBe(profiles);
    expect(dev.name).toBe('Desarrollo');
  });

  it('Generales: los campos de arranque y seguridad no se editan desde el panel', () => {
    const { live, store } = crear();
    for (const k of ['host', 'port', 'dataDir', 'allowedHosts', 'claudeBin', 'ghBin', 'sandbox', 'pushContact', 'projects', 'profiles']) {
      expect(() => live.save('general', 'general', { [k]: null }, mac)).toThrow(`Se edita en faro.config.ts: ${k}`);
    }
    expect(store.listOverrides()).toEqual([]);
    live.save('general', 'general', { title: 'Mi Faro' }, mac);
    expect(live.config.title).toBe('Mi Faro');
  });

  it('un parche guardado de Generales con campos de arranque no se aplica', () => {
    const store = new Store(':memory:');
    store.setOverride(fila({ kind: 'general', id: 'general', data: { port: 9999, title: 'X' } }));
    const live = new LiveConfig({ raw: archivo(), store });
    expect(live.config).toMatchObject({ port: 0, title: 'X' });
  });

  it('un override ignorado no cuenta como aplicado en origin ni overriddenFields', () => {
    const store = new Store(':memory:');
    store.setOverride(fila({ data: { cron: 'esto no es un cron' } }));
    store.setOverride(fila({ id: 'nueva', origin: 'panel', data: { ...rutina({ id: 'nueva', profileId: 'fantasma' }), projectId: 'demo' } }));
    const live = new LiveConfig({ raw: archivo(), store });
    expect(live.ignored().map((i) => i.id)).toEqual(['semanal', 'nueva']);
    expect(live.origin('routine', 'semanal')).toBe('config');
    expect(live.overriddenFields('routine', 'semanal')).toEqual([]);
    expect(live.origin('routine', 'nueva')).not.toBe('panel');
  });

  it('una fila con JSON ilegible no impide arrancar: se lista en ignored() y se puede borrar', () => {
    const store = new Store(':memory:');
    store.setOverride(fila({ data: { cron: '0 8 * * *' } }));
    store.db.prepare("UPDATE config_overrides SET data = '{roto' WHERE id = 'semanal'").run();
    const live = new LiveConfig({ raw: archivo(), store });
    expect(live.ignored()).toEqual([{ kind: 'routine', id: 'semanal', reason: 'datos ilegibles' }]);
    expect(live.config.projects[0]!.routines![0]!.cron).toBe('0 9 * * 1');
    live.remove('routine', 'semanal');
    expect(live.ignored()).toEqual([]);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM config_overrides').get()).toEqual({ n: 0 });
  });

  it('si onChange falla, el cambio queda aplicado y no se propaga el error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { live, store } = crear(archivo(), new Store(':memory:'), () => { throw new Error('sync roto'); });
    expect(() => live.save('routine', 'semanal', { cron: '0 8 * * *' }, mac)).not.toThrow();
    expect(live.config.projects[0]!.routines![0]!.cron).toBe('0 8 * * *');
    expect(store.listOverrides()).toHaveLength(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
