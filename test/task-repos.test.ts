import { describe, expect, it } from 'vitest';
import { getProject } from '../src/server/config';
import { repoView, taskRepoIds, taskRepos } from '../src/server/task-repos';
import { makeConfig, makeMultiConfig, makeRepo, makeTask } from './helpers';

describe('task-repos', () => {
  it('taskRepos de un proyecto de un repo devuelve la tarea sin tocar', () => {
    const repo = makeRepo();
    const project = getProject(makeConfig(repo), 'demo');
    const task = makeTask({ worktreePath: '/w/DEM-1-x', branch: 'faro/DEM-1-x' });
    const out = taskRepos(project, task);
    expect(out).toHaveLength(1);
    expect(out[0]!.task.worktreePath).toBe('/w/DEM-1-x');
    expect(out[0]!.task.branch).toBe('faro/DEM-1-x');
    expect(out[0]!.prefix).toBe('');
    expect(out[0]!.project.repoPath).toBe(repo);
  });

  it('taskRepos multi-repo anida el worktree por repo', () => {
    const project = getProject(makeMultiConfig(), 'multi');
    const b = project.repos!.find((r) => r.id === 'b')!;
    const task = makeTask({ projectId: 'multi', worktreePath: '/w/ACM-1-x', branch: 'faro/ACM-1-x', repos: ['b'] });
    const out = taskRepos(project, task);
    expect(out).toHaveLength(1);
    expect(out[0]!.task.worktreePath).toBe('/w/ACM-1-x/b');
    expect(out[0]!.task.branch).toBe('faro/ACM-1-x');
    expect(out[0]!.prefix).toBe('b/');
    expect(out[0]!.project.repoPath).toBe(b.path);
    expect(out[0]!.project.checks).toEqual(b.checks);
    expect(out[0]!.project.repos).toEqual([b]);
  });

  it('taskRepos multi-repo sin worktreePath lo deja null', () => {
    const project = getProject(makeMultiConfig(), 'multi');
    const out = taskRepos(project, makeTask({ projectId: 'multi' }));
    expect(out.map((e) => [e.repo.id, e.task.worktreePath, e.prefix])).toEqual([['a', null, 'a/'], ['b', null, 'b/']]);
  });

  it('taskRepoIds con null devuelve todos y con un id desconocido lanza', () => {
    const project = getProject(makeMultiConfig(), 'multi');
    expect(taskRepoIds(project, { repos: null })).toEqual(['a', 'b']);
    expect(taskRepoIds(project, { repos: ['b'] })).toEqual(['b']);
    expect(() => taskRepoIds(project, { repos: ['zzz'] })).toThrow(/repo desconocido zzz/);
  });

  it('repoView no arrastra los campos de otros repos', () => {
    const project = getProject(makeMultiConfig(), 'multi');
    const view = repoView(project, project.repos![1]!);
    expect(view.repoPath).toBe(project.repos![1]!.path);
    expect(view.checks?.[0]?.name).toBe('cb');
    expect(view.id).toBe('multi');
  });
});
