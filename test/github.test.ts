import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ReviewActions } from '../src/server/actions';
import { Bus } from '../src/server/bus';
import { runTaskChecks } from '../src/server/checks';
import { GitHub, checkState } from '../src/server/github';
import { GitHubWatcher } from '../src/server/github-watch';
import { prMetaKey, type PrMeta } from '../src/server/integrate';
import { Orchestrator } from '../src/server/orchestrator';
import { ciState } from '../src/server/plan';
import { Runner } from '../src/server/runner/runner';
import { Store } from '../src/server/store';
import { GitWorkspaces } from '../src/server/workspaces';
import { fixture, gitSync, makeConfig, makeRepo, tmpDir } from './helpers';

const FAKE_GH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-gh.mjs');

interface GhState { prs: { number: number; title: string; headRefName: string; state: string; statusCheckRollup: unknown[] }[]; runs: unknown[]; [k: string]: unknown }

/** Repo con origin desnudo, proyecto en modo PR y un gh falso con su estado en un JSON. */
function setup(opts: { ci?: boolean; ciProfile?: string } = {}) {
  const repo = makeRepo();
  const origin = path.join(tmpDir(), 'origin.git');
  gitSync(repo, 'init', '-q', '--bare', '-b', 'main', origin);
  gitSync(repo, 'remote', 'add', 'origin', origin);
  gitSync(repo, 'push', '-q', 'origin', 'main');
  const config = makeConfig(repo);
  config.projects[0].github = { prs: true, ci: opts.ci, ciProfile: opts.ciProfile };
  config.profiles.push({ id: 'qa', name: 'QA', instructions: 'Arreglas el CI.', defaultLevel: 2, timeoutMinutes: 1 });
  const ghState = path.join(tmpDir(), 'gh.json');
  writeFileSync(ghState, JSON.stringify({ prs: [], runs: [], defaultChecks: [{ name: 'App', status: 'IN_PROGRESS', conclusion: '' }] }));
  const gh = new GitHub(FAKE_GH, { ...process.env, FAKE_GH_STATE: ghState, FAKE_GH_ORIGIN: origin });
  const store = new Store(':memory:');
  const bus = new Bus();
  const workspaces = new GitWorkspaces();
  const runner = new Runner({ store, bus, claudeBin: config.claudeBin, env: { FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' }, killGraceMs: 100 });
  const orch = new Orchestrator({ store, config, bus, runner, workspaces, runChecks: runTaskChecks, setTimer: () => {}, github: gh });
  const actions = new ReviewActions({ store, config, bus, workspaces, orchestrator: orch, runner, github: gh });
  const enqueued: { id: string; prompt?: string | null }[] = [];
  const notes: string[] = [];
  const urls: string[] = [];
  let now = new Date();
  const watcher = new GitHubWatcher({
    store, config, bus, workspaces, github: gh, now: () => now,
    enqueue: (id, prompt) => { enqueued.push({ id, prompt }); store.setState(id, 'queued'); },
    notify: (title, _body, url) => { notes.push(title); urls.push(url); },
  });
  const read = (): GhState => JSON.parse(readFileSync(ghState, 'utf8'));
  const write = (fn: (s: GhState) => void) => { const s = read(); fn(s); writeFileSync(ghState, JSON.stringify(s)); };
  const setChecks = (n: number, checks: unknown[]) => write((s) => { s.prs.find((p) => p.number === n)!.statusCheckRollup = checks; });
  return {
    repo, origin, config, store, orch, actions, watcher, enqueued, notes, urls, read, write, setChecks,
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
  };
}

/** Tarea que crea hola.txt, aprobada: queda esperando a su PR. */
async function withPr(s: ReturnType<typeof setup>) {
  const t = s.actions.createTask({ projectId: 'demo', title: 'Crear hola', description: '', profileId: 'dev' });
  await s.orch.waitIdle();
  const r = await s.actions.approve(t.id);
  return { id: t.id, r };
}

describe('integración por PR', () => {
  it('aprobar sube la rama, abre el PR y deja la tarea esperando al CI', async () => {
    const s = setup();
    const { id, r } = await withPr(s);
    expect(r).toMatchObject({ status: 'pr', number: 1 });
    const t = s.store.getTask(id);
    expect(t.state).toBe('pr');
    expect(s.read().prs[0]).toMatchObject({ title: 'DEM-1: Crear hola', headRefName: t.branch, state: 'OPEN' });
    expect(gitSync(s.origin, 'branch', '--list', t.branch!)).toContain(t.branch);
    // main no se ha tocado: lo hará GitHub.
    expect(() => gitSync(s.origin, 'show', 'main:hola.txt')).toThrow();
  });

  it('con el CI en curso espera; al pasar fusiona por squash, borra la rama y la tarea queda hecha', async () => {
    const s = setup();
    const { id } = await withPr(s);
    const branch = s.store.getTask(id).branch!;
    await s.watcher.checkPrs();
    expect(s.store.getTask(id).state).toBe('pr');
    s.setChecks(1, [{ name: 'App', status: 'COMPLETED', conclusion: 'SUCCESS' }]);
    await s.watcher.checkPrs();
    expect(s.store.getTask(id).state).toBe('done');
    expect(gitSync(s.origin, 'log', '-1', '--format=%s', 'main').trim()).toBe('DEM-1: Crear hola');
    expect(gitSync(s.repo, 'show', 'main:hola.txt')).toBe('hola\n');
    expect(gitSync(s.origin, 'branch', '--list', branch).trim()).toBe('');
    expect(s.store.listApprovals(id).find((a) => a.action === 'push')?.state).toBe('auto');
    expect(s.store.listPendingApprovals('demo', 'push')).toEqual([]);
  });

  it('si el CI falla, vuelve al agente con el log; al tercer fallo se bloquea', async () => {
    const s = setup();
    const { id } = await withPr(s);
    s.write((st) => { st.runs = [{ databaseId: 7, headSha: 'x', status: 'completed', conclusion: 'failure', workflowName: 'CI', url: 'u', createdAt: '', branch: s.store.getTask(id).branch }]; st.failedLog = 'FAIL care.test.ts'; });
    for (let i = 1; i <= 3; i++) {
      s.setChecks(1, [{ name: 'App', status: 'COMPLETED', conclusion: 'FAILURE' }]);
      if (i > 1) s.store.setState(id, 'working'), s.store.setState(id, 'review'), s.store.setState(id, 'pr');
      await s.watcher.checkPrs();
    }
    expect(s.enqueued).toHaveLength(2);
    expect(s.enqueued[0].prompt).toContain('FAIL care.test.ts');
    expect(s.store.getTask(id).state).toBe('blocked');
    expect(s.store.getMeta<PrMeta>(prMetaKey(id))?.ciFailures).toBe(3);
  });

  it('PR cerrado sin fusionar → revisión; fusionado a mano en GitHub → hecha', async () => {
    const s = setup();
    const { id } = await withPr(s);
    s.write((st) => { st.prs[0].state = 'CLOSED'; });
    await s.watcher.checkPrs();
    expect(s.store.getTask(id).state).toBe('review');

    const s2 = setup();
    const { id: id2 } = await withPr(s2);
    gitSync(s2.repo, 'push', '-q', 'origin', `${s2.store.getTask(id2).branch}:main`);
    s2.write((st) => { st.prs[0].state = 'MERGED'; });
    await s2.watcher.checkPrs();
    expect(s2.store.getTask(id2).state).toBe('done');
  });

  it('sin comprobaciones en el repo, fusiona pasados 10 minutos', async () => {
    const s = setup();
    s.write((st) => { st.defaultChecks = []; });
    const { id } = await withPr(s);
    await s.watcher.checkPrs();
    expect(s.store.getTask(id).state).toBe('pr');
    s.advance(11 * 60_000);
    await s.watcher.checkPrs();
    expect(s.store.getTask(id).state).toBe('done');
  });

  it('si main avanza y el PR choca, Faro trae origin y crea la tarea de conflicto en la misma rama', async () => {
    const s = setup();
    const { id } = await withPr(s);
    // Otro PR fusionado en GitHub cambia hola.txt en main.
    const other = path.join(tmpDir(), 'otro');
    gitSync(s.repo, 'clone', '-q', s.origin, other);
    writeFileSync(path.join(other, 'hola.txt'), 'otra cosa\n');
    gitSync(other, 'add', '.');
    gitSync(other, '-c', 'user.email=o@x', '-c', 'user.name=Otro', 'commit', '-qm', 'hola distinto');
    gitSync(other, 'push', '-q', 'origin', 'main');
    s.write((st) => { (st.prs[0] as { mergeStateStatus?: string }).mergeStateStatus = 'DIRTY'; });
    await s.watcher.checkPrs();
    const parent = s.store.getTask(id);
    expect(parent.state).toBe('review');
    const conflict = s.store.listTasks().find((t) => t.parentId === id)!;
    expect(conflict).toMatchObject({ branch: parent.branch, title: 'Resolver conflicto: Crear hola' });
    expect(gitSync(s.repo, 'show', 'main:hola.txt')).toBe('otra cosa\n');
  });

  it('descartar una tarea esperando a su PR cierra el PR', async () => {
    const s = setup();
    const { id } = await withPr(s);
    await s.actions.discard(id);
    expect(s.read().prs[0].state).toBe('CLOSED');
  });
});

describe('vigilancia del CI de main', () => {
  const run = (sha: string, conclusion: string, over: Record<string, unknown> = {}) =>
    ({ databaseId: 1, headSha: sha, status: 'completed', conclusion, workflowName: 'CI', url: `https://ci/${sha}`, createdAt: '', ...over });

  it('un fallo crea una tarea de arreglo con el log; el mismo commit no repite; vuelve a pasar → aviso', async () => {
    const s = setup({ ci: true });
    s.write((st) => { st.runs = [run('b', 'failure')]; st.failedLog = 'care.test.ts falla'; });
    await s.watcher.checkCi();
    const fix = s.store.listTasks().find((t) => t.title.startsWith('Arreglar el CI de main'))!;
    expect(fix.description).toContain('care.test.ts falla');
    expect(fix.level).toBe(2);
    expect(s.enqueued.map((e) => e.id)).toEqual([fix.id]);
    expect(s.notes).toEqual(['El CI de main falla']);
    await s.watcher.checkCi();
    expect(s.store.listTasks().filter((t) => t.title.startsWith('Arreglar el CI'))).toHaveLength(1);

    // Otro commit falla con la tarea aún abierta: se comenta, no se crea otra.
    s.write((st) => { st.runs = [run('c', 'failure'), run('b', 'failure')]; });
    await s.watcher.checkCi();
    expect(s.store.listTasks().filter((t) => t.title.startsWith('Arreglar el CI'))).toHaveLength(1);
    expect(s.store.listComments(fix.id).at(-1)?.body).toContain('falla en c');

    s.write((st) => { st.runs = [run('d', 'success'), run('c', 'failure')]; });
    await s.watcher.checkCi();
    expect(s.notes.at(-1)).toBe('El CI de main vuelve a pasar');
    // Abre el Plan del proyecto, no el del que esté elegido en el dispositivo.
    expect(s.urls.at(-1)).toBe('/#/plan?p=demo');
  });

  it('la tarea de arreglo usa github.ciProfile si está configurado', async () => {
    const s = setup({ ci: true, ciProfile: 'qa' });
    s.write((st) => { st.runs = [run('b', 'failure')]; st.failedLog = 'x'; });
    await s.watcher.checkCi();
    expect(s.store.listTasks().find((t) => t.title.startsWith('Arreglar el CI'))?.profileId).toBe('qa');
  });

  it('ignora un commit con ejecuciones aún en curso', async () => {
    const s = setup({ ci: true });
    s.write((st) => { st.runs = [run('n', '', { status: 'in_progress' }), run('n', 'failure', { databaseId: 2 })]; });
    await s.watcher.checkCi();
    expect(s.notes).toEqual([]);
  });
});

describe('helpers de GitHub', () => {
  it('checkState y ciState resumen comprobaciones y ejecuciones', () => {
    expect(checkState({ status: 'IN_PROGRESS' })).toBe('pending');
    expect(checkState({ status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('success');
    expect(checkState({ status: 'COMPLETED', conclusion: 'FAILURE' })).toBe('failure');
    expect(checkState({ state: 'SUCCESS' })).toBe('success');
    const runs = [
      { databaseId: 1, headSha: 'a', status: 'completed', conclusion: 'success', workflowName: 'CI', url: 'u1', createdAt: '2' },
      { databaseId: 2, headSha: 'a', status: 'completed', conclusion: 'failure', workflowName: 'Smoke', url: 'u2', createdAt: '2' },
      { databaseId: 3, headSha: 'z', status: 'completed', conclusion: 'success', workflowName: 'CI', url: 'u3', createdAt: '1' },
    ];
    expect(ciState(runs)).toEqual({ sha: 'a', state: 'failure', url: 'u2', workflows: ['CI', 'Smoke'], at: '2' });
    expect(ciState([])).toBeNull();
  });
});
