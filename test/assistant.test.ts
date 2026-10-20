import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { draftRoutine } from '../src/server/assistant';
import { Store } from '../src/server/store';
import { makeConfig, makeRepo, tmpDir } from './helpers';

const valido = {
  name: 'Revisión semanal', title: 'Revisión {semana}', cron: '0 9 * * 1', profileId: 'dev', level: 1,
  context: 'estado', maxBudgetUsd: null, prompt: 'Revisa el estado del proyecto.',
};

function setup(draft: object, env: Record<string, string> = {}) {
  const config = makeConfig(makeRepo());
  const store = new Store(':memory:');
  const dir = tmpDir();
  const json = path.join(dir, 'draft.json');
  writeFileSync(json, JSON.stringify(draft));
  const args = path.join(dir, 'args.jsonl');
  const fullEnv = { FAKE_JSON_RESULT: json, FAKE_ARGS_OUT: args, FAKE_CWD_OUT: path.join(dir, 'cwd.txt'), FAKE_JSON_COST: '0.0123', ...env };
  const call = (over: { timeoutMs?: number; tmpBase?: string } = {}, description = 'cada lunes revisa el estado') =>
    draftRoutine({ config, store, claudeBin: config.claudeBin, env: fullEnv, ...over }, 'demo', description);
  return { config, store, call, args, cwd: path.join(dir, 'cwd.txt') };
}

describe('asistente de rutinas', () => {
  it('borrador válido: devuelve la rutina y guarda el coste', async () => {
    const { call, store } = setup(valido);
    const d = await call();
    expect(d).toEqual({ ...valido });
    const rows = store.db.prepare('SELECT cost_usd, ok FROM assistant_calls').all();
    expect(rows).toEqual([{ cost_usd: 0.0123, ok: 1 }]);
    expect(store.spend(new Date()).week).toBeCloseTo(0.0123);
    expect(store.spendByDay('2000-01-01T00:00:00.000Z').reduce((a, r) => a + r.usd, 0)).toBeCloseTo(0.0123);
    expect(store.spendBy('routine', '2000-01-01T00:00:00.000Z')).toEqual([{ key: 'Asistente', usd: 0.0123, runs: 1 }]);
    expect(store.spendBy('profile', '2000-01-01T00:00:00.000Z')[0]!.key).toBe('Asistente');
  });

  it('pasa los argumentos de la CLI: esquema, tope, sin herramientas ni ajustes de usuario', async () => {
    const { call, args } = setup(valido);
    await call();
    const a: string[] = JSON.parse(readFileSync(args, 'utf8').trim().split('\n')[0]!);
    expect(a.slice(a.indexOf('--max-budget-usd'), a.indexOf('--max-budget-usd') + 2)).toEqual(['--max-budget-usd', '0.5']);
    expect(JSON.parse(a[a.indexOf('--json-schema') + 1]!).required).toContain('profileId');
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('');
    expect(a).toContain('--strict-mcp-config');
    expect(a).toContain('--disable-slash-commands');
    expect(a).not.toContain('--bare');
    expect(a.at(-1)).toContain('cada lunes revisa el estado');
    expect(a.at(-1)).toContain('dev');
  });

  it('perfil inventado: error en español', async () => {
    const { call } = setup({ ...valido, profileId: 'fantasma' });
    await expect(call()).rejects.toThrow('El asistente propuso un perfil que no existe: fantasma');
  });

  it('nivel 3 baja a 2; contexto no disponible pasa a null; cron inválido es error', async () => {
    const a = await setup({ ...valido, level: 3, context: 'aso' }).call();
    expect(a.level).toBe(2);
    expect(a.context).toBeNull();
    await expect(setup({ ...valido, cron: 'cada lunes' }).call()).rejects.toMatchObject({ message: expect.stringMatching(/cron inválido/), status: 422 });
  });

  it('CLI colgada: «El asistente tardó demasiado» y no deja carpeta temporal', async () => {
    const { call, cwd } = setup(valido, { FAKE_HANG: '1' });
    await expect(call({ timeoutMs: 200 })).rejects.toThrow('El asistente tardó demasiado');
    const used = readFileSync(cwd, 'utf8').trim();
    expect(used).toContain('faro-asistente-');
    expect(existsSync(used)).toBe(false);
  });

  it('error de la CLI: falla, y guarda el coste con ok = 0', async () => {
    const { call, store } = setup(valido, { FAKE_JSON_SUBTYPE: 'error_max_budget_usd' });
    await expect(call()).rejects.toThrow(/tope de gasto/);
    expect(store.db.prepare('SELECT ok FROM assistant_calls').all()).toEqual([{ ok: 0 }]);
  });

  it('un segundo borrador mientras hay uno en curso: «Ya hay un borrador en curso» (429)', async () => {
    const { call } = setup(valido, { FAKE_HANG: '1' });
    const first = call({ timeoutMs: 300 }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 50));
    await expect(call()).rejects.toMatchObject({ message: 'Ya hay un borrador en curso', status: 429 });
    expect((await first).message).toBe('El asistente tardó demasiado');
  });

  it('50 intentos hoy: «Límite diario del asistente alcanzado» (429) sin lanzar la CLI', async () => {
    const { call, store, args } = setup(valido);
    for (let i = 0; i < 50; i++) store.recordAssistantCall(0.001, true);
    await expect(call()).rejects.toMatchObject({ message: 'Límite diario del asistente alcanzado', status: 429 });
    expect(existsSync(args)).toBe(false);
  });

  it('perfil inventado y cron inválido son 422', async () => {
    await expect(setup({ ...valido, profileId: 'x' }).call()).rejects.toMatchObject({ status: 422 });
  });

  it('si no se puede crear la carpeta temporal, se libera el bloqueo: el siguiente borrador no se rechaza', async () => {
    const { call } = setup(valido);
    await expect(call({ tmpBase: path.join(tmpDir(), 'no', 'existe') })).rejects.toThrow(/ENOENT/);
    await expect(call()).resolves.toMatchObject({ profileId: 'dev' });
  });
});
