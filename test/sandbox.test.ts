import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Bus } from '../src/server/bus';
import { runChecks } from '../src/server/checks';
import { getProject } from '../src/server/config';
import { Orchestrator } from '../src/server/orchestrator';
import { Runner } from '../src/server/runner/runner';
import { shAbortable } from '../src/server/exec';
import { FARO_DIR, sandboxProfile } from '../src/server/sandbox';
import { Store } from '../src/server/store';
import { GitWorkspaces } from '../src/server/workspaces';
import { fixture, gitSync, makeConfig, makeRepo, makeTask, tmpDir } from './helpers';

describe('sandboxProfile', () => {
  it('niega el puerto de Faro, su base de datos, artefactos, hooks y ~/.expo; escapa comillas', () => {
    const p = sandboxProfile({ faroDir: '/faro', dataDir: '/datos "x"', repoPath: '/repo', worktreesDir: '/wt', home: '/casa', ports: [3200, 0] });
    expect(p).toContain('(allow default)');
    expect(p).toContain('(deny network-outbound (remote tcp "*:3200"))');
    expect(p).not.toContain('*:0');
    expect(p).toContain('(subpath "/faro")');
    expect(p).toContain('(subpath "/datos \\"x\\"/artifacts")');
    expect(p).toContain('(regex "^/datos \\"x\\"/faro\\\\.db")');
    // Leer la base (con -wal/-shm/-journal) o las claves VAPID tampoco.
    expect(p).toContain('(deny file-read* (regex "^/datos \\"x\\"/faro\\\\.db(-wal|-shm|-journal)?$") (literal "/datos \\"x\\"/vapid.json"))');
    expect(p).toContain('(subpath "/repo/.git/hooks")');
    expect(p).toContain('(literal "/repo/.git/config")');
    expect(p).toMatch(/\(deny file-write\* [^\n]*\(literal "\/datos \\"x\\"\/vapid\.json"\)/);
    expect(p).toContain('(subpath "/casa/Library/LaunchAgents")');
    expect(p).toMatch(/\(deny file-read\* file-write\* \(subpath "\/casa\/\.expo"\)\)/);
    // Checkout principal de solo lectura salvo objetos, worktrees y worktreesDir (el allow va después del deny).
    expect(p.indexOf('(deny file-write* (subpath "/repo"))')).toBeGreaterThan(0);
    expect(p.indexOf('(allow file-write* (subpath "/repo/.git/objects") (subpath "/repo/.git/worktrees") (subpath "/wt"))'))
      .toBeGreaterThan(p.indexOf('(deny file-write* (subpath "/repo"))'));
    // Claude Code lee su sesión con /usr/bin/security: no se puede bloquear.
    expect(p).not.toContain('/usr/bin/security');
    expect(p).toContain('(literal "/casa/.gitconfig")');
    expect(p).toContain('(subpath "/casa/.config/git")');
    // Antepasados: no se pueden renombrar para esquivar las reglas.
    for (const a of ['/repo/.git', '/', '/casa', '/casa/Library', '/datos "x"'.replace(/"/g, '\\"')]) expect(p).toContain(`(literal "${a}")`);
  });

  it('FARO_DIR es este checkout', () => {
    expect(existsSync(path.join(FARO_DIR, 'src/server/sandbox.ts'))).toBe(true);
  });
});

describe.skipIf(process.platform !== 'darwin')('sandbox de agentes (macOS)', () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end('faro'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  type EnvOf = Record<string, string> | ((o: { repo: string; dataDir: string }) => Record<string, string>);
  function setup(envOf: EnvOf, sandbox: boolean) {
    const repo = makeRepo();
    const config = makeConfig(repo, { sandbox, port });
    const env = typeof envOf === 'function' ? envOf({ repo, dataDir: config.dataDir }) : envOf;
    const store = new Store(':memory:');
    const bus = new Bus();
    const runner = new Runner({ store, bus, claudeBin: config.claudeBin, env, killGraceMs: 100 });
    const orch = new Orchestrator({ store, config, bus, runner, workspaces: new GitWorkspaces(), runChecks, setTimer: () => {} });
    const project = getProject(config, 'demo');
    const run = async () => {
      const t = store.createTask(project, { title: 'Sandbox', description: '', profileId: 'dev', level: 2 });
      orch.enqueue(t.id);
      await orch.waitIdle();
      return store.getTask(t.id);
    };
    return { repo, config, store, run, project };
  }

  it('un agente con sandbox no llega al API de Faro; sin sandbox, sí', async () => {
    const dir = tmpDir();
    const out = (n: string) => path.join(dir, n);
    const env = (o: string) => ({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_FETCH_URL: `http://127.0.0.1:${port}/api/tasks`, FAKE_FETCH_OUT: o });
    await setup(env(out('con')), true).run();
    await setup(env(out('sin')), false).run();
    expect(readFileSync(out('con'), 'utf8')).toBe('blocked');
    expect(readFileSync(out('sin'), 'utf8')).toBe('ok');
  });

  it('un agente con sandbox no puede escribir en .git/hooks del repo; fuera de lo prohibido, sí', async () => {
    const free = path.join(tmpDir(), 'libre.txt');
    await setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE_ABS: free }, true).run();
    expect(existsSync(free)).toBe(true);

    const hookOf = (repo: string) => path.join(repo, '.git', 'hooks', 'x');
    const s = setup(({ repo }) => ({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE_ABS: hookOf(repo) }), true);
    mkdirSync(path.dirname(hookOf(s.repo)), { recursive: true });
    await s.run();
    expect(existsSync(hookOf(s.repo))).toBe(false);
  });

  it('un agente con sandbox no puede escribir la base de datos de Faro', async () => {
    const s = setup(({ dataDir }) => ({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE_ABS: path.join(dataDir, 'faro.db-wal') }), true);
    await s.run();
    expect(existsSync(path.join(s.config.dataDir, 'faro.db-wal'))).toBe(false);
  });

  it('las comprobaciones corren bajo el mismo sandbox', async () => {
    const s = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' }, true);
    const hook = path.join(s.repo, '.git', 'hooks', 'desde-check');
    s.project.checks.push({ name: 'Escribe hook', command: `echo x > '${hook}'` });
    const t = await s.run();
    expect(t.state).toBe('review');
    expect(existsSync(hook)).toBe(false);
    expect(s.store.listArtifacts(t.id).some((a) => a.label === 'Escribe hook: falla')).toBe(true);
  });

  describe('checkout principal, antepasados y config de git', () => {
    async function inSandbox() {
      const repo = makeRepo();
      const config = makeConfig(repo);
      const project = getProject(config, 'demo');
      const wt = await new GitWorkspaces().create(project, makeTask({ id: 'DEM-1', title: 'Sandbox' }));
      const home = tmpDir('faro-home-');
      // Un «checkout de Faro» de mentira: el test intenta renombrarlo.
      const faroDir = tmpDir('faro-self-');
      const profile = sandboxProfile({ faroDir, dataDir: config.dataDir, repoPath: repo, worktreesDir: project.worktreesDir, home, ports: [] });
      const sh = (cmd: string, cwd = wt.path) => shAbortable(cmd, cwd, { sandboxProfile: profile });
      return { repo, config, wt, home, faroDir, sh };
    }

    it('/usr/bin/security sigue funcionando dentro (Claude Code lee de ahí su sesión)', async () => {
      const s = await inSandbox();
      expect((await s.sh('/usr/bin/security help')).code).toBe(0);
    });

    it('git add/status/diff dentro del worktree siguen funcionando', async () => {
      const s = await inSandbox();
      const r = await s.sh('echo nuevo > nuevo.txt && git add -A && git status --porcelain && git diff --cached --stat');
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('nuevo.txt');
    });

    it('no se puede escribir en el checkout principal ni mover su rama', async () => {
      const s = await inSandbox();
      const main = gitSync(s.repo, 'rev-parse', 'main');
      for (const cmd of [
        `echo x > '${path.join(s.repo, 'README.md')}'`,
        `mkdir -p '${path.join(s.repo, 'node_modules')}'`,
        `echo x > '${path.join(s.repo, '.git', 'refs', 'heads', 'main')}'`,
        // commit-tree solo escribe objetos (permitido); mover main, no.
        `c=$(git -C '${s.repo}' commit-tree -p main -m x 'main^{tree}') && git -C '${s.repo}' update-ref refs/heads/main "$c"`,
      ]) expect((await s.sh(cmd)).code, cmd).not.toBe(0);
      expect(readFileSync(path.join(s.repo, 'README.md'), 'utf8')).toBe('hola\n');
      expect(existsSync(path.join(s.repo, 'node_modules'))).toBe(false);
      expect(gitSync(s.repo, 'rev-parse', 'main')).toBe(main);
    });

    it('renombrar .git, dataDir o el checkout de Faro para esquivar las reglas falla; crear archivos al lado, no', async () => {
      const s = await inSandbox();
      expect((await s.sh(`mv '${path.join(s.repo, '.git')}' '${path.join(s.repo, '.git2')}'`)).code).not.toBe(0);
      expect(existsSync(path.join(s.repo, '.git', 'HEAD'))).toBe(true);
      const parent = path.dirname(s.config.dataDir);
      expect((await s.sh(`mv '${s.config.dataDir}' '${s.config.dataDir}-x'`, parent)).code).not.toBe(0);
      expect(existsSync(s.config.dataDir)).toBe(true);
      expect((await s.sh(`mv '${s.faroDir}' '${s.faroDir}-x'`, path.dirname(s.faroDir))).code).not.toBe(0);
      expect(existsSync(s.faroDir)).toBe(true);
      // Crear archivos en los directorios antepasados sigue permitido.
      const beside = path.join(parent, `${path.basename(s.config.dataDir)}-al-lado.txt`);
      expect((await s.sh(`echo x > '${beside}' && echo y > '${path.join(s.config.dataDir, 'logs.txt')}'`, parent)).code).toBe(0);
      expect(existsSync(beside)).toBe(true);
    });

    it('no se puede leer la base de Faro ni vapid.json; el resto de dataDir, sí', async () => {
      const s = await inSandbox();
      const d = s.config.dataDir;
      const files = ['faro.db', 'faro.db-wal', 'faro.db-shm', 'faro.db-journal', 'vapid.json', 'otro.txt'];
      for (const f of files) writeFileSync(path.join(d, f), 'secreto');
      mkdirSync(path.join(d, 'worktrees'), { recursive: true });
      writeFileSync(path.join(d, 'worktrees', 'nota.txt'), 'libre');
      for (const f of files.slice(0, 5)) {
        const r = await s.sh(`cat '${path.join(d, f)}'`);
        expect(r.code, f).not.toBe(0);
        expect(r.stdout, f).not.toContain('secreto');
      }
      expect((await s.sh(`cat '${path.join(d, 'otro.txt')}'`)).stdout).toBe('secreto');
      expect((await s.sh(`cat '${path.join(d, 'worktrees', 'nota.txt')}'`)).stdout).toBe('libre');
      // Un enlace duro no esquiva la regla.
      const hard = path.join(tmpDir(), 'copia.db');
      const ln = await s.sh(`ln '${path.join(d, 'faro.db')}' '${hard}' && cat '${hard}'`);
      expect(ln.stdout).not.toContain('secreto');
    });

    it('vapid.json y faro.db no se pueden mover fuera, ampliar ni sobrescribir', async () => {
      const s = await inSandbox();
      const d = s.config.dataDir;
      for (const f of ['vapid.json', 'faro.db']) writeFileSync(path.join(d, f), 'secreto');
      const out = path.join(tmpDir(), 'fuera');
      const otro = path.join(tmpDir(), 'otro.json');
      writeFileSync(otro, 'pisado');
      for (const f of ['vapid.json', 'faro.db']) {
        const p = path.join(d, f);
        const mv = await s.sh(`mv '${p}' '${out}' && cat '${out}'; mv '${out}' '${p}' 2>/dev/null; true`);
        expect(mv.stdout, f).not.toContain('secreto');
        expect(readFileSync(p, 'utf8'), f).toBe('secreto');
      }
      const v = path.join(d, 'vapid.json');
      expect((await s.sh(`printf x >> '${v}'`)).code).not.toBe(0);
      expect((await s.sh(`cp '${otro}' '${v}'`)).code).not.toBe(0);
      expect(readFileSync(v, 'utf8')).toBe('secreto');
      // El resto de dataDir sigue escribible.
      expect((await s.sh(`mkdir -p '${path.join(d, 'worktrees')}' && echo y > '${path.join(d, 'worktrees', 'w.txt')}'`)).code).toBe(0);
    });

    it('no se puede tocar la config global de git', async () => {
      const s = await inSandbox();
      mkdirSync(path.join(s.home, '.config', 'git'), { recursive: true });
      expect((await s.sh(`echo x > '${path.join(s.home, '.gitconfig')}'`)).code).not.toBe(0);
      expect((await s.sh(`echo x > '${path.join(s.home, '.config', 'git', 'config')}'`)).code).not.toBe(0);
      expect((await s.sh(`mv '${path.join(s.home, '.config')}' '${path.join(s.home, '.config2')}'`)).code).not.toBe(0);
      expect(existsSync(path.join(s.home, '.gitconfig'))).toBe(false);
    });
  });
});
