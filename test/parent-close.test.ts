import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReviewActions } from '../src/server/actions';
import { Bus } from '../src/server/bus';
import { runChecks } from '../src/server/checks';
import { Orchestrator } from '../src/server/orchestrator';
import { Runner } from '../src/server/runner/runner';
import { Store } from '../src/server/store';
import { GitWorkspaces } from '../src/server/workspaces';
import { pruneClosedWorktrees, sweepFinishedParents } from '../src/server/housekeeping';
import type { TaskState } from '../src/server/types';
import { fixture, gitSync, makeConfig, makeRepo } from './helpers';

/** Faro con el agente falso que termina sin tocar nada (las hijas se cierran solas). */
function setup() {
  const repo = makeRepo();
  const config = makeConfig(repo);
  const store = new Store(':memory:');
  const bus = new Bus();
  const workspaces = new GitWorkspaces();
  const env: Record<string, string> = { FAKE_FIXTURES: fixture('stream-done.jsonl') };
  const runner = new Runner({ store, bus, claudeBin: config.claudeBin, env, killGraceMs: 100 });
  const orch = new Orchestrator({ store, config, bus, runner, workspaces, runChecks, setTimer: () => {} });
  const actions = new ReviewActions({ store, config, bus, workspaces, orchestrator: orch, runner });
  return { repo, config, store, orch, actions };
}

/** Padre en revisión con su rama; `ownChange` le añade un commit propio. */
function parentInReview(s: ReturnType<typeof setup>, ownChange = false) {
  const branch = 'padre';
  gitSync(s.repo, 'branch', branch, 'main');
  if (ownChange) {
    gitSync(s.repo, 'checkout', '-q', branch);
    writeFileSync(path.join(s.repo, 'propio.txt'), 'x\n');
    gitSync(s.repo, 'add', '.');
    gitSync(s.repo, 'commit', '-qm', 'cambio del padre');
    gitSync(s.repo, 'checkout', '-q', 'main');
  }
  const p = s.store.createTask(s.config.projects[0], { title: 'Padre', description: '', profileId: 'dev', level: 2 });
  s.store.updateTask(p.id, { branch, worktreePath: path.join(s.repo, '..', 'no-existe') });
  for (const st of ['queued', 'working', 'review'] as const) s.store.setState(p.id, st);
  return p.id;
}

const child = (s: ReturnType<typeof setup>, parentId: string, title: string, draft = false) =>
  s.actions.createTask({ projectId: 'demo', title, description: '', profileId: 'dev', parentId, draft }).id;

describe('cierre del padre cuando terminan sus hijas', () => {
  it('sin cambios propios, se cierra cuando la última hija termina', async () => {
    const s = setup();
    const parentId = parentInReview(s);
    const a = child(s, parentId, 'Hija A');
    const b = child(s, parentId, 'Hija B', true);
    await s.orch.waitIdle();
    expect(s.store.getTask(a).state).toBe('done');
    expect(s.store.getTask(parentId).state).toBe('review');
    s.actions.approveDraft(b);
    await s.orch.waitIdle();
    expect(s.store.getTask(b).state).toBe('done');
    expect(s.store.getTask(parentId).state).toBe('done');
    expect(s.store.listComments(parentId).some((c) => c.author === 'faro' && c.body.includes('todas sus subtareas'))).toBe(true);
  });

  it('una hija descartada cuenta como terminada', async () => {
    const s = setup();
    const parentId = parentInReview(s);
    child(s, parentId, 'Hija A');
    const b = child(s, parentId, 'Hija B', true);
    await s.orch.waitIdle();
    await s.actions.discard(b);
    expect(s.store.getTask(parentId).state).toBe('done');
  });

  it('con cambios propios sigue en revisión y avisa una sola vez', async () => {
    const s = setup();
    const parentId = parentInReview(s, true);
    child(s, parentId, 'Hija A');
    await s.orch.waitIdle();
    expect(s.store.getTask(parentId).state).toBe('review');
    const notes = () => s.store.listComments(parentId).filter((c) => c.author === 'faro' && c.body.includes('cambios propios'));
    expect(notes()).toHaveLength(1);
    child(s, parentId, 'Hija B');
    await s.orch.waitIdle();
    expect(notes()).toHaveLength(1);
  });
});

describe('limpieza al arrancar', () => {
  it('sweepFinishedParents cierra un padre cuyas hijas ya estaban hechas', async () => {
    const s = setup();
    const parentId = parentInReview(s);
    const c = s.store.createTask(s.config.projects[0], { title: 'Hija', description: '', profileId: 'dev', level: 2, parentId });
    for (const st of ['queued', 'working', 'review', 'done'] as const) s.store.setState(c.id, st);
    await sweepFinishedParents({ store: s.store, config: s.config, workspaces: new GitWorkspaces(), bus: new Bus() });
    expect(s.store.getTask(parentId).state).toBe('done');
  });

  it('pruneClosedWorktrees borra los de tareas cerradas y deja los abiertos, los sucios y los ajenos', async () => {
    const s = setup();
    const ws = new GitWorkspaces();
    const project = s.config.projects[0];
    const mk = async (title: string, final: 'done' | 'review' | null) => {
      const t = s.store.createTask(project, { title, description: '', profileId: 'dev', level: 2 });
      const wt = await ws.create(project, t);
      s.store.updateTask(t.id, { worktreePath: wt.path, branch: wt.branch });
      const states: TaskState[] = final === 'done' ? ['queued', 'working', 'review', 'done'] : final ? ['queued', 'working', 'review'] : [];
      for (const st of states) s.store.setState(t.id, st);
      return wt.path;
    };
    const closed = await mk('Cerrada', 'done');
    const open = await mk('Abierta', 'review');
    const dirty = await mk('Sucia', 'done');
    writeFileSync(path.join(dirty, 'sin-commitear.txt'), 'x\n');
    const foreign = path.join(project.worktreesDir, 'ajeno');
    gitSync(s.repo, 'worktree', 'add', '-q', '--detach', foreign, 'main');
    const removed = await pruneClosedWorktrees({ store: s.store, config: s.config, workspaces: ws });
    expect(removed).toHaveLength(1);
    expect(existsSync(closed)).toBe(false);
    for (const p of [open, dirty, foreign]) expect(existsSync(p)).toBe(true);
  });
});
