import { join } from 'node:path';
import type { ProjectConfig, RepoConfig, Task } from './types';

export interface TaskRepo { repo: RepoConfig; project: ProjectConfig; task: Task; prefix: string }

/** Vista de un solo repo: campos sueltos = los del repo; repos = [repo]. Es una vista: no se vuelve a normalizar. */
export function repoView(project: ProjectConfig, repo: RepoConfig): ProjectConfig {
  const { prepare, exclude, checks, github, release, ...rest } = project;
  return {
    ...rest,
    repoPath: repo.path, baseBranch: repo.baseBranch, remote: repo.remote,
    ...(repo.prepare ? { prepare: repo.prepare } : {}),
    ...(repo.exclude ? { exclude: repo.exclude } : {}),
    ...(repo.checks ? { checks: repo.checks } : {}),
    ...(repo.github ? { github: repo.github } : {}),
    ...(repo.release ? { release: repo.release } : {}),
    repos: [repo],
  };
}

/** El único repo con `release` (del que salen los builds de EAS), o null si el proyecto no publica. */
export function releaseRepo(project: ProjectConfig): RepoConfig | null {
  return (project.repos ?? []).find((r) => r.release) ?? null;
}

/** Repos que usa la tarea (task.repos o, si es null, todos). Lanza si un id no existe en el proyecto. */
export function taskRepoIds(project: ProjectConfig, task: Pick<Task, 'repos'>): string[] {
  const all = (project.repos ?? []).map((r) => r.id);
  if (task.repos === null) return all;
  if (task.repos.length === 0) throw new Error(`Proyecto ${project.id}: la tarea necesita al menos un repo`);
  for (const id of task.repos) {
    if (!all.includes(id)) throw new Error(`Proyecto ${project.id}: repo desconocido ${id}`);
  }
  return task.repos;
}

/**
 * Una entrada por repo de la tarea. Un repo: task tal cual, prefix ''. Multi-repo: worktreePath anidado por repo
 * (si la tarea tiene worktreePath), branch igual, prefix `${repo.id}/`.
 */
export function taskRepos(project: ProjectConfig, task: Task): TaskRepo[] {
  const repos = project.repos ?? [];
  const multi = repos.length > 1;
  return taskRepoIds(project, task).map((id) => {
    const repo = repos.find((r) => r.id === id)!;
    return {
      repo, project: repoView(project, repo), prefix: multi ? `${repo.id}/` : '',
      task: multi && task.worktreePath ? { ...task, worktreePath: join(task.worktreePath, repo.id) } : task,
    };
  });
}
