import { describe, expect, it } from 'vitest';
import { runChecks } from '../src/server/checks';
import { shAbortable } from '../src/server/exec';
import type { ProjectConfig } from '../src/server/types';
import { makeConfig, makeRepo, tmpDir } from './helpers';

const project = (checks: ProjectConfig['checks']) => ({ checks } as ProjectConfig);

describe('shAbortable', () => {
  it('cancelar mata el grupo entero y devuelve 130', async () => {
    const ac = new AbortController();
    const start = Date.now();
    const p = shAbortable('sleep 30 & sleep 30; wait', '/tmp', { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.code).toBe(130);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('tiempo agotado → 124', async () => {
    const r = await shAbortable('sleep 5', '/tmp', { timeoutMs: 100 });
    expect(r.code).toBe(124);
  });

  it('pasa el entorno indicado', async () => {
    const r = await shAbortable('echo "$FARO_X"', '/tmp', { env: { ...process.env, FARO_X: 'hola' } });
    expect(r.stdout.trim()).toBe('hola');
  });
});

describe('runChecks', () => {
  it('con la señal abortada marca la comprobación como cancelada', async () => {
    const repo = makeRepo();
    const proj = { ...makeConfig(repo).projects[0], checks: [{ name: 'Lento', command: 'sleep 30' }, { name: 'Otro', command: 'true' }] };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await runChecks(proj, repo, ['a.txt'], { signal: ac.signal });
    expect(r.map((c) => [c.name, c.ok, c.aborted])).toEqual([['Lento', false, true], ['Otro', false, true]]);
  });

  it('ejecuta, omite según whenChanged y recoge la salida', async () => {
    const r = await runChecks(project([
      { name: 'ok', command: 'echo bien' },
      { name: 'falla', command: 'echo mal >&2; exit 3' },
      { name: 'app', command: 'echo app', whenChanged: 'app/' },
    ]), tmpDir(), ['backend/x.ts']);
    expect(r.map((c) => [c.name, c.ok, c.skipped])).toEqual([['ok', true, false], ['falla', false, false], ['app', true, true]]);
    expect(r[0].output).toContain('bien');
    expect(r[1].output).toContain('mal');
  });

  it('marca el tiempo agotado', async () => {
    const [c] = await runChecks(project([{ name: 'lento', command: 'sleep 5' }]), tmpDir(), [], { timeoutMs: 200 });
    expect(c.ok).toBe(false);
    expect(c.output).toContain('tiempo agotado');
  });
});
