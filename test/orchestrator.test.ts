import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Bus } from '../src/server/bus';
import { runChecks } from '../src/server/checks';
import { getProject } from '../src/server/config';
import { integrate, type IntegrateDeps } from '../src/server/integrate';
import { Orchestrator } from '../src/server/orchestrator';
import { Runner, type RunResult } from '../src/server/runner/runner';
import { Store } from '../src/server/store';
import type { FaroConfig, Level } from '../src/server/types';
import { GitWorkspaces } from '../src/server/workspaces';
import { fixture, gitSync, makeConfig, makeRepo, tmpDir, until } from './helpers';

function setup(env: Record<string, string>, over: Partial<FaroConfig> = {}, wsOver: Partial<GitWorkspaces> = {}, releases?: IntegrateDeps['releases']) {
  const repo = makeRepo();
  const config = makeConfig(repo, over);
  const store = new Store(':memory:');
  const bus = new Bus();
  const timers: { ms: number; fn: () => void }[] = [];
  const runner = new Runner({ store, bus, claudeBin: config.claudeBin, env, killGraceMs: 100 });
  const orch = new Orchestrator({
    store, config, bus, runner, workspaces: Object.assign(new GitWorkspaces(), wsOver), runChecks, releases, setTimer: (_fn, ms) => timers.push({ ms, fn: _fn }),
  });
  const project = getProject(config, 'demo');
  const add = (title = 'Crear hola', level: Level = 2) => {
    const t = store.createTask(project, { title, description: '', profileId: 'dev', level });
    orch.enqueue(t.id);
    return t.id;
  };
  return { repo, config, store, bus, orch, add, timers, project, runner };
}

const files = () => {
  const dir = tmpDir();
  return { args: path.join(dir, 'args.jsonl'), counter: path.join(dir, 'n'), stdin: path.join(dir, 'stdin.jsonl') };
};
const readJsonl = (f: string) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
/** Una comprobación que siempre se ejecuta y pasa: sin ella nada se integra solo. */
const PASA = [{ name: 'tests', command: 'true' }];

describe('Orchestrator', () => {
  it('si releases falla al integrar, la tarea queda hecha y se avisa', async () => {
    const { store, orch, project } = setup(
      { FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' }, {}, {},
      { afterIntegrate: () => { throw new Error('boom'); } },
    );
    project.checks = PASA;
    const t = store.createTask(project, { title: 'Crear hola', description: '', profileId: 'dev', level: 3, release: 'build' });
    orch.enqueue(t.id);
    await orch.waitIdle();
    expect(store.getTask(t.id).state).toBe('done');
    expect(store.listComments(t.id).at(-1)?.body).toContain('no se pudo preparar el lanzamiento: boom');
  });

  it('integrar una tarea con release avisa a releases con el commit integrado', async () => {
    const calls: [string, string][] = [];
    const { repo, store, orch, project } = setup(
      { FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' }, {}, {},
      { afterIntegrate: (id, c) => { calls.push([id, c]); } },
    );
    project.checks = PASA;
    const t = store.createTask(project, { title: 'Crear hola', description: '', profileId: 'dev', level: 3, release: 'build' });
    orch.enqueue(t.id);
    await orch.waitIdle();
    expect(calls).toEqual([[t.id, gitSync(repo, 'rev-parse', 'main').trim()]]);
  });

  it('done → revisión con diff, comentario y resumen', async () => {
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' });
    const id = add();
    await orch.waitIdle();
    const t = store.getTask(id);
    expect(t.state).toBe('review');
    expect(t.summary).toBe('He creado hola.txt');
    const diff = store.listArtifacts(id).find((a) => a.kind === 'diff')!;
    expect(diff.label).toBe('Diff (1 archivos)');
    expect(readFileSync(diff.path, 'utf8')).toContain('hola.txt');
    expect(store.listComments(id).map((c) => c.author)).toEqual(['agent']);
  });

  it('nivel 3 con comprobaciones en verde integra solo', async () => {
    const { repo, store, orch, add, project } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' });
    project.checks = PASA;
    const id = add('Crear hola', 3);
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('done');
    expect(gitSync(repo, 'show', 'main:hola.txt')).toBe('hola\n');
    expect(store.listApprovals(id).map((a) => [a.action, a.state])).toEqual([['merge', 'auto'], ['push', 'pending']]);
  });

  it('nivel 2 con un test ejecutado y en verde integra solo, sin push', async () => {
    const { repo, store, orch, add, project } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' });
    project.checks = PASA;
    const id = add('Crear hola', 2);
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('done');
    expect(gitSync(repo, 'show', 'main:hola.txt')).toBe('hola\n');
    expect(store.listApprovals(id).map((a) => [a.action, a.state])).toEqual([['merge', 'auto'], ['push', 'pending']]);
  });

  it('cambios de código sin ningún test ejecutado se quedan en revisión', async () => {
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' });
    const id = add('Crear hola', 3);
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('review');
    expect(store.listApprovals(id)).toEqual([]);
  });

  it('cambios fuera de lo que cubren los tests (todos omitidos) se quedan en revisión', async () => {
    const repo = makeRepo();
    const base = makeConfig(repo);
    base.projects[0].checks = [{ name: 'App · tests', command: 'true', whenChanged: 'app/' }];
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' }, { projects: base.projects });
    const id = add('Crear hola', 3);
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('review');
    expect(store.listArtifacts(id).find((a) => a.kind === 'check')?.label).toBe('App · tests: omitida');
  });

  it('sin cambios de código se cierra sola, conserva los artefactos y borra el worktree', async () => {
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl') });
    const id = add('Escribir guion', 2);
    await orch.waitIdle();
    const t = store.getTask(id);
    expect(t.state).toBe('done');
    expect(t.summary).toBe('He creado hola.txt');
    expect(store.listApprovals(id)).toEqual([]);
    expect(store.listArtifacts(id).find((a) => a.kind === 'diff')?.label).toBe('Diff (0 archivos)');
    expect(existsSync(t.worktreePath!)).toBe(false);
  });

  it('nivel 3 con una comprobación en rojo se queda en revisión', async () => {
    const repo = makeRepo();
    const base = makeConfig(repo);
    base.projects[0].checks = [{ name: 'rota', command: 'exit 1' }];
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' }, { projects: base.projects });
    const id = add('Crear hola', 3);
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('review');
    expect(store.listArtifacts(id).find((a) => a.kind === 'check')?.label).toBe('rota: falla');
  });

  it('blocked guarda la pregunta', async () => {
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-blocked.jsonl') });
    const id = add();
    await orch.waitIdle();
    expect(store.getTask(id)).toMatchObject({ state: 'blocked', blockedReason: '¿Qué color uso?' });
    expect(store.getTask(id).questions).toEqual([{ id: 'q1', text: '¿Qué color uso?' }]);
  });

  it('blocked con preguntas: las guarda y resume el motivo', async () => {
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-questions.jsonl') });
    const id = add();
    await orch.waitIdle();
    const t = store.getTask(id);
    expect(t.state).toBe('blocked');
    expect(t.questions?.map((q) => q.id)).toEqual(['color', 'tono']);
    expect(t.blockedReason).toBe('¿Qué color? (y 1 más)');
  });

  it('los bloqueos propios de Faro no llevan preguntas', async () => {
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-no-result.jsonl') });
    const id = add();
    await orch.waitIdle();
    expect(store.getTask(id).questions).toBeNull();
  });

  it('sin bloque faro-result → bloqueada con motivo', async () => {
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-no-result.jsonl') });
    const id = add();
    await orch.waitIdle();
    const t = store.getTask(id);
    expect(t.state).toBe('blocked');
    expect(t.blockedReason).toMatch(/faro-result/);
  });

  it('error reintenta una vez con --resume y luego bloquea', async () => {
    const f = files();
    const { store, orch, add } = setup({
      FAKE_FIXTURES: `${fixture('stream-error.jsonl')},${fixture('stream-error.jsonl')}`, FAKE_COUNTER: f.counter, FAKE_ARGS_OUT: f.args, FAKE_EXIT: '1',
    });
    const id = add();
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('blocked');
    expect(store.getTask(id).blockedReason).toMatch(/^Falló dos veces/);
    const calls = readJsonl(f.args) as string[][];
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--session-id');
    expect(calls[1][calls[1].indexOf('--resume') + 1]).toBe(store.getTask(id).sessionId);
  });

  it('error y luego éxito → revisión', async () => {
    const f = files();
    const { store, orch, add } = setup({
      FAKE_FIXTURES: `${fixture('stream-error.jsonl')},${fixture('stream-done.jsonl')}`, FAKE_COUNTER: f.counter, FAKE_WRITE: 'hola.txt',
    });
    const id = add();
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('review');
    expect(store.getTask(id).attempts).toBe(0);
  });

  it('límite de uso → tarea en cola y cola pausada hasta el reinicio', async () => {
    const { store, orch, add, timers } = setup({ FAKE_FIXTURES: fixture('stream-rate-limited.jsonl'), FAKE_EXIT: '1' });
    const id = add();
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('queued');
    expect(orch.queueState()).toMatchObject({ paused: true, reason: 'rate_limit', until: 1792062600 });
    expect(timers).toHaveLength(1);
  });

  it('sesión caducada → cola pausada sin reanudación automática', async () => {
    const { store, orch, add, timers } = setup({ FAKE_FIXTURES: fixture('stream-auth.jsonl'), FAKE_EXIT: '1' });
    const id = add();
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('queued');
    expect(orch.queueState()).toMatchObject({ paused: true, reason: 'auth', until: null });
    expect(timers).toHaveLength(0);
  });

  it('tiempo máximo → bloqueada', async () => {
    const repo = makeRepo();
    const base = makeConfig(repo);
    const { store, orch, add } = setup({ FAKE_HANG: '1' }, { profiles: [{ ...base.profiles[0], timeoutMinutes: 0.003 }] });
    const id = add();
    await orch.waitIdle();
    expect(store.getTask(id)).toMatchObject({ state: 'blocked', blockedReason: 'Tiempo máximo superado' });
  });

  it('respeta maxConcurrentRuns', async () => {
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' }, { maxConcurrentRuns: 1 });
    const a = add('A');
    const b = add('B');
    expect(orch.queueState().running).toEqual([a]);
    await orch.waitIdle();
    expect(store.getTask(a).state).toBe('review');
    expect(store.getTask(b).state).toBe('review');
  });

  it('recover marca ejecuciones abiertas como interrumpidas y retoma con --resume', async () => {
    const f = files();
    const { store, config, orch } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_ARGS_OUT: f.args, FAKE_STDIN_OUT: f.stdin });
    const t = store.createTask(getProject(config, 'demo'), { title: 'Cortada', description: '', profileId: 'dev', level: 2 });
    store.setState(t.id, 'queued');
    store.setState(t.id, 'working', { sessionId: 'sess-previa' });
    const run = store.startRun(t.id, 'sess-previa');
    store.addEvent(run.id, t.id, 'system', { sessionId: 'sess-previa' });
    orch.recover();
    expect(store.getRun(run.id).outcome).toBe('interrupted');
    expect(store.getTask(t.id).state).toBe('queued');
    orch.tick();
    await orch.waitIdle();
    const [args] = readJsonl(f.args) as string[][];
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-previa');
    expect(readJsonl(f.stdin)[0]).toBe('Continúa la tarea donde la dejaste.');
  });

  it('recover rearma el temporizador de una pausa por límite', () => {
    const { store, orch, timers } = setup({});
    store.setMeta('queue', { paused: true, reason: 'rate_limit', until: Math.floor(Date.now() / 1000) + 60 });
    orch.recover();
    expect(timers).toHaveLength(1);
  });

  it('error al preparar el worktree → bloqueada con el motivo', async () => {
    const repo = makeRepo();
    const base = makeConfig(repo);
    base.projects[0].prepare = ['exit 9'];
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl') }, { projects: base.projects });
    const id = add();
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('blocked');
    expect(store.getTask(id).blockedReason).toMatch(/preparación/);
  });

  it('el agente corre sin credenciales de push ni GitHub', async () => {
    const f = { out: path.join(tmpDir(), 'env.jsonl') };
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt', FAKE_ENV_OUT: f.out });
    const id = add();
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('review');
    expect(readJsonl(f.out)[0]).toEqual({ GIT_CONFIG_KEY_0: 'remote.origin.pushurl', GH_TOKEN: 'faro-sin-acceso' });
  });

  it('un fallo al integrar solo deja la tarea en revisión con un comentario', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, orch, add, project } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' }, {}, {
      merge: async () => { throw new Error('git roto'); },
    });
    project.checks = PASA;
    const id = add('Crear hola', 3);
    await orch.waitIdle();
    spy.mockRestore();
    expect(store.getTask(id).state).toBe('review');
    expect(store.listComments(id).some((c) => c.author === 'faro' && c.body.includes('No se pudo integrar'))).toBe(true);
  });

  it('integrate: si cleanup falla tras fusionar, sigue y termina en done', async () => {
    const real = new GitWorkspaces();
    const { store, config, bus, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' });
    const id = add('Crear hola', 2);
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('review');
    const ws = Object.assign(real, { cleanup: async () => { throw new Error('no borra'); } });
    const r = await integrate({ store, config, bus, workspaces: ws }, id, { userApproved: true });
    expect(r).toMatchObject({ status: 'merged' });
    expect(store.getTask(id).state).toBe('done');
    expect(store.listComments(id).some((c) => c.author === 'faro' && c.body.includes('no se pudo borrar el worktree'))).toBe(true);
  });

  it('artefactos del agente: directorios se omiten y no pisan el diff', async () => {
    const { store, orch, add } = setup({
      FAKE_FIXTURES: fixture('stream-done-artifacts.jsonl'), FAKE_WRITE: 'hola.txt', FAKE_WRITE_ARTIFACT: '.faro/artifacts/diff.patch',
    });
    const id = add();
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('review');
    const arts = store.listArtifacts(id);
    const diff = arts.find((a) => a.kind === 'diff')!;
    expect(readFileSync(diff.path, 'utf8')).toContain('hola.txt');
    const mine = arts.filter((a) => a.path.includes(`${path.sep}agente${path.sep}`));
    expect(mine).toHaveLength(1);
    expect(readFileSync(mine[0].path, 'utf8')).toBe('x');
  });

  describe('rutina ASO', () => {
    const rutina = { id: 'aso', name: 'ASO', cron: '0 9 * * 1', profileId: 'dev', level: 2 as const, title: 'ASO', prompt: 'p', context: 'aso' as const };
    const run = async (env: Record<string, string>) => {
      const { store, orch, project } = setup({ FAKE_FIXTURES: fixture('stream-done-aso.jsonl'), FAKE_WRITE: 'hola.txt', FAKE_WRITE_ARTIFACT: '.faro/artifacts/aso.json', ...env });
      project.routines = [rutina];
      project.aso = { appId: '111', stores: [{ id: 'es', country: 'es', storefront: 'x', fichaFile: 'f.md' }] };
      const t = store.createTask(project, { title: 'ASO', description: '', profileId: 'dev', level: 2, routineId: 'aso' });
      orch.enqueue(t.id);
      await orch.waitIdle();
      return { store, id: t.id };
    };

    it('importa aso.json como propuestas pendientes y deja el comentario de Faro', async () => {
      const json = JSON.stringify({ stores: { es: { follow: [{ keyword: 'detox', why: 'a' }] } }, competitors: [{ appId: '9', name: 'Forest', why: 'b' }] });
      const { store, id } = await run({ FAKE_WRITE_ARTIFACT_CONTENT: json });
      expect(store.getTask(id).state).toBe('review');
      expect(store.aso.listProposals('demo', 'pending')).toHaveLength(2);
      expect(store.listComments(id).some((c) => c.author === 'faro' && c.body.includes('2 propuestas nuevas en ASO'))).toBe(true);
    });

    it('un aso.json ilegible no cambia el cierre y se apunta', async () => {
      const { store, id } = await run({ FAKE_WRITE_ARTIFACT_CONTENT: 'no es json' });
      expect(store.getTask(id).state).toBe('review');
      expect(store.aso.listProposals('demo')).toHaveLength(0);
      expect(store.listComments(id).some((c) => c.author === 'faro' && c.body.includes('0 propuestas nuevas en ASO') && c.body.includes('JSON'))).toBe(true);
    });

    it('sin bloque aso-json ni aso.json lo dice', async () => {
      const { store, id } = await run({ FAKE_FIXTURES: fixture('stream-done.jsonl') });
      expect(store.listComments(id).some((c) => c.author === 'faro' && c.body === 'La rutina ASO no devolvió el bloque aso-json')).toBe(true);
    });

    it('de punta a punta a nivel 1: importa el bloque aso-json del mensaje final', async () => {
      const { store, orch, project } = setup({ FAKE_FIXTURES: fixture('stream-done-aso-block.jsonl') });
      project.routines = [{ ...rutina, level: 1 }];
      project.aso = { appId: '111', stores: [{ id: 'es', country: 'es', storefront: 'x', fichaFile: 'f.md' }] };
      const t = store.createTask(project, { title: 'ASO', description: '', profileId: 'dev', level: 1, routineId: 'aso' });
      orch.enqueue(t.id);
      await orch.waitIdle();
      expect(['review', 'done']).toContain(store.getTask(t.id).state);
      const props = store.aso.listProposals('demo', 'pending');
      expect(props.map((p) => [p.kind, p.payload])).toEqual([
        ['follow', { keyword: 'detox digital' }],
        ['competitor', { appId: '1438433326', name: 'Opal' }],
      ]);
      expect(props.every((p) => p.taskId === t.id)).toBe(true);
      expect(store.listComments(t.id).some((c) => c.author === 'faro' && c.body === '2 propuestas nuevas en ASO')).toBe(true);
    });
  });

  it('un temporizador viejo no deshace una pausa posterior', () => {
    const { orch, timers } = setup({});
    orch.pause('rate_limit', Math.floor(Date.now() / 1000) + 60);
    orch.pause('auth', null);
    timers[0].fn();
    expect(orch.queueState()).toMatchObject({ paused: true, reason: 'auth' });
  });

  it('límite sin hora de reinicio → pausa de 15 minutos', async () => {
    const { store, orch, add, timers } = setup({ FAKE_FIXTURES: fixture('stream-rate-limited-nodate.jsonl'), FAKE_EXIT: '1' });
    const id = add();
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('queued');
    const q = orch.queueState();
    expect(q.reason).toBe('rate_limit');
    expect(q.until! - Math.floor(Date.now() / 1000)).toBeGreaterThan(880);
    expect(timers).toHaveLength(1);
  });

  it('si la primera ejecución falla antes de crear la sesión, el reintento usa --session-id nuevo', async () => {
    const f = files();
    const { store, orch, add } = setup({ FAKE_EXIT: '1', FAKE_COUNTER: f.counter, FAKE_ARGS_OUT: f.args });
    const id = add();
    await orch.waitIdle();
    const calls = readJsonl(f.args) as string[][];
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c).toContain('--session-id');
      expect(c).not.toContain('--resume');
    }
    const s0 = calls[0][calls[0].indexOf('--session-id') + 1];
    const s1 = calls[1][calls[1].indexOf('--session-id') + 1];
    expect(s1).not.toBe(s0);
    expect(store.getTask(id)).toMatchObject({ state: 'blocked', sessionId: s1, sessionStarted: false });
  });

  it('tras una ejecución con init, la siguiente retoma con --resume', async () => {
    const f = files();
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt', FAKE_ARGS_OUT: f.args });
    const id = add();
    await orch.waitIdle();
    expect(store.getTask(id).sessionStarted).toBe(true);
    orch.enqueue(id, 'Otra vuelta');
    await orch.waitIdle();
    const calls = readJsonl(f.args) as string[][];
    expect(calls[1][calls[1].indexOf('--resume') + 1]).toBe(calls[0][calls[0].indexOf('--session-id') + 1]);
  });

  it('«No conversation found» al retomar limpia la sesión y el reintento empieza una nueva', async () => {
    const f = files();
    const { store, config, orch } = setup({
      FAKE_FAIL_FIRST: 'No conversation found with session ID: sess-perdida', FAKE_COUNTER: f.counter, FAKE_ARGS_OUT: f.args,
      FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt', FAKE_STDIN_OUT: f.stdin,
    });
    const t = store.createTask(getProject(config, 'demo'), { title: 'Perdida', description: 'Haz hola', profileId: 'dev', level: 2 });
    store.updateTask(t.id, { sessionId: 'sess-perdida', sessionStarted: true });
    orch.enqueue(t.id, 'Respuesta del usuario: azul');
    await orch.waitIdle();
    const calls = readJsonl(f.args) as string[][];
    expect(calls).toHaveLength(2);
    expect(calls[0][calls[0].indexOf('--resume') + 1]).toBe('sess-perdida');
    expect(calls[1]).not.toContain('--resume');
    expect(calls[1][calls[1].indexOf('--session-id') + 1]).not.toBe('sess-perdida');
    expect(readJsonl(f.stdin)[1]).toContain('Haz hola');
    expect(store.getTask(t.id)).toMatchObject({ state: 'review', sessionStarted: true });
  });

  it('recover sin init registrado no retoma una sesión que nunca existió', async () => {
    const f = files();
    const { store, config, orch } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_ARGS_OUT: f.args });
    const t = store.createTask(getProject(config, 'demo'), { title: 'Cortada', description: '', profileId: 'dev', level: 2 });
    store.setState(t.id, 'queued');
    store.setState(t.id, 'working', { sessionId: 'sess-nunca' });
    store.startRun(t.id, 'sess-nunca');
    orch.recover();
    orch.tick();
    await orch.waitIdle();
    const [args] = readJsonl(f.args) as string[][];
    expect(args).not.toContain('--resume');
  });

  const untilRunning = async (runner: Runner, id: string) => {
    for (let i = 0; i < 200 && !runner.isRunning(id); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('una ejecución interrumpida vuelve a la cola si la tarea sigue trabajando', async () => {
    const { store, orch, add, runner } = setup({ FAKE_HANG: '1' });
    const id = add();
    await untilRunning(runner, id);
    orch.pause('manual', null);
    runner.cancel(id);
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('queued');
  });

  it('una ejecución interrumpida no pisa una tarea que ya no está trabajando (parada)', async () => {
    const { store, orch, add, runner } = setup({ FAKE_HANG: '1' });
    const id = add();
    await untilRunning(runner, id);
    store.setState(id, 'blocked', { blockedReason: 'Parada por el usuario' });
    runner.cancel(id);
    await orch.waitIdle();
    expect(store.getTask(id)).toMatchObject({ state: 'blocked', blockedReason: 'Parada por el usuario' });
  });
});

describe('Orchestrator · resultados tras una parada', () => {
  function withRunner(outcome: 'error' | 'rate_limited' | 'auth') {
    const repo = makeRepo();
    const config = makeConfig(repo);
    const store = new Store(':memory:');
    const bus = new Bus();
    const project = getProject(config, 'demo');
    // Simula que el usuario pulsó «Parar» mientras la ejecución terminaba con este resultado.
    const runner = {
      run: async (i: { taskId: string }): Promise<RunResult> => {
        store.setState(i.taskId, 'blocked', { blockedReason: 'Parada por el usuario' });
        return { runId: 0, outcome, result: null, finalText: '', resetsAt: null, error: 'x', sawInit: true };
      },
      cancel: () => {},
    };
    const orch = new Orchestrator({ store, config, bus, runner, workspaces: new GitWorkspaces(), runChecks, setTimer: () => {} });
    const t = store.createTask(project, { title: 'T', description: '', profileId: 'dev', level: 2 });
    orch.enqueue(t.id);
    return { store, orch, id: t.id };
  }

  for (const outcome of ['error', 'rate_limited', 'auth'] as const) {
    it(`${outcome}: no reencola una tarea que ya no está trabajando`, async () => {
      const { store, orch, id } = withRunner(outcome);
      await orch.waitIdle();
      expect(store.getTask(id).state).toBe('blocked');
      expect(store.getTask(id).blockedReason).toBe('Parada por el usuario');
      if (outcome !== 'error') expect(orch.queueState().paused).toBe(true);
    });
  }
});

describe('Orchestrator · mensajes', () => {
  it('entrega los mensajes pendientes al empezar y los marca entregados', async () => {
    const f = files();
    const { store, orch, project } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt', FAKE_STDIN_OUT: f.stdin });
    const t = store.createTask(project, { title: 'Crear hola', description: '', profileId: 'dev', level: 2 });
    store.addComment(t.id, 'user', 'hazlo en minúsculas', { pending: true });
    orch.enqueue(t.id);
    await orch.waitIdle();
    expect(readJsonl(f.stdin)[0]).toContain('Usuario: hazlo en minúsculas');
    expect(store.listUndelivered(t.id)).toEqual([]);
  });

  it('al retomar sin nextPrompt, el prompt son solo los mensajes', async () => {
    const f = files();
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt', FAKE_STDIN_OUT: f.stdin });
    const id = add();
    await orch.waitIdle();
    store.addComment(id, 'user', 'añade un punto', { pending: true });
    orch.enqueue(id);
    await orch.waitIdle();
    expect(readJsonl(f.stdin)[1]).toBe('Mensajes nuevos desde tu último turno:\n\nUsuario: añade un punto');
  });

  it('registra como prompt lo que Faro pide; no al retomar solo con mensajes del usuario', async () => {
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' });
    const id = add();
    await orch.waitIdle();
    const [first] = store.listRuns(id).sort((a, b) => a.id - b.id);
    const prompts = () => store.listEvents(id).filter((e) => e.kind === 'prompt');
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0].runId).toBe(first.id);
    expect((prompts()[0].payload as { text: string }).text.startsWith('Tarea DEM-1')).toBe(true);
    expect((prompts()[0].payload as { text: string }).text).not.toContain('Mensajes nuevos');
    store.addComment(id, 'user', 'añade un punto', { pending: true });
    orch.enqueue(id);
    await orch.waitIdle();
    expect(store.listRuns(id)).toHaveLength(2);
    expect(prompts()).toHaveLength(1);
  });

  it('mensajes que llegan durante la ejecución: no se queda en revisión ni integra, vuelve a la cola', async () => {
    const f = files();
    const { store, orch, add, config } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt', FAKE_COUNTER: f.counter });
    // Una comprobación de 1 s garantiza que el mensaje llega mientras la tarea sigue «working».
    config.projects[0].checks.push({ name: 'Corto', command: 'sleep 1' });
    const id = add('Crear hola', 3);
    await until(() => store.listRuns(id)[0]?.endedAt != null);
    store.addComment(id, 'user', 'otra cosa', { pending: true });
    config.projects[0].checks = PASA;
    await orch.waitIdle();
    // Segunda ejecución con el mensaje; el fake termina igual y ya no hay pendientes → integra.
    expect(readFileSync(f.counter, 'utf8')).toBe('2');
    expect(store.listApprovals(id).filter((a) => a.action === 'merge')).toHaveLength(1);
    expect(store.getTask(id).state).toBe('done');
  });

  it('un turno que falla antes de crear la sesión devuelve los mensajes a pendientes', async () => {
    const f = files();
    const { store, orch, project } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt', FAKE_FAIL_FIRST: 'boom', FAKE_COUNTER: f.counter, FAKE_STDIN_OUT: f.stdin });
    const t = store.createTask(project, { title: 'Crear hola', description: '', profileId: 'dev', level: 2 });
    store.addComment(t.id, 'user', 'importante', { pending: true });
    orch.enqueue(t.id);
    await orch.waitIdle();
    const prompts = readJsonl(f.stdin);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Usuario: importante');
  });

  it('done con subtareas: crea los borradores y la tarea sigue a revisión', async () => {
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-subtasks.jsonl') });
    const id = add();
    await orch.waitIdle();
    const kids = store.listChildren(id);
    expect(kids.map((k) => [k.title, k.state, k.level])).toEqual([['Botón', 'draft', 2], ['Texto', 'draft', 3]]);
    expect(store.getTask(id).state).toBe('review');
  });

  it('una subtarea que llega a revisión avisa al padre', async () => {
    const { store, orch, project } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' });
    const parent = store.createTask(project, { title: 'Padre', description: '', profileId: 'dev', level: 2 });
    const child = store.createTask(project, { title: 'Hija', description: '', profileId: 'dev', level: 2, parentId: parent.id });
    orch.enqueue(child.id);
    await orch.waitIdle();
    expect(store.listUndelivered(parent.id).at(-1)?.body).toBe(`${child.id} «Hija» está en revisión: He creado hola.txt`);
  });

  it('blocked con subtareas: crea los borradores con nivel máximo 3', async () => {
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-blocked-subtasks.jsonl') });
    const id = add();
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('blocked');
    expect(store.listChildren(id).map((k) => [k.title, k.state, k.level])).toEqual([['Texto', 'draft', 3]]);
  });

  it('parar durante las comprobaciones no crea subtareas', async () => {
    const { store, orch, add, config } = setup({ FAKE_FIXTURES: fixture('stream-subtasks.jsonl') });
    config.projects[0].checks.push({ name: 'Lento', command: 'sleep 30' });
    const id = add();
    await until(() => (orch as unknown as { checkAborts: Map<string, unknown> }).checkAborts.has(id), 20000);
    await new Promise((r) => setTimeout(r, 200));
    store.setState(id, 'blocked', { blockedReason: 'Parada por el usuario' });
    orch.cancelChecks(id);
    await orch.waitIdle();
    expect(store.listChildren(id)).toEqual([]);
  });
});

describe('Orchestrator · chats', () => {
  function chatSetup(env: Record<string, string>) {
    const coord = { id: 'coordinador', name: 'Coordinador', instructions: 'Divides.', defaultLevel: 1 as const, timeoutMinutes: 1 };
    const s = setup(env, { profiles: [{ id: 'dev', name: 'Dev', instructions: 'Eres un agente de prueba.', defaultLevel: 2, timeoutMinutes: 1 }, coord] });
    const chat = s.store.createTask(s.project, { title: 'Hola', description: '', profileId: 'coordinador', level: 1, kind: 'chat' });
    s.store.addComment(chat.id, 'user', '¿Qué hacemos con la web?', { pending: true });
    s.orch.enqueue(chat.id);
    return { ...s, id: chat.id };
  }

  it('done → idle, sin diff ni checks, con la respuesta como mensaje del agente', async () => {
    const { store, orch, id } = chatSetup({ FAKE_FIXTURES: fixture('stream-done.jsonl') });
    await orch.waitIdle();
    const t = store.getTask(id);
    expect(t.state).toBe('idle');
    expect(t.branch).toBeNull();
    expect(t.worktreePath).toMatch(/DEM-1-chat$/);
    expect(store.listArtifacts(id)).toEqual([]);
    expect(store.listComments(id).at(-1)).toMatchObject({ author: 'agent', body: 'He creado hola.txt' });
  });

  it('el primer turno abre conversación y entrega el mensaje; el segundo retoma solo con el mensaje nuevo', async () => {
    const f = files();
    const { store, orch, id } = chatSetup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_STDIN_OUT: f.stdin });
    await orch.waitIdle();
    store.addComment(id, 'user', 'Vale, hazlo', { pending: true });
    orch.enqueue(id);
    await orch.waitIdle();
    const [p1, p2] = readJsonl(f.stdin);
    expect(p1).toBe('Empieza una conversación nueva con el usuario.\n\nMensajes nuevos desde tu último turno:\n\nUsuario: ¿Qué hacemos con la web?');
    expect(p2).toBe('Mensajes nuevos desde tu último turno:\n\nUsuario: Vale, hazlo');
    expect(store.getTask(id).state).toBe('idle');
  });

  it('cada turno ve la punta actual de main', async () => {
    const { repo, store, orch, id } = chatSetup({ FAKE_FIXTURES: fixture('stream-done.jsonl') });
    await orch.waitIdle();
    writeFileSync(path.join(repo, 'nuevo.txt'), 'x');
    gitSync(repo, 'add', '.');
    gitSync(repo, 'commit', '-qm', 'nuevo');
    store.addComment(id, 'user', 'sigue', { pending: true });
    orch.enqueue(id);
    await orch.waitIdle();
    expect(existsSync(path.join(store.getTask(id).worktreePath!, 'nuevo.txt'))).toBe(true);
  });

  it('subtareas del chat como borradores', async () => {
    const { store, orch, id } = chatSetup({ FAKE_FIXTURES: fixture('stream-subtasks.jsonl') });
    await orch.waitIdle();
    expect(store.listChildren(id)).toHaveLength(2);
    expect(store.getTask(id).state).toBe('idle');
  });

  it('si el usuario para el chat mientras responde, un done tardío no cambia nada', async () => {
    const { store, orch, runner, id } = chatSetup({ FAKE_FIXTURES: fixture('stream-subtasks.jsonl') });
    const run = runner.run.bind(runner);
    runner.run = async (o) => {
      const r = await run(o);
      store.setState(id, 'blocked', { blockedReason: 'Parada por el usuario' });
      return r;
    };
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('blocked');
    expect(store.listComments(id).filter((c) => c.author === 'agent')).toEqual([]);
    expect(store.listChildren(id)).toEqual([]);
  });

  it('si refreshDetached falla, el chat queda bloqueado con el error', async () => {
    const { store, orch, id } = chatSetup({ FAKE_FIXTURES: fixture('stream-done.jsonl') });
    await orch.waitIdle();
    (orch as unknown as { d: { workspaces: GitWorkspaces } }).d.workspaces.refreshDetached = async () => { throw new Error('boom'); };
    store.addComment(id, 'user', 'sigue', { pending: true });
    orch.enqueue(id);
    await orch.waitIdle();
    const t = store.getTask(id);
    expect(t.state).toBe('blocked');
    expect(t.blockedReason).toContain('boom');
  });

  it('si el worktree del chat desapareció, lo recrea', async () => {
    const { store, orch, id } = chatSetup({ FAKE_FIXTURES: fixture('stream-done.jsonl') });
    await orch.waitIdle();
    const wt = store.getTask(id).worktreePath!;
    rmSync(wt, { recursive: true, force: true });
    store.addComment(id, 'user', 'sigue', { pending: true });
    orch.enqueue(id);
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('idle');
    expect(existsSync(wt)).toBe(true);
  });

  it('shutdown: deja de lanzar, corta lo que siga y lo devuelve a la cola', async () => {
    const { store, orch, add } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_HANG: '1' }, { maxConcurrentRuns: 1 });
    const a = add('A');
    const b = add('B');
    await until(() => store.getTask(a).state === 'working');
    const start = Date.now();
    await orch.shutdown(200);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(store.getTask(a).state).toBe('queued');
    expect(store.listRuns(a)[0].outcome).toBe('interrupted');
    orch.tick();
    expect(store.getTask(b).state).toBe('queued');
  });

  it('shutdown durante las comprobaciones devuelve la tarea a la cola', async () => {
    const { store, orch, add, config } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' });
    config.projects[0].checks.push({ name: 'Lento', command: 'sleep 30' });
    const id = add();
    await until(() => store.listRuns(id)[0]?.endedAt != null);
    await until(() => (orch as unknown as { checkAborts: Map<string, unknown> }).checkAborts.has(id), 20000);
    await orch.shutdown(100);
    expect(store.getTask(id).state).toBe('queued');
  });
});

describe('Orchestrator · revisión final de la fase 2', () => {
  it('M3: recover de una ejecución sin init devuelve a pendientes los mensajes que iban en ella', async () => {
    const { store, config, orch } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl') });
    const t = store.createTask(getProject(config, 'demo'), { title: 'Cortada', description: '', profileId: 'dev', level: 2 });
    const viejo = store.addComment(t.id, 'user', 'mensaje ya entregado antes', { pending: true });
    store.markDelivered([viejo.id]);
    await new Promise((r) => setTimeout(r, 5));
    const nuevo = store.addComment(t.id, 'user', 'mensaje del turno cortado', { pending: true });
    store.setState(t.id, 'queued');
    store.setState(t.id, 'working', { sessionId: 'sess-x' });
    store.startRun(t.id, 'sess-x');
    store.markDelivered([nuevo.id]);
    orch.recover();
    expect(store.listUndelivered(t.id).map((c) => c.id)).toEqual([nuevo.id]);
  });
});
