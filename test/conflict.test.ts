import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReviewActions } from '../src/server/actions';
import { Bus } from '../src/server/bus';
import { runTaskChecks } from '../src/server/checks';
import { isConflictTask } from '../src/server/integrate';
import { Orchestrator } from '../src/server/orchestrator';
import { Runner, type RunInput } from '../src/server/runner/runner';
import { Store } from '../src/server/store';
import { GitWorkspaces } from '../src/server/workspaces';
import { fixture, gitSync, makeConfig, makeRepo, tmpDir } from './helpers';

/** Faro con el agente falso; `env` es mutable para cambiar lo que hace el agente entre tareas. */
function setup() {
  const repo = makeRepo();
  const config = makeConfig(repo);
  const store = new Store(':memory:');
  const bus = new Bus();
  const workspaces = new GitWorkspaces();
  const stdin = path.join(tmpDir(), 'stdin.jsonl');
  const env: Record<string, string> = { FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt', FAKE_STDIN_OUT: stdin };
  const real = new Runner({ store, bus, claudeBin: config.claudeBin, env, killGraceMs: 100 });
  // Lo que ve el agente al arrancar cada tarea: contenido de hola.txt y si hay un merge a medias.
  const seen = new Map<string, { hola: string | null; midMerge: boolean }>();
  const hooks: { beforeRun?: (input: RunInput) => void } = {};
  const runner = {
    run: (input: RunInput) => {
      hooks.beforeRun?.(input);
      const file = path.join(input.cwd, 'hola.txt');
      const midMerge = (() => {
        try { gitSync(input.cwd, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'); return true; } catch { return false; }
      })();
      seen.set(input.taskId, { hola: existsSync(file) ? readFileSync(file, 'utf8') : null, midMerge });
      return real.run(input);
    },
    cancel: (id: string) => real.cancel(id),
  };
  const orch = new Orchestrator({ store, config, bus, runner, workspaces, runChecks: runTaskChecks, setTimer: () => {} });
  const actions = new ReviewActions({ store, config, bus, workspaces, orchestrator: orch, runner: real });
  const prompts = () => readFileSync(stdin, 'utf8').trim().split('\n').map((l) => JSON.stringify(JSON.parse(l)));
  return { repo, config, store, orch, actions, env, seen, prompts, hooks };
}

function commitOnMain(repo: string, content: string, msg: string) {
  writeFileSync(path.join(repo, 'hola.txt'), content);
  gitSync(repo, 'add', '.');
  gitSync(repo, 'commit', '-qm', msg);
}

/**
 * Tarea en revisión que crea hola.txt, main crea otro hola.txt y aprobar crea la tarea de conflicto,
 * que Faro pone en cola solo. `checks` se activan después de la tarea padre (para que ella no se integre sola).
 */
async function withConflict(opts: { checks?: boolean; beforeApprove?: (s: ReturnType<typeof setup>) => void } = {}) {
  const s = setup();
  const parent = s.actions.createTask({ projectId: 'demo', title: 'Crear hola', description: '', profileId: 'dev' });
  await s.orch.waitIdle();
  if (opts.checks) s.config.projects[0].checks = [{ name: 'Siempre bien', command: 'true' }];
  commitOnMain(s.repo, 'otra cosa\n', 'main crea hola distinto');
  opts.beforeApprove?.(s);
  const r = await s.actions.approve(parent.id);
  expect(r.status).toBe('conflict');
  const childId = (r as { followUpTaskId: string }).followUpTaskId;
  const queuedAtStart = s.store.getTask(childId).state;
  await s.orch.waitIdle();
  return { ...s, parentId: parent.id, childId, queuedAtStart };
}

describe('tareas de conflicto', () => {
  it('la descripción explica que Faro hace el merge y el agente solo edita', async () => {
    const { store, childId } = await withConflict();
    const d = store.getTask(childId).description;
    expect(d).toContain('Faro hace merge de main');
    expect(d).toContain('No ejecutes git merge');
    expect(d).not.toContain('Haz merge');
  });

  it('se pone en cola sola, sin borrador, con nivel suficiente para integrarse sola', async () => {
    const { store, parentId, childId, queuedAtStart } = await withConflict();
    expect(queuedAtStart).not.toBe('draft');
    expect(store.getTask(childId).level).toBeGreaterThanOrEqual(2);
    expect(store.listComments(parentId).some((c) => c.body.includes('la he puesto en cola'))).toBe(true);
  });

  it('arranca con el merge de main ya hecho y los marcadores en el worktree', async () => {
    const { store, seen, prompts, childId } = await withConflict();
    const atStart = seen.get(childId)!;
    expect(atStart.midMerge).toBe(true);
    expect(atStart.hola).toMatch(/^<<<<<<< /m);
    expect(atStart.hola).toMatch(/^>>>>>>> main$/m);
    expect(prompts().at(-1)).toContain('han quedado conflictos en:\\n- hola.txt');
    expect(store.getTask(childId).state).toBe('review');
  });

  it('al terminar Faro cierra el merge, commitea y se integra en main', async () => {
    const { repo, store, actions, childId } = await withConflict();
    const child = store.getTask(childId);
    // El commit de Faro cierra el merge: tiene dos padres y main es antecesor de la rama.
    expect(gitSync(child.worktreePath!, 'rev-list', '--parents', '-n1', 'HEAD').trim().split(' ')).toHaveLength(3);
    expect(() => gitSync(repo, 'merge-base', '--is-ancestor', 'main', child.branch!)).not.toThrow();
    expect(await actions.approve(childId)).toEqual({ status: 'merged', pushed: false });
    expect(store.getTask(childId).state).toBe('done');
    expect(gitSync(repo, 'show', 'main:hola.txt')).toBe('hola\n');
  });

  it('con las comprobaciones en verde se integra sola y cierra también la tarea padre', async () => {
    const { repo, store, parentId, childId } = await withConflict({ checks: true });
    expect(store.getTask(childId).state).toBe('done');
    expect(store.getTask(parentId).state).toBe('done');
    expect(store.listComments(parentId).at(-1)?.body).toContain(childId);
    expect(gitSync(repo, 'show', 'main:hola.txt')).toBe('hola\n');
  });

  it('si el agente deja marcadores, se bloquea sin commitear', async () => {
    const { store, childId } = await withConflict({ beforeApprove: (s) => { delete s.env.FAKE_WRITE; } });
    const child = store.getTask(childId);
    expect(child.state).toBe('blocked');
    expect(child.blockedReason).toContain('hola.txt');
    expect(() => gitSync(child.worktreePath!, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).not.toThrow();
  });

  it('main vuelve a cambiar: no anida, se reencola sola y Faro vuelve a hacer el merge', async () => {
    const { repo, store, orch, actions, parentId, childId } = await withConflict();
    commitOnMain(repo, 'y otra más\n', 'main vuelve a cambiar hola');
    const before = store.listTasks().length;
    const r = await actions.approve(childId);
    expect(r).toEqual({ status: 'conflict', followUpTaskId: childId });
    expect(store.listTasks()).toHaveLength(before);
    expect(store.getTask(childId).state).toBe('queued');
    expect(store.getTask(parentId).state).toBe('review');
    await orch.waitIdle();
    expect(store.listRuns(childId)).toHaveLength(2);
    expect(store.getTask(childId).state).toBe('review');
    expect(await actions.approve(childId)).toEqual({ status: 'merged', pushed: false });
    expect(gitSync(repo, 'show', 'main:hola.txt')).toBe('hola\n');
    expect(store.getTask(parentId).state).toBe('done');
  });

  it('si main sigue cambiando, tras 3 reintentos se bloquea y avisa', async () => {
    let n = 0;
    const { store, childId } = await withConflict({
      checks: true,
      beforeApprove: (s) => {
        // Cada vez que arranca la tarea de conflicto, main cambia otra vez hola.txt.
        s.hooks.beforeRun = (input) => { if (input.taskId !== 'DEM-1') commitOnMain(s.repo, `cambio ${++n}\n`, `main cambia ${n}`); };
      },
    });
    const child = store.getTask(childId);
    expect(store.listRuns(childId)).toHaveLength(4);
    expect(child.state).toBe('blocked');
    expect(child.blockedReason).toContain('ha vuelto a cambiar');
  });

  it('si el worktree compartido ha desaparecido, Faro lo vuelve a crear antes de lanzar', async () => {
    const { repo, store, orch, actions, childId } = await withConflict();
    const wt = store.getTask(childId).worktreePath!;
    gitSync(repo, 'worktree', 'remove', '--force', wt);
    actions.message(childId, 'Sigue');
    await orch.waitIdle();
    expect(store.getTask(childId).state).toBe('review');
    expect(existsSync(wt)).toBe(true);
    expect(gitSync(wt, 'branch', '--show-current').trim()).toBe(store.getTask(childId).branch);
  });

  it('aprobar otra vez el padre con un conflicto abierto no crea otra tarea de conflicto', async () => {
    const { store, actions, parentId, childId } = await withConflict();
    const before = store.listTasks().length;
    const r = await actions.approve(parentId);
    expect(r.status).toBe('failed');
    expect((r as { message: string }).message).toContain(childId);
    expect(store.listTasks()).toHaveLength(before);
    expect(store.getTask(parentId).state).toBe('review');
  });

  it('al integrarse una tarea de conflicto descarta las demás que quedaban sobre la misma rama', async () => {
    const { config, store, actions, parentId, childId } = await withConflict();
    const child = store.getTask(childId);
    const dup = store.updateTask(store.createTask(config.projects[0], {
      title: 'Resolver conflicto: duplicada', description: '', profileId: 'dev', level: 2, parentId,
    }).id, { branch: child.branch, worktreePath: child.worktreePath });
    expect(await actions.approve(childId)).toEqual({ status: 'merged', pushed: false });
    expect(store.getTask(dup.id).state).toBe('discarded');
    expect(store.listComments(dup.id).at(-1)?.body).toContain(childId);
    expect(store.getTask(parentId).state).toBe('done');
  });

  it('isConflictTask: solo las hijas que comparten rama con el padre', () => {
    const store = new Store(':memory:');
    const project = makeConfig(makeRepo()).projects[0];
    const parent = store.updateTask(store.createTask(project, { title: 'P', description: '', profileId: 'dev', level: 2 }).id, { branch: 'b1' });
    const sub = store.updateTask(store.createTask(project, { title: 'S', description: '', profileId: 'dev', level: 2, parentId: parent.id }).id, { branch: 'b2' });
    const conflict = store.updateTask(store.createTask(project, { title: 'C', description: '', profileId: 'dev', level: 2, parentId: parent.id }).id, { branch: 'b1' });
    expect(isConflictTask(store, parent)).toBe(false);
    expect(isConflictTask(store, sub)).toBe(false);
    expect(isConflictTask(store, conflict)).toBe(true);
  });
});
