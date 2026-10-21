import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProject } from '../src/server/config';
import {
  cleanupTask, commitTask, createChatWorkspace, createTaskWorkspace, diffTask, discardTask, refreshChatWorkspace,
  restoreTaskWorkspace, saveTaskWork, taskWorkspaceExists, unresolvedTask,
} from '../src/server/task-workspace';
import type { ProjectConfig, Task } from '../src/server/types';
import { GitWorkspaces, type Workspaces } from '../src/server/workspaces';
import { gitSync, makeConfig, makeMultiConfig, makeRepo, makeTask, tmpDir } from './helpers';

const ws = new GitWorkspaces();

function multi() {
  return getProject(makeMultiConfig(), 'multi');
}

function repoPath(project: ProjectConfig, id: string): string {
  return project.repos!.find((r) => r.id === id)!.path;
}

async function created(project: ProjectConfig, over: Partial<Task> = {}): Promise<Task> {
  const task = makeTask({ id: 'MUL-1', projectId: project.id, title: 'Varios repos', ...over });
  const wt = await createTaskWorkspace(ws, project, task);
  return { ...task, branch: wt.branch, worktreePath: wt.path };
}

/** Registra las llamadas a cada método de `inner` (con sus argumentos) y delega en él. */
function recording(inner: Workspaces): { ws: Workspaces; calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => { calls.push([String(prop), args]); return v.apply(target, args); };
    },
  });
  return { ws: proxy, calls };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errorSpy.mockRestore(); });

describe('createTaskWorkspace · multi-repo', () => {
  it('createTaskWorkspace multi crea un worktree por repo en la misma rama', async () => {
    const project = multi();
    const task = await created(project);
    expect(task.branch).toBe('MUL-1-varios-repos');
    expect(task.worktreePath).toBe(path.join(project.worktreesDir, 'MUL-1-varios-repos'));
    for (const id of ['a', 'b']) {
      expect(existsSync(path.join(task.worktreePath!, id, 'README.md'))).toBe(true);
      expect(gitSync(path.join(task.worktreePath!, id), 'branch', '--show-current').trim()).toBe(task.branch);
    }
    expect(taskWorkspaceExists(project, task)).toBe(true);
  });

  it('createTaskWorkspace solo crea los repos de la tarea', async () => {
    const project = multi();
    const task = await created(project, { repos: ['b'] });
    expect(existsSync(path.join(task.worktreePath!, 'b', 'README.md'))).toBe(true);
    expect(existsSync(path.join(task.worktreePath!, 'a'))).toBe(false);
    expect(gitSync(repoPath(project, 'a'), 'branch', '--list', task.branch!).trim()).toBe('');
  });

  it('createTaskWorkspace copia el CLAUDE.md de rootPath con copyRootClaudeMd', async () => {
    const project = multi();
    const root = tmpDir('faro-root-');
    writeFileSync(path.join(root, 'CLAUDE.md'), '# Acme\n');
    project.rootPath = root;
    project.copyRootClaudeMd = true;
    const task = await created(project);
    expect(readFileSync(path.join(task.worktreePath!, 'CLAUDE.md'), 'utf8')).toBe('# Acme\n');
  });

  it('por defecto no copia el CLAUDE.md de rootPath (ni al crear, ni al restaurar, ni en el chat)', async () => {
    const project = multi();
    const root = tmpDir('faro-root-');
    writeFileSync(path.join(root, 'CLAUDE.md'), '# plantilla ajena\n');
    project.rootPath = root;
    const task = await created(project);
    expect(existsSync(path.join(task.worktreePath!, 'CLAUDE.md'))).toBe(false);
    await ws.removeWorktree({ ...project, repoPath: repoPath(project, 'b') }, path.join(task.worktreePath!, 'b'));
    await restoreTaskWorkspace(ws, project, task);
    expect(existsSync(path.join(task.worktreePath!, 'CLAUDE.md'))).toBe(false);
    const chat = await createChatWorkspace(ws, project, makeTask({ id: 'MUL-9', projectId: project.id, kind: 'chat' }));
    expect(existsSync(path.join(chat, 'CLAUDE.md'))).toBe(false);
  });

  it('sin CLAUDE.md en rootPath no copia nada', async () => {
    const project = multi();
    project.rootPath = tmpDir('faro-root-');
    const task = await created(project);
    expect(existsSync(path.join(task.worktreePath!, 'CLAUDE.md'))).toBe(false);
  });

  it('si prepare falla en el segundo repo, no queda ningún worktree ni rama', async () => {
    const project = multi();
    project.repos![1].prepare = ['exit 9'];
    const task = makeTask({ id: 'MUL-1', projectId: project.id, title: 'Varios repos' });
    const branch = 'MUL-1-varios-repos';
    await expect(createTaskWorkspace(ws, project, task)).rejects.toThrow(/preparación/);
    expect(existsSync(path.join(project.worktreesDir, branch))).toBe(false);
    for (const id of ['a', 'b']) {
      expect(gitSync(repoPath(project, id), 'branch', '--list', branch).trim()).toBe('');
      expect(gitSync(repoPath(project, id), 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    }
    // Se puede reintentar.
    project.repos![1].prepare = [];
    const wt = await createTaskWorkspace(ws, project, task);
    expect(existsSync(path.join(wt.path, 'b', 'README.md'))).toBe(true);
  });

  it('createTaskWorkspace parte de origin/main aunque la main local vaya por detrás', async () => {
    const project = multi();
    const a = repoPath(project, 'a');
    const bare = tmpDir('faro-remote-');
    gitSync(bare, 'init', '-q', '--bare', '-b', 'main');
    gitSync(a, 'remote', 'add', 'origin', bare);
    gitSync(a, 'push', '-q', 'origin', 'main');
    const other = tmpDir('faro-clone-');
    gitSync(other, 'clone', '-q', bare, '.');
    gitSync(other, 'config', 'user.name', 'Otro');
    gitSync(other, 'config', 'user.email', 'otro@test.local');
    writeFileSync(path.join(other, 'remoto.txt'), 'nuevo\n');
    gitSync(other, 'add', '.');
    gitSync(other, 'commit', '-qm', 'desde otro clon');
    gitSync(other, 'push', '-q', 'origin', 'main');
    const task = await created(project);
    expect(readFileSync(path.join(task.worktreePath!, 'a', 'remoto.txt'), 'utf8')).toBe('nuevo\n');
    // El repo b no tiene remoto: su syncBase falla, se avisa y se sigue.
    expect(existsSync(path.join(task.worktreePath!, 'b', 'README.md'))).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('commit, diff y conflictos · multi-repo', () => {
  it('commitTask commitea en cada repo y devuelve si alguno commiteó', async () => {
    const project = multi();
    const task = await created(project);
    expect(await commitTask(ws, project, task, 'nada')).toBe(false);
    writeFileSync(path.join(task.worktreePath!, 'b', 'y.txt'), 'y\n');
    expect(await commitTask(ws, project, task, 'MUL-1: y')).toBe(true);
    expect(gitSync(path.join(task.worktreePath!, 'b'), 'log', '-1', '--format=%s').trim()).toBe('MUL-1: y');
    expect(gitSync(path.join(task.worktreePath!, 'a'), 'log', '-1', '--format=%s').trim()).toBe('inicio');
  });

  it('diffTask antepone el repo a archivos y patch', async () => {
    const project = multi();
    const task = await created(project);
    writeFileSync(path.join(task.worktreePath!, 'a', 'x.txt'), 'x\n');
    await commitTask(ws, project, task, 'MUL-1: x');
    const d = await diffTask(ws, project, task);
    expect(d.files).toEqual(['a/x.txt']);
    expect(d.patch).toContain('b/a/x.txt');
    expect(d.byRepo.a).toEqual(['x.txt']);
    expect(d.byRepo.b).toEqual([]);
  });

  it('unresolvedTask devuelve los archivos con marcadores con el prefijo del repo', async () => {
    const project = multi();
    const task = await created(project);
    const b = repoPath(project, 'b');
    writeFileSync(path.join(task.worktreePath!, 'b', 'README.md'), 'tarea\n');
    await commitTask(ws, project, task, 'MUL-1: tarea');
    writeFileSync(path.join(b, 'README.md'), 'main\n');
    gitSync(b, 'commit', '-qam', 'main');
    const tb = { ...task, worktreePath: path.join(task.worktreePath!, 'b') };
    const view = { ...project, repoPath: b };
    expect((await ws.mergeBaseInto(view, tb)).status).toBe('conflict');
    expect(await unresolvedTask(ws, project, task)).toEqual(['b/README.md']);
  });
});

describe('restore, chat, cleanup y discard · multi-repo', () => {
  it('restoreTaskWorkspace rehace solo los worktrees que faltan', async () => {
    const project = multi();
    const task = await created(project);
    writeFileSync(path.join(task.worktreePath!, 'a', 'queda.txt'), 'sin commitear\n');
    await ws.removeWorktree({ ...project, repoPath: repoPath(project, 'b') }, path.join(task.worktreePath!, 'b'));
    expect(taskWorkspaceExists(project, task)).toBe(false);
    await restoreTaskWorkspace(ws, project, task);
    expect(taskWorkspaceExists(project, task)).toBe(true);
    expect(existsSync(path.join(task.worktreePath!, 'a', 'queda.txt'))).toBe(true);
    expect(gitSync(path.join(task.worktreePath!, 'b'), 'branch', '--show-current').trim()).toBe(task.branch);
  });

  it('createChatWorkspace crea un detached por repo y refreshChatWorkspace los pone en main', async () => {
    const project = multi();
    const root = tmpDir('faro-root-');
    writeFileSync(path.join(root, 'CLAUDE.md'), '# raíz\n');
    project.rootPath = root;
    project.copyRootClaudeMd = true;
    const task = makeTask({ id: 'MUL-2', projectId: project.id, kind: 'chat' });
    const p = await createChatWorkspace(ws, project, task);
    expect(p).toBe(path.join(project.worktreesDir, 'MUL-2-chat'));
    expect(existsSync(path.join(p, 'CLAUDE.md'))).toBe(true);
    for (const id of ['a', 'b']) expect(gitSync(path.join(p, id), 'branch', '--show-current').trim()).toBe('');
    const a = repoPath(project, 'a');
    writeFileSync(path.join(a, 'nuevo.txt'), 'n\n');
    gitSync(a, 'add', '.');
    gitSync(a, 'commit', '-qm', 'nuevo');
    await refreshChatWorkspace(ws, project, { ...task, worktreePath: p });
    expect(existsSync(path.join(p, 'a', 'nuevo.txt'))).toBe(true);
  });

  it('cleanupTask multi borra worktrees y carpeta', async () => {
    const project = multi();
    const root = tmpDir('faro-root-');
    writeFileSync(path.join(root, 'CLAUDE.md'), '# raíz\n');
    project.rootPath = root;
    // Carpetas de antes (con la copia del CLAUDE.md) también se limpian.
    project.copyRootClaudeMd = true;
    const task = await created(project);
    expect(existsSync(path.join(task.worktreePath!, 'CLAUDE.md'))).toBe(true);
    mkdirSync(path.join(task.worktreePath!, '.faro'), { recursive: true });
    await cleanupTask(ws, project, task);
    expect(existsSync(task.worktreePath!)).toBe(false);
    for (const id of ['a', 'b']) {
      expect(gitSync(repoPath(project, id), 'branch', '--list', task.branch!)).toContain(task.branch!);
    }
  });

  it('cleanupTask no borra la carpeta si queda otro contenido', async () => {
    const project = multi();
    const task = await created(project);
    writeFileSync(path.join(task.worktreePath!, 'notas.md'), 'mío\n');
    await cleanupTask(ws, project, task);
    expect(existsSync(path.join(task.worktreePath!, 'a'))).toBe(false);
    expect(readFileSync(path.join(task.worktreePath!, 'notas.md'), 'utf8')).toBe('mío\n');
  });

  it('saveTaskWork: si commitear falla en un repo, los demás se guardan igual', async () => {
    const project = multi();
    const task = await created(project);
    for (const id of ['a', 'b']) writeFileSync(path.join(task.worktreePath!, id, 'w.txt'), `${id}\n`);
    const failing = new Proxy(ws, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop !== 'commitAll') return typeof v === 'function' ? v.bind(target) : v;
        return (wt: string, msg: string) => (wt.endsWith(`${path.sep}a`) ? Promise.reject(new Error('index.lock')) : target.commitAll(wt, msg));
      },
    });
    const notes = await saveTaskWork(failing, project, task, 'guardar');
    expect(notes).toEqual(['a: no se pudo guardar lo sin commitear: index.lock']);
    expect(gitSync(path.join(task.worktreePath!, 'b'), 'status', '--porcelain')).toBe('');
    expect(gitSync(path.join(task.worktreePath!, 'b'), 'log', '-1', '--format=%s').trim()).toBe('guardar');
  });

  it('discardTask borra worktrees y carpeta y archiva la rama en cada repo', async () => {
    const project = multi();
    const task = await created(project);
    await discardTask(ws, project, task);
    expect(existsSync(task.worktreePath!)).toBe(false);
    for (const id of ['a', 'b']) {
      expect(gitSync(repoPath(project, id), 'branch', '--list', 'archive/*')).toContain(`archive/${task.branch}`);
    }
  });
});

describe('regresión Demo (un repo)', () => {
  function demo() {
    const repo = makeRepo();
    return { repo, project: getProject(makeConfig(repo), 'demo') };
  }

  it('regresión Demo: con un repo, createTaskWorkspace deja el worktree en worktreesDir/<rama> como hoy', async () => {
    const { project } = demo();
    const root = tmpDir('faro-root-');
    writeFileSync(path.join(root, 'CLAUDE.md'), '# no se copia\n');
    project.rootPath = root;
    const rec = recording(ws);
    const task = makeTask({ id: 'DEM-1', title: 'Crear hola' });
    const wt = await createTaskWorkspace(rec.ws, project, task);
    expect(wt).toEqual({ path: path.join(project.worktreesDir, 'DEM-1-crear-hola'), branch: 'DEM-1-crear-hola' });
    expect(rec.calls).toEqual([['create', [project, task]]]);
    expect(existsSync(path.join(wt.path, 'README.md'))).toBe(true);
    expect(existsSync(path.join(wt.path, 'CLAUDE.md'))).toBe(false);
  });

  it('regresión Demo: diffTask devuelve los archivos sin prefijo', async () => {
    const { project } = demo();
    const task0 = makeTask({ id: 'DEM-1', title: 'Crear hola' });
    const wt = await createTaskWorkspace(ws, project, task0);
    const task = { ...task0, branch: wt.branch, worktreePath: wt.path };
    writeFileSync(path.join(wt.path, 'hola.txt'), 'hola\n');
    const rec = recording(ws);
    expect(await commitTask(rec.ws, project, task, 'DEM-1: hola')).toBe(true);
    const d = await diffTask(rec.ws, project, task);
    expect(d.files).toEqual(['hola.txt']);
    expect(d.patch).toContain('b/hola.txt');
    expect(d.byRepo).toEqual({ main: ['hola.txt'] });
    expect(await unresolvedTask(rec.ws, project, task)).toEqual([]);
    expect(rec.calls).toEqual([
      ['commitAll', [wt.path, 'DEM-1: hola']],
      ['diff', [project, task]],
      ['unresolvedConflicts', [wt.path]],
    ]);
  });

  it('regresión Demo: restore, chat, cleanup y discard delegan 1:1', async () => {
    const { project } = demo();
    const task0 = makeTask({ id: 'DEM-1', title: 'Crear hola' });
    const wt = await createTaskWorkspace(ws, project, task0);
    const task = { ...task0, branch: wt.branch, worktreePath: wt.path };
    const rec = recording(ws);
    await cleanupTask(rec.ws, project, task);
    expect(taskWorkspaceExists(project, task)).toBe(false);
    await restoreTaskWorkspace(rec.ws, project, task);
    expect(taskWorkspaceExists(project, task)).toBe(true);
    await discardTask(rec.ws, project, task);
    const chat = makeTask({ id: 'DEM-2', kind: 'chat' });
    const p = await createChatWorkspace(rec.ws, project, chat);
    expect(p).toBe(path.join(project.worktreesDir, 'DEM-2-chat'));
    await refreshChatWorkspace(rec.ws, project, { ...chat, worktreePath: p });
    expect(rec.calls.map(([m, args]) => [m, args.length])).toEqual([
      ['cleanup', 2], ['restore', 2], ['discard', 2], ['createDetached', 2], ['refreshDetached', 2],
    ]);
    expect(rec.calls[3][1]).toEqual([project, 'DEM-2-chat']);
    expect(rec.calls[4][1]).toEqual([project, p]);
  });
});
