import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionError } from '../src/server/errors';
import { ReviewActions } from '../src/server/actions';
import { Bus } from '../src/server/bus';
import { runChecks } from '../src/server/checks';
import { Orchestrator } from '../src/server/orchestrator';
import { Runner } from '../src/server/runner/runner';
import { Store } from '../src/server/store';
import { GitWorkspaces } from '../src/server/workspaces';
import { fixture, gitSync, makeConfig, makeRepo, tmpDir } from './helpers';

/** Repo con un origin desnudo al día; las tareas crean hola.txt y quedan en revisión. */
function setup() {
  const repo = makeRepo();
  const origin = path.join(tmpDir(), 'origin.git');
  gitSync(repo, 'init', '-q', '--bare', origin);
  gitSync(repo, 'remote', 'add', 'origin', origin);
  gitSync(repo, 'push', '-q', 'origin', 'main');
  const config = makeConfig(repo);
  const store = new Store(':memory:');
  const bus = new Bus();
  const workspaces = new GitWorkspaces();
  const runner = new Runner({ store, bus, claudeBin: config.claudeBin, env: { FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' }, killGraceMs: 100 });
  const orch = new Orchestrator({ store, config, bus, runner, workspaces, runChecks, setTimer: () => {} });
  const actions = new ReviewActions({ store, config, bus, workspaces, orchestrator: orch, runner });
  return { repo, origin, store, actions, orch, workspaces, config };
}

describe('subir todo el proyecto de una vez', () => {
  it('cuenta los commits por delante, sube main y aprueba todos los push pendientes', async () => {
    const s = setup();
    const project = s.config.projects[0];
    expect(await s.workspaces.ahead(project)).toBe(0);
    const t = s.actions.createTask({ projectId: 'demo', title: 'Crear hola', description: '', profileId: 'dev' });
    await s.orch.waitIdle();
    await s.actions.approve(t.id);
    expect(await s.workspaces.ahead(project)).toBe(1);
    expect(s.store.listPendingApprovals('demo', 'push').map((a) => a.taskId)).toEqual([t.id]);

    await s.actions.pushProject('demo');
    expect(await s.workspaces.ahead(project)).toBe(0);
    expect(gitSync(s.origin, 'log', '-1', '--format=%s', 'main').trim()).toBe(`${t.id}: Crear hola`);
    expect(s.store.listPendingApprovals('demo', 'push')).toEqual([]);
    expect(s.store.listApprovals(t.id).find((a) => a.action === 'push')?.state).toBe('approved');
  });

  it('sin nada que subir, se rechaza', async () => {
    const s = setup();
    await expect(s.actions.pushProject('demo')).rejects.toBeInstanceOf(ActionError);
  });

  it('si origin tiene commits que main no tiene, los fusiona y vuelve a subir', async () => {
    const s = setup();
    // Otro equipo (o un PR fusionado en GitHub) sube un commit a origin.
    const other = path.join(tmpDir(), 'otro');
    gitSync(s.repo, 'clone', '-q', s.origin, other);
    writeFileSync(path.join(other, 'remoto.txt'), 'de github\n');
    gitSync(other, 'add', '.');
    gitSync(other, '-c', 'user.email=o@x', '-c', 'user.name=Otro', 'commit', '-qm', 'cambio en github');
    gitSync(other, 'push', '-q', 'origin', 'main');
    const t = s.actions.createTask({ projectId: 'demo', title: 'Crear hola', description: '', profileId: 'dev' });
    await s.orch.waitIdle();
    await s.actions.approve(t.id);
    await s.actions.pushProject('demo');
    expect(gitSync(s.origin, 'show', 'main:remoto.txt')).toBe('de github\n');
    expect(gitSync(s.origin, 'show', 'main:hola.txt')).toBe('hola\n');
    expect(s.store.listPendingApprovals('demo', 'push')).toEqual([]);
  });

  it('si lo de origin choca con main, falla sin dejar el merge a medias', async () => {
    const s = setup();
    const other = path.join(tmpDir(), 'otro');
    gitSync(s.repo, 'clone', '-q', s.origin, other);
    writeFileSync(path.join(other, 'hola.txt'), 'otra cosa\n');
    gitSync(other, 'add', '.');
    gitSync(other, '-c', 'user.email=o@x', '-c', 'user.name=Otro', 'commit', '-qm', 'hola distinto en github');
    gitSync(other, 'push', '-q', 'origin', 'main');
    const t = s.actions.createTask({ projectId: 'demo', title: 'Crear hola', description: '', profileId: 'dev' });
    await s.orch.waitIdle();
    await s.actions.approve(t.id);
    await expect(s.actions.pushProject('demo')).rejects.toThrow(/choca/);
    expect(() => gitSync(s.repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
    expect(s.store.listPendingApprovals('demo', 'push')).toHaveLength(1);
  });
});
