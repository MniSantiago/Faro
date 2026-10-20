import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Backlog } from '../src/server/backlog';
import { unshipped } from '../src/server/shipping';
import { Plan } from '../src/server/plan';
import { Store } from '../src/server/store';
import { gitSync, makeConfig, makeRepo, tmpDir } from './helpers';

describe('Backlog compartido con el plugin pendientes', () => {
  const seed = () => {
    const file = path.join(tmpDir(), 'pendientes.json');
    writeFileSync(file, JSON.stringify({
      'pend:/repo': { key: '/repo', items: [{ id: 5, text: 'Vestir a Demo', isDone: false, createdAt: 1 }], nextId: 6 },
      'pend:/otro': { key: '/otro', items: [], nextId: 1 },
    }));
    return file;
  };

  it('lista, añade con el siguiente id y marca hecho, conservando las demás claves', () => {
    const file = seed();
    const b = new Backlog(file, '/repo');
    expect(b.list().map((i) => i.id)).toEqual([5]);
    expect(b.add('  Más   expediciones ', 7)).toEqual({ id: 6, text: 'Más expediciones', isDone: false, createdAt: 7 });
    expect(b.setDone(5, true).isDone).toBe(true);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved['pend:/repo'].nextId).toBe(7);
    expect(saved['pend:/otro']).toEqual({ key: '/otro', items: [], nextId: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('relee el archivo antes de cada cambio: no pisa lo que otro añadió entre medias', () => {
    const file = seed();
    const b = new Backlog(file, '/repo');
    b.list();
    // El plugin añade #6 mientras Faro tiene la página abierta.
    const d = JSON.parse(readFileSync(file, 'utf8'));
    d['pend:/repo'].items.push({ id: 6, text: 'Del plugin', isDone: false, createdAt: 2 });
    d['pend:/repo'].nextId = 7;
    writeFileSync(file, JSON.stringify(d));
    expect(b.add('De Faro').id).toBe(7);
    expect(b.list().map((i) => i.text)).toEqual(['Vestir a Demo', 'Del plugin', 'De Faro']);
  });

  it('archivo o proyecto sin backlog: lista vacía y el primer id es 1; vacío o id inexistente da error', () => {
    const b = new Backlog(path.join(tmpDir(), 'no-existe.json'), '/repo');
    expect(b.list()).toEqual([]);
    expect(b.add('Primero').id).toBe(1);
    expect(() => b.add('   ')).toThrow(/vacío/);
    expect(() => b.setDone(99, true)).toThrow(/#99/);
  });
});

describe('unshipped', () => {
  it('agrupa por tarea lo integrado desde el commit del build y marca lo que toca la carpeta de release.cwd', async () => {
    const repo = makeRepo();
    const project = { ...makeConfig(repo).projects[0], release: { cwd: 'app', build: 'b', submit: 's' } };
    const build = gitSync(repo, 'rev-parse', 'HEAD').trim();
    const commit = (file: string, msg: string) => {
      const full = path.join(repo, file);
      gitSync(repo, 'checkout', '-q', 'main');
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, msg);
      gitSync(repo, 'add', '.');
      gitSync(repo, 'commit', '-qm', msg);
    };
    commit('landing/a.html', 'DEM-1: Landing nueva');
    commit('app/src/b.ts', 'DEM-2: Pantalla nueva');
    commit('app/src/c.ts', 'DEM-2: Pantalla nueva (ajuste)');
    commit('docs/x.md', 'Docs sueltas');
    commit('app/src/b.ts', 'DEM-3: Resolver conflicto: Pantalla nueva');
    const store = new Store(':memory:');
    const t = store.createTask(project, { title: 'Pantalla nueva', description: '', profileId: 'dev', level: 2 });
    const tasks: Record<string, typeof t> = {
      'DEM-2': { ...t, id: 'DEM-2', state: 'done', branch: 'b2' },
      // La tarea de conflicto comparte rama con su padre: cuenta dentro de él.
      'DEM-3': { ...t, id: 'DEM-3', title: 'Resolver conflicto: Pantalla nueva', state: 'done', branch: 'b2', parentId: 'DEM-2' },
    };
    const list = await unshipped(project, build, { findTask: (id) => tasks[id] ?? null });
    expect(list.map((u) => [u.taskId, u.commits, u.touchesApp, u.state])).toEqual([
      ['DEM-2', 3, true, 'done'], [null, 1, false, null], ['DEM-1', 1, false, null],
    ]);
    expect(list[0].title).toBe('Pantalla nueva');
    expect(list[2].title).toBe('Landing nueva');
    // Con release.cwd «.», todo el repo es la app.
    const whole = await unshipped({ ...project, release: { cwd: '.', build: 'b', submit: 's' } }, build, { findTask: (id) => tasks[id] ?? null });
    expect(whole.every((u) => u.touchesApp)).toBe(true);
  });
});

describe('Plan', () => {
  const setup = () => {
    const repo = makeRepo();
    const config = makeConfig(repo);
    const file = path.join(tmpDir(), 'pendientes.json');
    config.projects[0].backlogFile = file;
    config.projects[0].release = { cwd: '.', build: 'b', submit: 's' };
    const build = gitSync(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(path.join(repo, 'nuevo.txt'), 'x');
    gitSync(repo, 'add', '.');
    gitSync(repo, 'commit', '-qm', 'DEM-7: Algo nuevo');
    const store = new Store(':memory:');
    let calls = 0;
    let fail = false;
    let now = new Date('2026-10-18T10:00:00Z');
    const plan = new Plan({
      store, config, now: () => now,
      fetchBuild: async () => { calls++; if (fail) throw new Error('sin red'); return { version: '1.0.2', buildNumber: '9', commit: build, createdAt: '' }; },
    });
    return { plan, store, file, calls: () => calls, setFail: (v: boolean) => { fail = v; }, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
  };

  it('junta backlog, build y lo sin enviar; guarda el build una hora', async () => {
    const s = setup();
    s.plan.addBacklog('demo', 'Primero');
    const st = await s.plan.state('demo');
    expect(st.backlog?.map((i) => i.text)).toEqual(['Primero']);
    expect(st.build?.version).toBe('1.0.2');
    expect(st.unshipped.map((u) => [u.taskId, u.tested])).toEqual([['DEM-7', false]]);
    await s.plan.state('demo');
    expect(s.calls()).toBe(1);
    s.advance(2 * 3600_000);
    await s.plan.state('demo');
    await new Promise((r) => setTimeout(r, 10));
    expect(s.calls()).toBe(2);
  });

  it('marcar como probado se guarda; si EAS falla conserva el último build y lo dice', async () => {
    const s = setup();
    await s.plan.state('demo');
    s.plan.setTested('demo', 'DEM-7', true);
    expect((await s.plan.state('demo')).unshipped[0].tested).toBe(true);
    s.setFail(true);
    const r = await s.plan.refreshBuild('demo');
    expect(r.error).toBe('sin red');
    expect(r.build?.version).toBe('1.0.2');
    s.plan.setTested('demo', 'DEM-7', false);
    expect((await s.plan.state('demo')).unshipped[0].tested).toBe(false);
  });
});
