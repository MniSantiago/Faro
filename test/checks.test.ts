import { describe, expect, it } from 'vitest';
import { runChecks, runTaskChecks } from '../src/server/checks';
import { shAbortable } from '../src/server/exec';
import type { ProjectConfig } from '../src/server/types';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { getProject } from '../src/server/config';
import { makeConfig, makeMultiConfig, makeRepo, makeTask, tmpDir } from './helpers';

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

describe('runTaskChecks', () => {
  /** Proyecto multi con las comprobaciones de cada repo dadas y una tarea con su carpeta (a/ y b/). */
  function multi(checks: Record<'a' | 'b', ProjectConfig['checks']>) {
    const base = getProject(makeMultiConfig(), 'multi');
    const project = { ...base, repos: base.repos!.map((r) => ({ ...r, checks: checks[r.id as 'a' | 'b'] })) };
    const folder = tmpDir();
    for (const id of ['a', 'b']) mkdirSync(path.join(folder, id));
    return { project, task: makeTask({ id: 'MUL-1', projectId: 'multi', worktreePath: folder, branch: 'MUL-1-x' }), folder };
  }

  it('whenChanged es relativo al repo', async () => {
    const { project, task } = multi({ a: [{ name: 'ca', command: 'true', whenChanged: 'src/' }], b: [{ name: 'cb', command: 'true', whenChanged: 'src/' }] });
    const r = await runTaskChecks(project, task, { a: ['src/z.ts'], b: [] }, {});
    expect(r.map((c) => [c.name, c.skipped])).toEqual([['a · ca', false], ['b · cb', true]]);
  });

  it('en multi-repo el nombre lleva el repo y cada repo corre en su worktree', async () => {
    const { project, task, folder } = multi({ a: [{ name: 'dónde', command: 'pwd -P' }], b: [{ name: 'dónde', command: 'pwd -P' }] });
    project.repos = project.repos!.map((r) => (r.id === 'b' ? { ...r, name: 'Backend' } : r));
    const r = await runTaskChecks(project, task, { a: ['x'], b: ['y'] }, {});
    expect(r.map((c) => c.name)).toEqual(['a · dónde', 'Backend · dónde']);
    expect(r[1].output.trim()).toBe(path.join(realpathSync(folder), 'b'));
  });

  it('multi-repo: un repo sin cambios no corre sus comprobaciones (quedan omitidas)', async () => {
    const { project, task, folder } = multi({
      a: [{ name: 'tests', command: 'touch corrio' }],
      b: [{ name: 'tests', command: 'touch corrio' }, { name: 'tipos', command: 'touch corrio2' }],
    });
    project.repos = project.repos!.map((r) => ({ ...r, name: r.id === 'a' ? 'Backend' : 'Móvil' }));
    // Solo cambia el backend: lo del móvil no se ejecuta.
    const r = await runTaskChecks(project, task, { a: ['src/api.ts'] }, {});
    expect(r.map((c) => [c.name, c.skipped, c.ok])).toEqual([
      ['Backend · tests', false, true], ['Móvil · tests', true, true], ['Móvil · tipos', true, true],
    ]);
    expect(existsSync(path.join(folder, 'a', 'corrio'))).toBe(true);
    expect(existsSync(path.join(folder, 'b', 'corrio'))).toBe(false);
    expect(existsSync(path.join(folder, 'b', 'corrio2'))).toBe(false);
    // Lista vacía, igual que sin entrada.
    const r2 = await runTaskChecks(project, task, { a: ['src/api.ts'], b: [] }, {});
    expect(r2.filter((c) => c.name.startsWith('Móvil')).every((c) => c.skipped)).toBe(true);
  });

  it('con un repo es runChecks tal cual (sin prefijo, con las comprobaciones del proyecto)', async () => {
    const repo = makeRepo();
    const project = { ...getProject(makeConfig(repo), 'demo'), checks: [{ name: 'app', command: 'true', whenChanged: 'app/' }] };
    const r = await runTaskChecks(project, makeTask({ worktreePath: repo }), { main: ['app/x.ts'] }, {});
    expect(r.map((c) => [c.name, c.skipped])).toEqual([['app', false]]);
  });
});
