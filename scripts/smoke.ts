import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReviewActions } from '../src/server/actions';
import { Bus } from '../src/server/bus';
import { runChecks } from '../src/server/checks';
import { normalizeConfig } from '../src/server/config';
import { Orchestrator } from '../src/server/orchestrator';
import { Runner } from '../src/server/runner/runner';
import { Store } from '../src/server/store';
import { GitWorkspaces } from '../src/server/workspaces';

const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), p));
const repo = tmp('faro-smoke-repo-');
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Faro Smoke');
git('config', 'user.email', 'smoke@faro.local');
writeFileSync(path.join(repo, 'README.md'), 'smoke\n');
git('add', '.');
git('commit', '-qm', 'inicio');

const data = tmp('faro-smoke-data-');
const config = normalizeConfig({
  host: '127.0.0.1', port: 0, dataDir: data, claudeBin: 'claude', maxConcurrentRuns: 2,
  projects: [{ id: 'smoke', name: 'Smoke', prefix: 'SMK', repoPath: repo, baseBranch: 'main', remote: 'origin',
    worktreesDir: path.join(data, 'wt'), startNumber: 1, prepare: [], checks: [{ name: 'existe hola', command: 'test -f hola.txt' }] }],
  profiles: [{ id: 'dev', name: 'Dev', instructions: 'Eres un agente de prueba. Haz exactamente lo que se pide.', model: 'haiku', defaultLevel: 2, timeoutMinutes: 5 }],
});
const store = new Store(path.join(data, 'faro.db'));
const bus = new Bus();
const workspaces = new GitWorkspaces();
const runner = new Runner({ store, bus, claudeBin: 'claude' });
const orch = new Orchestrator({ store, config, bus, runner, workspaces, runChecks });
const actions = new ReviewActions({ store, config, bus, workspaces, orchestrator: orch, runner });

const write = actions.createTask({ projectId: 'smoke', profileId: 'dev', title: 'Crear hola', description: 'Crea el archivo hola.txt con el texto «hola».' });
const push = actions.createTask({ projectId: 'smoke', profileId: 'dev', title: 'Intentar push', description: 'Ejecuta exactamente `git push origin main` y cuenta qué pasó. No intentes alternativas.' });
await orch.waitIdle();

const w = store.getTask(write.id);
const diff = store.listArtifacts(w.id).find((a) => a.kind === 'diff');
const p = store.getTask(push.id);
const result = store.listEvents(p.id).filter((e) => e.kind === 'result').at(-1)?.payload as { permissionDenials?: unknown[] } | undefined;

const checks = {
  'tarea 1 en revisión': w.state === 'review',
  'diff contiene hola.txt': !!diff && readFileSync(diff.path, 'utf8').includes('hola.txt'),
  'comprobación ok': store.listArtifacts(w.id).some((a) => a.label === 'existe hola: ok'),
  'push denegado': (result?.permissionDenials?.length ?? 0) > 0,
};
console.table(checks);
console.log({ tarea1: w.state, motivo1: w.blockedReason, tarea2: p.state, motivo2: p.blockedReason, datos: data });
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
