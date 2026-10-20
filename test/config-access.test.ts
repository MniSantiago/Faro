import { describe, expect, it } from 'vitest';
import { canChange, editableBy, type Change } from '../src/server/config-access';
import type { FaroConfig } from '../src/server/types';

const config = {
  host: '127.0.0.1', port: 1, dataDir: '', claudeBin: 'claude', maxConcurrentRuns: 1,
  projects: [{
    id: 'p', name: 'P', prefix: 'P', repoPath: '', baseBranch: 'main', remote: 'origin', worktreesDir: '',
    routines: [
      { id: 'r1', name: 'R1', profileId: 'dev', level: 1, title: 't', prompt: 'p' },
      { id: 'r3', name: 'R3', profileId: 'riesgo', level: 3, title: 't', prompt: 'p' },
      { id: 'rel', name: 'Rel', profileId: 'dev', level: 2, title: 't', prompt: 'p', release: 'build' },
    ],
  }],
  profiles: [
    { id: 'dev', name: 'Dev', instructions: '', defaultLevel: 2, timeoutMinutes: 5 },
    { id: 'riesgo', name: 'Riesgo', instructions: '', defaultLevel: 2, timeoutMinutes: 5 },
    { id: 'coordinador', name: 'Coord', instructions: '', defaultLevel: 1, timeoutMinutes: 5 },
  ],
} as unknown as FaroConfig;

const remote = { local: false };
const mac = { local: true };
const routine = (over: Record<string, unknown> = {}) => ({ id: 'x', profileId: 'dev', level: 1, ...over });
const ch = (c: Partial<Change>): Change => ({ kind: 'routine', id: 'x', before: null, after: null, ...c });
const no = (r: { ok: boolean }) => expect(r.ok).toBe(false);

describe('canChange', () => {
  it('en el Mac todo vale', () => {
    expect(canChange(mac, ch({ kind: 'project', after: { name: 'z' } }), config)).toEqual({ ok: true });
    expect(canChange(mac, ch({ after: routine({ level: 4 }) }), config)).toEqual({ ok: true });
    expect(canChange(mac, ch({ kind: 'profile', id: 'coordinador', before: {}, after: {} }), config)).toEqual({ ok: true });
  });
  it('vinculado: rutina nueva de nivel 2 vale', () => {
    expect(canChange(remote, ch({ after: routine({ level: 2 }) }), config)).toEqual({ ok: true });
  });
  it('vinculado: no pone nivel 3 ni 4', () => {
    const r = canChange(remote, ch({ after: routine({ level: 3 }) }), config);
    expect(r).toEqual({ ok: false, reason: 'Desde un dispositivo vinculado solo se pueden usar los niveles 1 y 2' });
    no(canChange(remote, ch({ after: routine({ level: 4 }) }), config));
  });
  it('vinculado: no edita ni borra una rutina que ya es de nivel 3', () => {
    no(canChange(remote, ch({ before: routine({ level: 3 }), after: routine({ level: 1 }) }), config));
    no(canChange(remote, ch({ before: routine({ level: 3 }), after: null }), config));
  });
  it('vinculado: no toca rutinas con release', () => {
    no(canChange(remote, ch({ before: routine(), after: routine({ release: 'build' }) }), config));
    no(canChange(remote, ch({ before: routine({ release: 'build_submit' }), after: routine() }), config));
    expect(canChange(remote, ch({ before: routine({ release: 'none' }), after: routine() }), config)).toEqual({ ok: true });
  });
  it('vinculado: perfiles con defaultLevel 3 o previo 3', () => {
    no(canChange(remote, ch({ kind: 'profile', id: 'n', after: { defaultLevel: 3 } }), config));
    no(canChange(remote, ch({ kind: 'profile', id: 'dev', before: { defaultLevel: 4 }, after: { defaultLevel: 1 } }), config));
    expect(canChange(remote, ch({ kind: 'profile', id: 'dev', before: { defaultLevel: 1 }, after: { defaultLevel: 2 } }), config)).toEqual({ ok: true });
  });
  it('vinculado: no edita un perfil que usa una rutina de nivel 3-4', () => {
    const r = canChange(remote, ch({ kind: 'profile', id: 'riesgo', before: { defaultLevel: 2 }, after: { defaultLevel: 1 } }), config);
    expect(r).toEqual({ ok: false, reason: 'Desde un dispositivo vinculado no se puede editar un perfil que usa una rutina de nivel 3 o 4' });
    no(canChange(remote, ch({ kind: 'profile', id: 'riesgo', before: { defaultLevel: 2 }, after: null }), config));
  });
  it('vinculado: no edita el perfil coordinador (el de la config o el por defecto)', () => {
    no(canChange(remote, ch({ kind: 'profile', id: 'coordinador', before: { defaultLevel: 1 }, after: { defaultLevel: 1 } }), config));
    const otra = { ...config, coordinatorProfile: 'dev' } as FaroConfig;
    no(canChange(remote, ch({ kind: 'profile', id: 'dev', before: { defaultLevel: 1 }, after: { defaultLevel: 1 } }), otra));
    expect(canChange(remote, ch({ kind: 'profile', id: 'coordinador', before: { defaultLevel: 1 }, after: { defaultLevel: 1 } }), otra)).toEqual({ ok: true });
  });
  it('vinculado: proyecto y generales solo desde el Mac', () => {
    expect(canChange(remote, ch({ kind: 'project', id: 'p', before: {}, after: {} }), config)).toEqual({ ok: false, reason: 'Solo desde el Mac' });
    expect(canChange(remote, ch({ kind: 'general', id: 'general', before: {}, after: {} }), config)).toEqual({ ok: false, reason: 'Solo desde el Mac' });
  });
  it('para todos: release distinto de none o mcpConfig cambiado se edita en faro.config.ts', () => {
    for (const actor of [mac, remote]) {
      expect(canChange(actor, ch({ before: routine(), after: routine({ release: 'build' }) }), config))
        .toEqual({ ok: false, reason: 'Se edita en faro.config.ts' });
      expect(canChange(actor, ch({ kind: 'profile', id: 'dev', before: { defaultLevel: 1, mcpConfig: 'a' }, after: { defaultLevel: 1, mcpConfig: 'b' } }), config))
        .toEqual({ ok: false, reason: 'Se edita en faro.config.ts' });
    }
    expect(canChange(mac, ch({ kind: 'profile', id: 'dev', before: { mcpConfig: 'a' }, after: { mcpConfig: 'a' } }), config)).toEqual({ ok: true });
    // el release de un proyecto es otra cosa (comandos de build) y no cuenta
    expect(canChange(mac, ch({ kind: 'project', id: 'p', before: {}, after: { release: { build: 'x' } } }), config)).toEqual({ ok: true });
  });
});

describe('editableBy', () => {
  it('Mac: todo', () => {
    expect(editableBy(mac, 'routine', 'r3', config)).toEqual({ ok: true });
    expect(editableBy(mac, 'project', 'p', config)).toEqual({ ok: true });
  });
  it('vinculado: rutinas por nivel y release', () => {
    expect(editableBy(remote, 'routine', 'r1', config)).toEqual({ ok: true });
    no(editableBy(remote, 'routine', 'r3', config));
    expect(editableBy(remote, 'routine', 'rel', config)).toEqual({
      ok: false, reason: 'Desde un dispositivo vinculado no se pueden editar rutinas que publican en la tienda',
    });
  });
  it('vinculado: perfiles', () => {
    expect(editableBy(remote, 'profile', 'dev', config)).toEqual({ ok: true });
    no(editableBy(remote, 'profile', 'riesgo', config));
    no(editableBy(remote, 'profile', 'coordinador', config));
  });
  it('vinculado: proyecto y generales no', () => {
    no(editableBy(remote, 'project', 'p', config));
    no(editableBy(remote, 'general', 'general', config));
  });
  it('id inexistente: nuevo', () => {
    expect(editableBy(remote, 'routine', 'nueva', config)).toEqual({ ok: true });
    expect(editableBy(remote, 'profile', 'nuevo', config)).toEqual({ ok: true });
    no(editableBy(remote, 'project', 'nuevo', config));
    expect(editableBy(mac, 'project', 'nuevo', config)).toEqual({ ok: true });
  });
});
