import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionError, ReviewActions } from '../src/server/actions';
import { Bus } from '../src/server/bus';
import { getProject } from '../src/server/config';
import { runTaskChecks } from '../src/server/checks';
import { pruneClosedWorktrees } from '../src/server/housekeeping';
import { integrate } from '../src/server/integrate';
import { withProjectIntegrationLock } from '../src/server/locks';
import { Orchestrator } from '../src/server/orchestrator';
import { Runner } from '../src/server/runner/runner';
import { Store } from '../src/server/store';
import type { FaroConfig, Task } from '../src/server/types';
import { GitWorkspaces, type Workspaces } from '../src/server/workspaces';
import { fixture, gitSync, makeMultiConfig, tmpDir } from './helpers';

/** Proyecto `multi` (repos a y b) con un origin desnudo al día por repo; el agente escribe a/x.txt y b/y.txt. */
function setup(opts: { workspaces?: Workspaces; over?: Partial<FaroConfig> } = {}) {
  const config = makeMultiConfig(opts.over);
  const project = getProject(config, 'multi');
  const repo = (id: string) => project.repos!.find((r) => r.id === id)!.path;
  const origins: Record<string, string> = {};
  for (const id of ['a', 'b']) {
    origins[id] = path.join(tmpDir(), `origin-${id}.git`);
    gitSync(repo(id), 'init', '-q', '--bare', '-b', 'main', origins[id]);
    gitSync(repo(id), 'remote', 'add', 'origin', origins[id]);
    gitSync(repo(id), 'push', '-q', 'origin', 'main');
  }
  const store = new Store(':memory:');
  const bus = new Bus();
  const workspaces = opts.workspaces ?? new GitWorkspaces();
  const env: Record<string, string> = { FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'a/x.txt', FAKE_WRITE_ARTIFACT: 'b/y.txt' };
  const runner = new Runner({ store, bus, claudeBin: config.claudeBin, env, killGraceMs: 100 });
  const orch = new Orchestrator({ store, config, bus, runner, workspaces, runChecks: runTaskChecks, setTimer: () => {} });
  const actions = new ReviewActions({ store, config, bus, workspaces, orchestrator: orch, runner });
  return { config, project, repo, origins, store, bus, workspaces, env, orch, actions };
}

type S = ReturnType<typeof setup>;

/** Tarea de nivel 1 (no se integra sola) que queda en revisión. */
async function inReview(s: S, title = 'Dos repos', over: { repos?: string[] } = {}): Promise<Task> {
  const t = s.actions.createTask({ projectId: 'multi', title, description: '', profileId: 'dev', level: 1, ...over });
  await s.orch.waitIdle();
  const out = s.store.getTask(t.id);
  expect(out.state).toBe('review');
  return out;
}

function commitOn(repo: string, file: string, content: string, msg: string) {
  writeFileSync(path.join(repo, file), content);
  gitSync(repo, 'add', '.');
  gitSync(repo, 'commit', '-qm', msg);
}

const show = (repo: string, ref: string) => {
  try { return gitSync(repo, 'show', ref); } catch { return null; }
};

describe('integración multi-repo', () => {
  it('integra dos repos a la vez en sus main locales', async () => {
    const s = setup();
    // Nivel 2 con las comprobaciones en verde: se integra sola.
    const t = s.actions.createTask({ projectId: 'multi', title: 'Dos repos', description: '', profileId: 'dev', level: 2 });
    await s.orch.waitIdle();
    const done = s.store.getTask(t.id);
    expect(done.state).toBe('done');
    expect(show(s.repo('a'), 'main:x.txt')).toBe('hola\n');
    expect(show(s.repo('b'), 'main:y.txt')).toBe('x');
    // Push pendiente en nivel 2; la carpeta de la tarea ya no está.
    expect(s.store.listApprovals(t.id).find((a) => a.action === 'push')?.state).toBe('pending');
    expect(existsSync(done.worktreePath!)).toBe(false);
  });

  it('si un repo choca no se integra ninguno y la tarea de conflicto lleva solo ese repo', async () => {
    const s = setup();
    const t = await inReview(s);
    const mainA = gitSync(s.repo('a'), 'rev-parse', 'main').trim();
    commitOn(s.repo('b'), 'y.txt', 'otra cosa\n', 'main de b crea y distinto');
    // Sin cola: la tarea de conflicto se queda en borrador para inspeccionarla.
    const d = { ...s, enqueue: undefined };
    const r = await integrate(d, t.id, { userApproved: true });
    expect(r.status).toBe('conflict');
    expect(gitSync(s.repo('a'), 'rev-parse', 'main').trim()).toBe(mainA);
    expect(show(s.repo('a'), 'main:x.txt')).toBeNull();
    const follow = s.store.getTask((r as { followUpTaskId: string }).followUpTaskId);
    expect(follow.repos).toEqual(['b']);
    expect(follow.branch).toBe(t.branch);
    expect(follow.worktreePath).toBe(t.worktreePath);
    expect(follow.description).toContain('y.txt');
    expect(s.store.getTask(t.id).state).toBe('review');
  });

  it('al integrar la tarea de conflicto quedan integrados los dos repos y el padre hecho', async () => {
    const s = setup();
    const t = await inReview(s);
    commitOn(s.repo('b'), 'y.txt', 'otra cosa\n', 'main de b crea y distinto');
    // El agente de la tarea de conflicto resuelve b/y.txt (lo deja en «hola\n») y no toca a.
    s.env.FAKE_WRITE = 'b/y.txt';
    delete s.env.FAKE_WRITE_ARTIFACT;
    const r = await s.actions.approve(t.id);
    expect(r.status).toBe('conflict');
    const childId = (r as { followUpTaskId: string }).followUpTaskId;
    await s.orch.waitIdle();
    expect(s.store.getTask(childId).state).toBe('done');
    expect(s.store.getTask(t.id).state).toBe('done');
    expect(show(s.repo('a'), 'main:x.txt')).toBe('hola\n');
    expect(show(s.repo('b'), 'main:y.txt')).toBe('hola\n');
    expect(existsSync(t.worktreePath!)).toBe(false);
  });

  it('si la tarea de conflicto vuelve a chocar en un repo del padre, lo hace suyo y se reencola', async () => {
    const s = setup();
    const t = await inReview(s);
    commitOn(s.repo('b'), 'y.txt', 'otra cosa\n', 'main de b crea y distinto');
    const r = await integrate({ ...s, enqueue: undefined }, t.id, { userApproved: true });
    const childId = (r as { followUpTaskId: string }).followUpTaskId;
    // Nivel 1 para que se quede en revisión al terminar.
    s.store.updateTask(childId, { level: 1 });
    s.env.FAKE_WRITE = 'b/y.txt';
    delete s.env.FAKE_WRITE_ARTIFACT;
    s.orch.enqueue(childId);
    await s.orch.waitIdle();
    expect(s.store.getTask(childId).state).toBe('review');
    commitOn(s.repo('a'), 'x.txt', 'otra cosa\n', 'main de a crea x distinto');
    const queued: string[] = [];
    const again = await integrate({ ...s, enqueue: (id) => { queued.push(id); } }, childId, { userApproved: true });
    expect(again).toEqual({ status: 'conflict', followUpTaskId: childId });
    expect(queued).toEqual([childId]);
    expect(s.store.getTask(childId).repos).toEqual(['a', 'b']);
    expect(s.store.listComments(childId).at(-1)?.body).toMatch(/^La rama base ha vuelto a cambiar \(a: main, intento 1 de 3\)/);
    expect(show(s.repo('b'), 'main:y.txt')).toBe('otra cosa\n');
  });

  it('push multi-repo: si falla el segundo, el primero queda subido, la aprobación sigue pendiente y reintentar sube el que falta', async () => {
    const s = setup();
    const t = await inReview(s);
    await s.actions.approve(t.id);
    expect(s.store.listPendingApprovals('multi', 'push').map((a) => a.taskId)).toEqual([t.id]);
    const realB = s.origins.b;
    gitSync(s.repo('b'), 'remote', 'set-url', 'origin', path.join(tmpDir(), 'no-existe.git'));

    const err = await s.actions.pushProject('multi').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as Error).message).toMatch(/^Subidos: a\. Falta: b \(.+\)\. Reintenta para subir lo que falta\.$/s);
    expect(show(s.origins.a, 'main:x.txt')).toBe('hola\n');
    expect(show(realB, 'main:y.txt')).toBeNull();
    expect(s.store.listPendingApprovals('multi', 'push').map((a) => a.taskId)).toEqual([t.id]);

    gitSync(s.repo('b'), 'remote', 'set-url', 'origin', realB);
    await s.actions.pushProject('multi');
    expect(show(realB, 'main:y.txt')).toBe('x');
    expect(s.store.listPendingApprovals('multi', 'push')).toEqual([]);
    expect(s.store.listApprovals(t.id).find((a) => a.action === 'push')?.state).toBe('approved');
  });

  it('push multi-repo: un repo sin commits por delante no se sube', async () => {
    const s = setup();
    const t = await inReview(s, 'Solo a', { repos: ['a'] });
    await s.actions.approve(t.id);
    // Si se intentara subir b, fallaría: su remoto ya no existe.
    gitSync(s.repo('b'), 'remote', 'set-url', 'origin', path.join(tmpDir(), 'no-existe.git'));
    await s.actions.pushProject('multi');
    expect(show(s.origins.a, 'main:x.txt')).toBe('hola\n');
    expect(s.store.listApprovals(t.id).find((a) => a.action === 'push')?.state).toBe('approved');
  });

  it('approvePush multi-repo informa de lo que falta y deja la aprobación pendiente', async () => {
    const s = setup();
    const t = await inReview(s);
    await s.actions.approve(t.id);
    gitSync(s.repo('a'), 'remote', 'set-url', 'origin', path.join(tmpDir(), 'no-existe.git'));
    const err = await s.actions.approvePush(t.id).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^Subidos: b\. Falta: a \(.+\)\. Reintenta/s);
    expect(s.store.listApprovals(t.id).find((a) => a.action === 'push')?.state).toBe('pending');
  });

  it('nivel 4: el push automático incompleto lo deja comentado y pendiente', async () => {
    const s = setup();
    gitSync(s.repo('b'), 'remote', 'set-url', 'origin', path.join(tmpDir(), 'no-existe.git'));
    const t = s.actions.createTask({ projectId: 'multi', title: 'Dos repos', description: '', profileId: 'dev', level: 4 });
    await s.orch.waitIdle();
    expect(s.store.getTask(t.id).state).toBe('done');
    expect(show(s.origins.a, 'main:x.txt')).toBe('hola\n');
    expect(s.store.listApprovals(t.id).find((a) => a.action === 'push')?.state).toBe('pending');
    expect(s.store.listComments(t.id).some((c) => c.body.includes('Subidos: a. Falta: b'))).toBe(true);
  });

  it('dos tareas del mismo proyecto que integran a la vez se serializan', async () => {
    const events: string[] = [];
    const real = new GitWorkspaces();
    const ws = Object.create(real) as GitWorkspaces;
    ws.updateBranch = async (p, task) => {
      events.push(`update ${task.id}`);
      await new Promise((r) => setTimeout(r, 50));
      return real.updateBranch(p, task);
    };
    ws.cleanup = async (p, task) => {
      events.push(`cleanup ${task.id}`);
      return real.cleanup(p, task);
    };
    const s = setup({ workspaces: ws });
    const t1 = await inReview(s, 'Primera', { repos: ['a'] });
    s.env.FAKE_WRITE = 'a/z.txt';
    const t2 = await inReview(s, 'Segunda');
    events.length = 0;
    const [r1, r2] = await Promise.all([
      integrate(s, t1.id, { userApproved: true }),
      integrate(s, t2.id, { userApproved: true }),
    ]);
    expect(r1.status).toBe('merged');
    expect(r2.status).toBe('merged');
    const lastOf1 = events.lastIndexOf(`cleanup ${t1.id}`);
    const firstOf2 = events.indexOf(`update ${t2.id}`);
    expect(lastOf1).toBeGreaterThanOrEqual(0);
    expect(firstOf2).toBeGreaterThan(lastOf1);
    expect(show(s.repo('a'), 'main:x.txt')).toBe('hola\n');
    expect(show(s.repo('a'), 'main:z.txt')).toBe('hola\n');
  });

  it('pruneClosedWorktrees borra la carpeta de una tarea multi-repo hecha', async () => {
    const s = setup();
    const t = await inReview(s);
    s.store.setState(t.id, 'done');
    const removed = await pruneClosedWorktrees(s);
    expect(removed.length).toBeGreaterThanOrEqual(2);
    expect(existsSync(t.worktreePath!)).toBe(false);
    for (const id of ['a', 'b']) expect(gitSync(s.repo(id), 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('pruneClosedWorktrees no toca la carpeta de una tarea abierta', async () => {
    const s = setup();
    const t = await inReview(s);
    expect(await pruneClosedWorktrees(s)).toEqual([]);
    expect(existsSync(path.join(t.worktreePath!, 'a'))).toBe(true);
  });
});

describe('withProjectIntegrationLock', () => {
  it('espera en serie por proyecto, no rechaza y sigue tras un error', async () => {
    const log: string[] = [];
    const step = (name: string, ms: number, fail = false) => async () => {
      log.push(`${name}+`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}-`);
      if (fail) throw new Error(name);
      return name;
    };
    const a = withProjectIntegrationLock('p', step('a', 30, true));
    const b = withProjectIntegrationLock('p', step('b', 10));
    const other = withProjectIntegrationLock('q', step('q', 5));
    await expect(a).rejects.toThrow('a');
    expect(await b).toBe('b');
    expect(await other).toBe('q');
    expect(log.indexOf('b+')).toBeGreaterThan(log.indexOf('a-'));
    expect(log.indexOf('q+')).toBeLessThan(log.indexOf('a-'));
  });
  it('el lanzamiento recibe el sha integrado del repo con release; sin ese repo en la tarea no se lanza', async () => {
    const s = setup();
    s.project.repos![1].release = { cwd: '.', build: 'b', submit: 's' };
    const calls: [string, string][] = [];
    const d = { ...s, releases: { afterIntegrate: (id: string, commit: string) => { calls.push([id, commit]); } } };
    const both = await inReview(s, 'Ambos', {});
    s.store.updateTask(both.id, { release: 'build' });
    await integrate(d, both.id, { userApproved: true });
    expect(calls).toEqual([[both.id, gitSync(s.repo('b'), 'rev-parse', 'main').trim()]]);
    expect(calls[0][1]).not.toBe(gitSync(s.repo('a'), 'rev-parse', 'main').trim());

    delete s.env.FAKE_WRITE_ARTIFACT;
    s.env.FAKE_WRITE = 'a/z.txt';
    const onlyA = await inReview(s, 'Solo a', { repos: ['a'] });
    s.store.updateTask(onlyA.id, { release: 'build' });
    await integrate(d, onlyA.id, { userApproved: true });
    expect(calls).toHaveLength(1);
    expect(s.store.listComments(onlyA.id).some((c) => c.body.includes('no incluye el repo que se publica'))).toBe(true);
  });
});
