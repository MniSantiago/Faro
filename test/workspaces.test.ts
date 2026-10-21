import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitWorkspaces, slugify } from '../src/server/workspaces';
import { getProject } from '../src/server/config';
import { gitSync, makeConfig, makeRepo, makeTask, tmpDir } from './helpers';

const ws = new GitWorkspaces();

function setup() {
  const repo = makeRepo();
  const project = getProject(makeConfig(repo), 'demo');
  return { repo, project };
}

async function withWork(project: ReturnType<typeof setup>['project'], id = 'DEM-1', title = 'Crear hola') {
  const task = makeTask({ id, title });
  const wt = await ws.create(project, task);
  writeFileSync(path.join(wt.path, 'hola.txt'), 'hola\n');
  await ws.commitAll(wt.path, `${id}: ${title}`);
  return { ...task, branch: wt.branch, worktreePath: wt.path };
}

describe('slugify', () => {
  it.each([
    ['Añadir interruptor de medición', 'anadir-interruptor-de-medicion'],
    ['Capturas 6.9" en los 5 idiomas 🚀', 'capturas-6-9-en-los-5-idiomas'],
    ['feat/arreglar: algo', 'feat-arreglar-algo'],
    ['🚀🚀', 'tarea'],
    ['x'.repeat(80), 'x'.repeat(40)],
  ])('%s → %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});

describe('GitWorkspaces', () => {
  it('create crea worktree y rama, ejecuta prepare y excluye .faro/', async () => {
    const { repo, project } = setup();
    project.prepare = ['echo listo > preparado.txt'];
    const wt = await ws.create(project, makeTask({ id: 'DEM-1', title: 'Crear hola' }));
    expect(wt.branch).toBe('DEM-1-crear-hola');
    expect(existsSync(path.join(wt.path, 'README.md'))).toBe(true);
    expect(readFileSync(path.join(wt.path, 'preparado.txt'), 'utf8')).toBe('listo\n');
    expect(readFileSync(path.join(repo, '.git/info/exclude'), 'utf8')).toContain('.faro/');
  });

  it('create con preparación fallida deshace worktree y rama, y permite reintentar', async () => {
    const { repo, project } = setup();
    project.prepare = ['exit 9'];
    const task = makeTask({ id: 'DEM-1', title: 'Crear hola' });
    const branch = 'DEM-1-crear-hola';
    await expect(ws.create(project, task)).rejects.toThrow(/preparación/);
    expect(existsSync(path.join(project.worktreesDir, branch))).toBe(false);
    expect(gitSync(repo, 'branch', '--list', branch).trim()).toBe('');
    project.prepare = [];
    const wt = await ws.create(project, task);
    expect(wt.branch).toBe(branch);
    expect(existsSync(path.join(wt.path, 'README.md'))).toBe(true);
  });

  it('merge con cwd inexistente devuelve conflict: false con la salida de git', async () => {
    const { project } = setup();
    const task = makeTask({ id: 'DEM-1', title: 'Sin directorio' });
    const wt = await ws.create(project, task);
    rmSync(wt.path, { recursive: true, force: true });
    const r = await ws.merge(project, { ...task, branch: wt.branch, worktreePath: wt.path });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.conflict).toBe(false);
    expect(r.ok === false && r.output.length > 0).toBe(true);
  });

  it('dos tareas con el mismo título tienen ramas distintas', async () => {
    const { project } = setup();
    const a = await ws.create(project, makeTask({ id: 'DEM-1', title: 'Igual' }));
    const b = await ws.create(project, makeTask({ id: 'DEM-2', title: 'Igual' }));
    expect(a.branch).not.toBe(b.branch);
  });

  it('commitAll no commitea .faro/ y devuelve false si no hay cambios', async () => {
    const { project } = setup();
    const wt = await ws.create(project, makeTask());
    expect(await ws.commitAll(wt.path, 'nada')).toBe(false);
    writeFileSync(path.join(wt.path, 'a.txt'), 'a');
    const faroDir = path.join(wt.path, '.faro');
    mkdirSync(faroDir, { recursive: true });
    writeFileSync(path.join(faroDir, 'x.png'), 'x');
    expect(await ws.commitAll(wt.path, 'a')).toBe(true);
    expect(gitSync(wt.path, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('a.txt');
  });

  describe('symlinks de prepare hacia fuera del worktree (node_modules/ ignorado solo como directorio)', () => {
    async function scenario(exclude?: string[]) {
      const repo = makeRepo();
      writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
      gitSync(repo, 'add', '.gitignore');
      gitSync(repo, 'commit', '-qm', 'ignorar node_modules');
      // node_modules real (ignorado) en el repo principal, que el merge no debe tocar.
      mkdirSync(path.join(repo, 'app', 'node_modules', 'paquete'), { recursive: true });
      writeFileSync(path.join(repo, 'app', 'node_modules', 'paquete', 'index.js'), 'real\n');
      const project = getProject(makeConfig(repo), 'demo');
      project.prepare = ['mkdir -p app && ln -sfn /tmp app/node_modules'];
      if (exclude) project.exclude = exclude;
      const task = makeTask({ id: 'DEM-1', title: 'Con enlaces' });
      const wt = await ws.create(project, task);
      const t = { ...task, branch: wt.branch, worktreePath: wt.path };
      expect(lstatSync(path.join(wt.path, 'app', 'node_modules')).isSymbolicLink()).toBe(true);
      return { repo, project, task: t };
    }

    async function expectNoSymlinkCommitted(s: Awaited<ReturnType<typeof scenario>>) {
      const { repo, project, task } = s;
      expect(await ws.commitAll(task.worktreePath!, 'solo enlaces')).toBe(false);
      expect((await ws.diff(project, task)).files).toEqual([]);
      writeFileSync(path.join(task.worktreePath!, 'hola.txt'), 'hola\n');
      expect(await ws.commitAll(task.worktreePath!, 'trabajo')).toBe(true);
      expect((await ws.diff(project, task)).files).toEqual(['hola.txt']);
      expect(await ws.merge(project, task)).toEqual({ ok: true });
      const nm = path.join(repo, 'app', 'node_modules');
      expect(lstatSync(nm).isSymbolicLink()).toBe(false);
      expect(lstatSync(nm).isDirectory()).toBe(true);
      expect(readFileSync(path.join(nm, 'paquete', 'index.js'), 'utf8')).toBe('real\n');
    }

    it('sin exclude: commitAll no commitea el symlink y el merge no toca node_modules real', async () => {
      await expectNoSymlinkCommitted(await scenario());
    });

    it('con exclude: se escribe en info/exclude y tampoco se commitea', async () => {
      const s = await scenario(['node_modules', 'app/node_modules']);
      const exclude = readFileSync(path.join(s.repo, '.git/info/exclude'), 'utf8').split('\n');
      expect(exclude).toEqual(expect.arrayContaining(['.faro/', 'node_modules', 'app/node_modules']));
      await expectNoSymlinkCommitted(s);
    });

    it('commitAll sí commitea symlinks que apuntan dentro del worktree', async () => {
      const { project } = setup();
      const wt = await ws.create(project, makeTask());
      writeFileSync(path.join(wt.path, 'a.txt'), 'a');
      symlinkSync('a.txt', path.join(wt.path, 'enlace'));
      expect(await ws.commitAll(wt.path, 'enlace')).toBe(true);
      expect(gitSync(wt.path, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['a.txt', 'enlace']);
    });
  });

  it('diff devuelve el patch y los archivos contra la base', async () => {
    const { project } = setup();
    const task = await withWork(project);
    const d = await ws.diff(project, task);
    expect(d.files).toEqual(['hola.txt']);
    expect(d.patch).toContain('+hola');
  });

  it('merge hace fast-forward de main con el repo limpio', async () => {
    const { repo, project } = setup();
    const task = await withWork(project);
    expect(await ws.merge(project, task)).toEqual({ ok: true });
    expect(gitSync(repo, 'show', 'main:hola.txt')).toBe('hola\n');
    expect(readFileSync(path.join(repo, 'hola.txt'), 'utf8')).toBe('hola\n');
  });

  it('merge con main sucio en otro archivo integra y conserva el cambio local', async () => {
    const { repo, project } = setup();
    const task = await withWork(project);
    writeFileSync(path.join(repo, 'README.md'), 'cambio local\n');
    expect(await ws.merge(project, task)).toEqual({ ok: true });
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('cambio local\n');
    expect(gitSync(repo, 'show', 'main:hola.txt')).toBe('hola\n');
  });

  it('merge con main sucio en el mismo archivo falla sin tocar nada', async () => {
    const { repo, project } = setup();
    const task = makeTask({ id: 'DEM-1', title: 'Editar readme' });
    const wt = await ws.create(project, task);
    writeFileSync(path.join(wt.path, 'README.md'), 'desde la rama\n');
    await ws.commitAll(wt.path, 'rama');
    writeFileSync(path.join(repo, 'README.md'), 'cambio local\n');
    const before = gitSync(repo, 'rev-parse', 'main');
    const r = await ws.merge(project, { ...task, branch: wt.branch, worktreePath: wt.path });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.conflict).toBe(false);
    expect(gitSync(repo, 'rev-parse', 'main')).toBe(before);
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('cambio local\n');
  });

  it('merge con conflicto real devuelve conflict y deja el worktree limpio', async () => {
    const { repo, project } = setup();
    const task = makeTask({ id: 'DEM-1', title: 'Editar readme' });
    const wt = await ws.create(project, task);
    writeFileSync(path.join(wt.path, 'README.md'), 'desde la rama\n');
    await ws.commitAll(wt.path, 'rama');
    writeFileSync(path.join(repo, 'README.md'), 'desde main\n');
    gitSync(repo, 'commit', '-qam', 'main cambia');
    const r = await ws.merge(project, { ...task, branch: wt.branch, worktreePath: wt.path });
    expect(r).toMatchObject({ ok: false, conflict: true });
    expect(gitSync(wt.path, 'status', '--porcelain')).toBe('');
  });

  it('merge cuando el repo está en otra rama actualiza main sin checkout', async () => {
    const { repo, project } = setup();
    const task = await withWork(project);
    gitSync(repo, 'switch', '-qc', 'otra');
    expect(await ws.merge(project, task)).toEqual({ ok: true });
    expect(gitSync(repo, 'show', 'main:hola.txt')).toBe('hola\n');
    expect(gitSync(repo, 'branch', '--show-current').trim()).toBe('otra');
  });

  it('push sube la rama base al remoto', async () => {
    const { repo, project } = setup();
    const bare = tmpDir('faro-remote-');
    gitSync(bare, 'init', '-q', '--bare', '-b', 'main');
    gitSync(repo, 'remote', 'add', 'origin', bare);
    const task = await withWork(project);
    await ws.merge(project, task);
    await ws.push(project);
    expect(gitSync(bare, 'show', 'main:hola.txt')).toBe('hola\n');
  });

  /** Origin desnudo con main ya subida, repo en otra rama (sin checkout de main) y un commit ajeno en el remoto. */
  async function remotoAdelantado(contenidoAjeno: { file: string; text: string }) {
    const { repo, project } = setup();
    const bare = tmpDir('faro-remote-');
    gitSync(bare, 'init', '-q', '--bare', '-b', 'main');
    gitSync(repo, 'remote', 'add', 'origin', bare);
    gitSync(repo, 'push', '-q', 'origin', 'main');
    const otro = tmpDir('faro-otro-');
    gitSync(otro, 'clone', '-q', bare, '.');
    writeFileSync(path.join(otro, contenidoAjeno.file), contenidoAjeno.text);
    gitSync(otro, 'add', '.');
    gitSync(otro, 'commit', '-qm', 'ajeno');
    gitSync(otro, 'push', '-q', 'origin', 'main');
    const task = await withWork(project);
    gitSync(repo, 'switch', '-qc', 'otra');
    expect(await ws.merge(project, task)).toEqual({ ok: true });
    return { repo, project, bare };
  }

  it('push sin checkout de main fusiona lo nuevo del remoto y sube', async () => {
    const { repo, project, bare } = await remotoAdelantado({ file: 'ajeno.txt', text: 'ajeno\n' });
    await ws.push(project);
    expect(gitSync(bare, 'show', 'main:hola.txt')).toBe('hola\n');
    expect(gitSync(bare, 'show', 'main:ajeno.txt')).toBe('ajeno\n');
    expect(gitSync(repo, 'rev-parse', 'main')).toBe(gitSync(bare, 'rev-parse', 'main'));
    expect(gitSync(repo, 'branch', '--show-current').trim()).toBe('otra');
    expect(gitSync(repo, 'worktree', 'list', '--porcelain')).not.toContain('_push-');
    expect(existsSync(path.join(project.worktreesDir, `_push-main-${process.pid}`))).toBe(false);
  });

  it('push sin checkout con choque lanza y no deja nada a medias', async () => {
    const { repo, project, bare } = await remotoAdelantado({ file: 'hola.txt', text: 'otra cosa\n' });
    const antes = gitSync(repo, 'rev-parse', 'main');
    const remotoAntes = gitSync(bare, 'rev-parse', 'main');
    await expect(ws.push(project)).rejects.toThrow(/choca con/);
    expect(gitSync(repo, 'rev-parse', 'main')).toBe(antes);
    expect(gitSync(bare, 'rev-parse', 'main')).toBe(remotoAntes);
    expect(gitSync(repo, 'worktree', 'list', '--porcelain')).not.toContain('_push-');
    expect(existsSync(path.join(project.worktreesDir, `_push-main-${process.pid}`))).toBe(false);
  });

  it('discard borra el worktree y archiva la rama', async () => {
    const { repo, project } = setup();
    const task = await withWork(project);
    await ws.discard(project, task);
    expect(existsSync(task.worktreePath!)).toBe(false);
    expect(gitSync(repo, 'branch', '--list', 'archive/*')).toContain(`archive/${task.branch}`);
  });

  it('create con ruta deja el worktree justo ahí', async () => {
    const { project } = setup();
    const at = path.join(project.worktreesDir, 'DEM-1-carpeta', 'main');
    const wt = await ws.create(project, makeTask({ id: 'DEM-1', title: 'Carpeta' }), at);
    expect(wt).toEqual({ path: at, branch: 'DEM-1-carpeta' });
    expect(existsSync(path.join(at, 'README.md'))).toBe(true);
  });

  it('diff con prefijo antepone el prefijo a archivos y patch', async () => {
    const { project } = setup();
    const task = await withWork(project);
    const plain = await ws.diff(project, task);
    expect(plain.files).toEqual(['hola.txt']);
    expect(plain.patch).toContain('b/hola.txt');
    const d = await ws.diff(project, task, { prefix: 'web/' });
    expect(d.files).toEqual(['web/hola.txt']);
    expect(d.patch).toContain('a/web/hola.txt');
    expect(d.patch).toContain('b/web/hola.txt');
  });

  it('cleanup borra el worktree y conserva la rama', async () => {
    const { repo, project } = setup();
    const task = await withWork(project);
    await ws.cleanup(project, task);
    expect(existsSync(task.worktreePath!)).toBe(false);
    expect(gitSync(repo, 'branch', '--list', task.branch!)).toContain(task.branch!);
  });
});

describe('worktrees separados', () => {
  it('createDetached en main, refreshDetached sigue a main y removeWorktree lo borra', async () => {
    const repo = makeRepo();
    const project = makeConfig(repo).projects[0];
    const p = await new GitWorkspaces().createDetached(project, 'DEM-1-chat');
    expect(gitSync(p, 'rev-parse', 'HEAD')).toBe(gitSync(repo, 'rev-parse', 'main'));
    expect(gitSync(p, 'branch', '--show-current').trim()).toBe('');
    writeFileSync(path.join(repo, 'nuevo.txt'), 'x');
    gitSync(repo, 'add', '.');
    gitSync(repo, 'commit', '-qm', 'nuevo');
    await ws.refreshDetached(project, p);
    expect(existsSync(path.join(p, 'nuevo.txt'))).toBe(true);
    await ws.removeWorktree(project, p);
    expect(existsSync(p)).toBe(false);
  });

  it('createDetached en un commit concreto y con prepare', async () => {
    const repo = makeRepo();
    const first = gitSync(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(path.join(repo, 'b.txt'), 'b');
    gitSync(repo, 'add', '.');
    gitSync(repo, 'commit', '-qm', 'b');
    const project = { ...makeConfig(repo).projects[0], prepare: ['echo hecho > preparado.txt'] };
    const p = await ws.createDetached(project, '_release-1', first);
    expect(existsSync(path.join(p, 'b.txt'))).toBe(false);
    expect(existsSync(path.join(p, 'preparado.txt'))).toBe(true);
  });
});

describe('GitWorkspaces · hooks', () => {
  it('commit y merge de Faro no ejecutan hooks plantados en el repo', async () => {
    const { repo, project } = setup();
    const hooks = path.join(repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const marker = path.join(tmpDir(), 'hook-corrio');
    for (const h of ['pre-commit', 'post-commit', 'post-merge', 'pre-merge-commit', 'reference-transaction']) {
      writeFileSync(path.join(hooks, h), `#!/bin/sh\necho ${h} >> '${marker}'\n`, { mode: 0o755 });
    }
    const task = await withWork(project);
    gitSync(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'main avanza');
    expect(await ws.merge(project, task)).toEqual({ ok: true });
    expect(existsSync(marker)).toBe(false);
  });
});
