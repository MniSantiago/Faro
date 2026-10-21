import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionError, BadRequestError, chatTitle, ReviewActions } from '../src/server/actions';
import { Bus } from '../src/server/bus';
import { getProject } from '../src/server/config';
import { runTaskChecks } from '../src/server/checks';
import { Orchestrator } from '../src/server/orchestrator';
import { Runner } from '../src/server/runner/runner';
import { Store } from '../src/server/store';
import type { FaroConfig } from '../src/server/types';
import { isIntegrating, withIntegrationLock } from '../src/server/locks';
import { GitWorkspaces } from '../src/server/workspaces';
import { fixture, gitSync, makeConfig, makeMultiConfig, makeRepo, tmpDir, until } from './helpers';

function setup(env: Record<string, string>, over: Partial<FaroConfig> = {}) {
  const repo = makeRepo();
  const config = makeConfig(repo, over);
  const store = new Store(':memory:');
  const bus = new Bus();
  const workspaces = new GitWorkspaces();
  const runner = new Runner({ store, bus, claudeBin: config.claudeBin, env, killGraceMs: 100 });
  const orch = new Orchestrator({ store, config, bus, runner, workspaces, runChecks: runTaskChecks, setTimer: () => {} });
  const actions = new ReviewActions({ store, config, bus, workspaces, orchestrator: orch, runner });
  return { repo, config, store, orch, actions, runner };
}

const DONE = { FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'hola.txt' };
const input = { projectId: 'demo', title: 'Crear hola', description: '', profileId: 'dev' };

async function inReview(env: Record<string, string> = DONE) {
  const s = setup(env);
  const t = s.actions.createTask(input);
  await s.orch.waitIdle();
  return { ...s, id: t.id };
}

describe('ReviewActions', () => {
  it('parar durante las comprobaciones corta el check, bloquea y no integra', async () => {
    const s = setup(DONE);
    s.config.projects[0].checks!.push({ name: 'Lento', command: 'sleep 30' });
    const t = s.actions.createTask({ ...input, level: 3 });
    // La ejecución del agente terminó y Faro está en las comprobaciones.
    // Espera a que las comprobaciones estén de verdad en curso (commit y diff pueden tardar bajo carga).
    await until(() => (s.orch as unknown as { checkAborts: Map<string, unknown> }).checkAborts.has(t.id), 20000);
    await new Promise((r) => setTimeout(r, 200));
    const start = Date.now();
    await s.actions.stop(t.id);
    await s.orch.waitIdle();
    expect(Date.now() - start).toBeLessThan(10000);
    const task = s.store.getTask(t.id);
    expect(task.state).toBe('blocked');
    expect(task.blockedReason).toBe('Parada por el usuario');
    expect(s.store.listApprovals(t.id)).toEqual([]);
    expect(s.store.listArtifacts(t.id).find((a) => a.kind === 'check')?.label).toBe('Lento: cancelada');
  }, 60000);

  it('createTask usa el nivel por defecto del perfil y encola', async () => {
    const { store, actions, orch } = setup(DONE);
    const t = actions.createTask(input);
    expect(t.level).toBe(2);
    expect(['queued', 'working']).toContain(store.getTask(t.id).state);
    await orch.waitIdle();
  });

  it('createTask en borrador no encola; approveDraft sí', async () => {
    const { store, actions, orch } = setup(DONE);
    const t = actions.createTask({ ...input, draft: true });
    expect(store.getTask(t.id).state).toBe('draft');
    actions.approveDraft(t.id);
    await orch.waitIdle();
    expect(store.getTask(t.id).state).toBe('review');
  });

  it('approve integra en main y deja el push pendiente', async () => {
    const { repo, store, actions, id } = await inReview();
    expect(await actions.approve(id)).toEqual({ status: 'merged', pushed: false });
    expect(store.getTask(id).state).toBe('done');
    expect(gitSync(repo, 'show', 'main:hola.txt')).toBe('hola\n');
    expect(store.listApprovals(id).map((a) => [a.action, a.state])).toEqual([['merge', 'approved'], ['push', 'pending']]);
  });

  it('approve con main sucio en el mismo archivo falla y la tarea sigue en revisión', async () => {
    const { repo, store, actions, id } = await inReview();
    writeFileSync(path.join(repo, 'hola.txt'), 'local sin commitear\n');
    const r = await actions.approve(id);
    expect(r.status).toBe('failed');
    expect(store.getTask(id).state).toBe('review');
    expect(store.listComments(id).at(-1)?.author).toBe('faro');
    expect(readFileSync(path.join(repo, 'hola.txt'), 'utf8')).toBe('local sin commitear\n');
  });

  it('approve con conflicto crea la tarea de conflicto sobre la misma rama y la pone en cola', async () => {
    const { repo, store, actions, id } = await inReview();
    writeFileSync(path.join(repo, 'hola.txt'), 'otra cosa\n');
    gitSync(repo, 'add', '.');
    gitSync(repo, 'commit', '-qm', 'main crea hola distinto');
    const r = await actions.approve(id);
    expect(r.status).toBe('conflict');
    const follow = store.getTask((r as { followUpTaskId: string }).followUpTaskId);
    expect(follow).toMatchObject({ state: 'queued', parentId: id, branch: store.getTask(id).branch });
    expect(store.getTask(id).state).toBe('review');
  });

  it('requestChanges retoma la sesión con el comentario', async () => {
    const dir = tmpDir();
    const stdin = path.join(dir, 'stdin.jsonl');
    const { store, actions, orch, id } = await inReview({ ...DONE, FAKE_STDIN_OUT: stdin });
    actions.requestChanges(id, 'Usa mayúsculas');
    await orch.waitIdle();
    const prompts = readFileSync(stdin, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(prompts[1]).toContain('Usa mayúsculas');
    expect(store.getTask(id).state).toBe('review');
    expect(store.listComments(id).some((c) => c.author === 'user' && c.body === 'Usa mayúsculas')).toBe(true);
  });

  it('answer solo funciona en bloqueadas', async () => {
    const { actions, id } = await inReview();
    expect(() => actions.answer(id, { text: 'azul' })).toThrow(ActionError);
  });

  it('answer retoma una tarea bloqueada', async () => {
    const dir = tmpDir();
    const counter = path.join(dir, 'n');
    const { store, actions, orch, id } = await inReview({
      FAKE_FIXTURES: `${fixture('stream-blocked.jsonl')},${fixture('stream-done.jsonl')}`, FAKE_COUNTER: counter, FAKE_WRITE: 'hola.txt',
    });
    expect(store.getTask(id).state).toBe('blocked');
    actions.answer(id, { text: 'Azul' });
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('review');
  });

  it('discard archiva la rama', async () => {
    const { repo, store, actions, id } = await inReview();
    const branch = store.getTask(id).branch!;
    await actions.discard(id);
    expect(store.getTask(id).state).toBe('discarded');
    expect(gitSync(repo, 'branch', '--list', `archive/${branch}`)).toContain(branch);
  });

  it('approvePush sube main y marca la aprobación', async () => {
    const { repo, store, actions, id } = await inReview();
    const bare = tmpDir('faro-remote-');
    gitSync(bare, 'init', '-q', '--bare', '-b', 'main');
    gitSync(repo, 'remote', 'add', 'origin', bare);
    await actions.approve(id);
    await actions.approvePush(id);
    expect(gitSync(bare, 'show', 'main:hola.txt')).toBe('hola\n');
    expect(store.listApprovals(id).find((a) => a.action === 'push')?.state).toBe('approved');
    await expect(actions.approvePush(id)).rejects.toThrow(ActionError);
  });
  it('diff vacío y cleanup que falla: se cierra sola, hecha y aviso de faro', async () => {
    const repo = makeRepo();
    const config = makeConfig(repo);
    const store = new Store(':memory:');
    const bus = new Bus();
    const real = new GitWorkspaces();
    const workspaces = Object.assign(Object.create(real) as GitWorkspaces, {
      cleanup: async () => { throw new Error('no se pudo borrar'); },
    });
    const env = { FAKE_FIXTURES: fixture('stream-done.jsonl') };
    const runner = new Runner({ store, bus, claudeBin: config.claudeBin, env, killGraceMs: 100 });
    const orch = new Orchestrator({ store, config, bus, runner, workspaces, runChecks: runTaskChecks, setTimer: () => {} });
    const actions = new ReviewActions({ store, config, bus, workspaces, orchestrator: orch, runner });
    const t = actions.createTask(input);
    await orch.waitIdle();
    expect(store.getTask(t.id).state).toBe('done');
    await expect(actions.approve(t.id)).rejects.toThrow(ActionError);
    expect(store.listComments(t.id).some((c) => c.author === 'faro')).toBe(true);
  });

  it('dos approve concurrentes: uno integra y el otro se rechaza', async () => {
    const { store, actions, id } = await inReview();
    const rs = await Promise.allSettled([actions.approve(id), actions.approve(id)]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const ok = rs.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ status: string }>;
    expect(ok.value.status).toBe('merged');
    const bad = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(bad.reason).toBeInstanceOf(ActionError);
    expect(store.listApprovals(id).filter((a) => a.action === 'merge')).toHaveLength(1);
  });

  it('approvePush con remoto que falla: ActionError y sigue pendiente', async () => {
    const { repo, store, actions, id } = await inReview();
    gitSync(repo, 'remote', 'add', 'origin', path.join(tmpDir(), 'no-existe'));
    await actions.approve(id);
    await expect(actions.approvePush(id)).rejects.toThrow(/El push falló/);
    await actions.approvePush(id).catch((e) => expect(e).toBeInstanceOf(ActionError));
    expect(store.listApprovals(id).find((a) => a.action === 'push')?.state).toBe('pending');
  });

  it('descartar el borrador de conflicto no toca la rama del padre', async () => {
    const { repo, store, actions, id } = await inReview();
    writeFileSync(path.join(repo, 'hola.txt'), 'otra cosa\n');
    gitSync(repo, 'add', '.');
    gitSync(repo, 'commit', '-qm', 'main crea hola distinto');
    const r = await actions.approve(id);
    const followId = (r as { followUpTaskId: string }).followUpTaskId;
    const parent = store.getTask(id);
    await actions.discard(followId);
    expect(store.getTask(followId).state).toBe('discarded');
    expect(existsSync(parent.worktreePath!)).toBe(true);
    expect(gitSync(repo, 'branch', '--list', `archive/${parent.branch}`).trim()).toBe('');
    expect(gitSync(repo, 'branch', '--list', parent.branch!)).toContain(parent.branch);
  });

  it('discard con fallo de git: queda descartada con aviso de faro', async () => {
    const repo = makeRepo();
    const config = makeConfig(repo);
    const store = new Store(':memory:');
    const bus = new Bus();
    const real = new GitWorkspaces();
    const workspaces = Object.assign(Object.create(real) as GitWorkspaces, {
      discard: async () => { throw new Error('git roto'); },
    });
    const runner = new Runner({ store, bus, claudeBin: config.claudeBin, env: DONE, killGraceMs: 100 });
    const orch = new Orchestrator({ store, config, bus, runner, workspaces, runChecks: runTaskChecks, setTimer: () => {} });
    const actions = new ReviewActions({ store, config, bus, workspaces, orchestrator: orch, runner });
    const t = actions.createTask(input);
    await orch.waitIdle();
    await actions.discard(t.id);
    expect(store.getTask(t.id).state).toBe('discarded');
    expect(store.listComments(t.id).some((c) => c.author === 'faro' && c.body.includes('git roto'))).toBe(true);
  });

  async function withConflictChild() {
    const s = await inReview();
    writeFileSync(path.join(s.repo, 'hola.txt'), 'otra cosa\n');
    gitSync(s.repo, 'add', '.');
    gitSync(s.repo, 'commit', '-qm', 'main crea hola distinto');
    // Con la cola en pausa, la tarea de conflicto (que Faro encola sola) espera sin arrancar.
    s.orch.pause('manual', null);
    const r = await s.actions.approve(s.id);
    return { ...s, childId: (r as { followUpTaskId: string }).followUpTaskId };
  }

  it('descartar el padre con el hijo de conflicto en cola no toca su worktree ni su rama', async () => {
    const { repo, store, orch, actions, id, childId } = await withConflictChild();
    expect(store.getTask(childId).state).toBe('queued');
    const parent = store.getTask(id);
    await actions.discard(id);
    expect(store.getTask(id).state).toBe('discarded');
    expect(existsSync(parent.worktreePath!)).toBe(true);
    expect(gitSync(repo, 'branch', '--list', parent.branch!)).toContain(parent.branch);
    expect(gitSync(repo, 'branch', '--list', `archive/${parent.branch}`).trim()).toBe('');
    expect(store.listComments(id).some((c) => c.author === 'faro' && c.body.includes(childId))).toBe(true);
    orch.resume();
    await orch.waitIdle();
    expect(store.getTask(childId).state).toBe('review');
  });

  it('requestChanges/answer sobre una tarea cuya rama usa otra tarea en curso se rechaza', async () => {
    const { store, actions, id, childId } = await withConflictChild();
    expect(store.getTask(childId).state).toBe('queued');
    expect(() => actions.requestChanges(id, 'otra cosa')).toThrow(ActionError);
    store.setState(childId, 'working');
    expect(() => actions.requestChanges(id, 'otra cosa')).toThrow(/comparte la rama/);
    expect(store.getTask(id).state).toBe('review');
    expect(store.listComments(id).some((c) => c.body === 'otra cosa')).toBe(false);
    store.setState(id, 'queued');
    store.setState(id, 'blocked');
    expect(() => actions.answer(id, { text: 'azul' })).toThrow(/comparte la rama/);
  });

  it('el orquestador no arranca a la vez dos tareas que comparten rama', async () => {
    const { store, orch, id, childId } = await withConflictChild();
    store.setState(id, 'queued');
    orch.resume();
    expect(orch.queueState().running).toEqual([id]);
    await orch.waitIdle();
    expect(store.getTask(id).state).toBe('review');
    expect(store.getTask(childId).state).toBe('review');
  });

  it('descartar una tarea bloqueada guarda su trabajo sin commitear en la rama archivada', async () => {
    const { repo, store, actions, id } = await inReview({ FAKE_FIXTURES: fixture('stream-blocked.jsonl'), FAKE_WRITE: 'hola.txt' });
    expect(store.getTask(id).state).toBe('blocked');
    const branch = store.getTask(id).branch!;
    await actions.discard(id);
    expect(gitSync(repo, 'show', `archive/${branch}:hola.txt`)).toBe('hola\n');
    expect(gitSync(repo, 'log', '-1', '--format=%s', `archive/${branch}`).trim()).toBe(`${id}: descartada (trabajo sin terminar)`);
  });

  it('stop para una tarea en curso: queda bloqueada y no se vuelve a encolar', async () => {
    const { store, orch, actions, runner } = setup({ FAKE_HANG: '1' });
    const t = actions.createTask(input);
    for (let i = 0; i < 200 && !runner.isRunning(t.id); i++) await new Promise((r) => setTimeout(r, 10));
    expect(store.getTask(t.id).state).toBe('working');
    const out = await actions.stop(t.id);
    expect(out).toMatchObject({ state: 'blocked', blockedReason: 'Parada por el usuario' });
    await orch.waitIdle();
    expect(store.getTask(t.id)).toMatchObject({ state: 'blocked', blockedReason: 'Parada por el usuario' });
    expect(store.listRuns(t.id).map((r) => r.outcome)).toEqual(['interrupted']);
    expect(runner.isRunning(t.id)).toBe(false);
  });

  it('stop solo funciona en tareas trabajando', async () => {
    const { actions, id } = await inReview();
    await expect(actions.stop(id)).rejects.toThrow(ActionError);
  });
});

describe('ReviewActions · message', () => {
  it('en revisión: guarda el mensaje pendiente y encola', async () => {
    const { store, actions, id } = await inReview();
    actions.message(id, 'cambia el texto');
    expect(['queued', 'working']).toContain(store.getTask(id).state);
    expect(store.listComments(id).at(-1)).toMatchObject({ author: 'user', body: 'cambia el texto' });
  });

  it('en cola: solo guarda; se entregará al empezar', () => {
    const { store, actions, config } = setup(DONE);
    const t = store.createTask(getProject(config, 'demo'), { title: 'T', description: '', profileId: 'dev', level: 2 });
    store.setState(t.id, 'queued');
    actions.message(t.id, 'ojo con esto');
    expect(store.getTask(t.id).state).toBe('queued');
    expect(store.listUndelivered(t.id).map((c) => c.body)).toEqual(['ojo con esto']);
  });

  it('trabajando con interrupt: corta la ejecución y vuelve a la cola, no a bloqueada', async () => {
    const f = path.join(tmpDir(), 'n');
    const s = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_HANG: '1', FAKE_COUNTER: f });
    const t = s.actions.createTask(input);
    await until(() => s.store.getTask(t.id).state === 'working' && s.runner.isRunning(t.id) && existsSync(f));
    s.actions.message(t.id, 'para y usa azul', { interrupt: true });
    await until(() => existsSync(f) && readFileSync(f, 'utf8') === '2', 8000);
    expect(s.store.listRuns(t.id)[0].outcome).toBe('interrupted');
    // La segunda ejecución también se cuelga: «Parar» la deja bloqueada para terminar el test.
    await until(() => s.runner.isRunning(t.id));
    await s.actions.stop(t.id);
    await s.orch.waitIdle();
  });

  it('interrumpir durante las comprobaciones no pierde el mensaje', async () => {
    const s = setup(DONE);
    s.config.projects[0].checks!.push({ name: 'Corto', command: 'sleep 1' });
    const t = s.actions.createTask(input);
    await until(() => s.store.listRuns(t.id)[0]?.endedAt != null);
    s.actions.message(t.id, 'una cosa más', { interrupt: true });
    await s.orch.waitIdle();
    expect(s.store.listRuns(t.id)).toHaveLength(2);
    expect(s.store.listUndelivered(t.id)).toEqual([]);
    // La segunda ejecución pasa la comprobación: se integra sola.
    expect(s.store.getTask(t.id).state).toBe('done');
  });

  it('borrador, hecha o descartada no admiten mensajes', () => {
    const { store, actions, config } = setup(DONE);
    const t = store.createTask(getProject(config, 'demo'), { title: 'T', description: '', profileId: 'dev', level: 2 });
    expect(() => actions.message(t.id, 'hola')).toThrow('La tarea no admite mensajes');
  });

  it('mensaje vacío → BadRequestError', async () => {
    const { actions, id } = await inReview();
    expect(() => actions.message(id, '   ')).toThrow(BadRequestError);
  });
});

describe('ReviewActions · answer estructurado', () => {
  async function blockedWithQuestions() {
    const s = setup({ FAKE_FIXTURES: fixture('stream-questions.jsonl') });
    const t = s.actions.createTask(input);
    await s.orch.waitIdle();
    return { ...s, id: t.id };
  }

  it('answers + texto → un comentario formateado, encola y borra las preguntas', async () => {
    const { store, actions, id, runner } = await blockedWithQuestions();
    actions.answer(id, { answers: { color: 'Azul', tono: 'cálido' }, text: 'gracias' });
    const c = store.listComments(id).at(-1)!;
    expect(c).toMatchObject({ author: 'user', body: '**¿Qué color?** → Azul\n**¿Qué tono?** → cálido\n\ngracias' });
    expect(store.getTask(id).questions).toBeNull();
    runner.cancel(id);
  });

  it('id desconocido → BadRequestError', async () => {
    const { actions, id } = await blockedWithQuestions();
    expect(() => actions.answer(id, { answers: { tamaño: 'L' } })).toThrow(BadRequestError);
  });

  it('responder dos veces: la segunda da ActionError y no reencola de nuevo', async () => {
    const { store, actions, id, runner } = await blockedWithQuestions();
    actions.answer(id, { answers: { color: 'Rojo' } });
    expect(() => actions.answer(id, { answers: { color: 'Azul' } })).toThrow(ActionError);
    expect(store.listComments(id).filter((c) => c.author === 'user')).toHaveLength(1);
    runner.cancel(id);
  });

  it('sin answers ni texto → BadRequestError', async () => {
    const { actions, id } = await blockedWithQuestions();
    expect(() => actions.answer(id, {})).toThrow(BadRequestError);
  });

  it('approveDraft cambia el nivel y no permite subir una subtarea por encima de 3', () => {
    const { store, actions } = setup(DONE);
    const project = getProject(makeConfig(makeRepo()), 'demo');
    const parent = store.createTask(project, { title: 'P', description: '', profileId: 'dev', level: 2 });
    const child = store.createTask(project, { title: 'H', description: '', profileId: 'dev', level: 2, parentId: parent.id });
    expect(() => actions.approveDraft(child.id, 4)).toThrow(BadRequestError);
    actions.approveDraft(child.id, 1);
    expect(store.getTask(child.id).level).toBe(1);
  });
});

const setupWithCoordinator = (env: Record<string, string>) =>
  setup(env, { profiles: [...makeConfig(makeRepo()).profiles, { id: 'coordinador', name: 'Coordinador', instructions: 'Divides.', defaultLevel: 1, timeoutMinutes: 1 }] });

describe('ReviewActions · chats', () => {
  it('chatTitle recorta por palabra a 60 caracteres', () => {
    expect(chatTitle('  Hola   equipo ')).toBe('Hola equipo');
    const long = 'Quiero que pensemos juntos cómo reorganizar las expediciones del verano para Demo';
    const t = chatTitle(long);
    expect(t.length).toBeLessThanOrEqual(61);
    expect(t.endsWith('…')).toBe(true);
  });

  it('createChat usa coordinatorProfile si está configurado', async () => {
    const cfg = makeConfig(makeRepo());
    const s = setup(DONE, { coordinatorProfile: cfg.profiles[0].id });
    const t = s.actions.createChat({ projectId: 'demo', text: 'Hola' });
    expect(t.profileId).toBe(cfg.profiles[0].id);
    await s.orch.waitIdle();
  });

  it('createChat: chat de nivel 1 con el mensaje pendiente, encolado', async () => {
    const s = setupWithCoordinator(DONE);
    const t = s.actions.createChat({ projectId: 'demo', text: 'Plan para la web' });
    expect(t).toMatchObject({ kind: 'chat', level: 1, profileId: 'coordinador', title: 'Plan para la web' });
    expect(s.store.listComments(t.id)[0]).toMatchObject({ author: 'user', body: 'Plan para la web' });
    await s.orch.waitIdle();
  });

  it('descartar un chat en idle borra su worktree', async () => {
    const s = setupWithCoordinator({ FAKE_FIXTURES: fixture('stream-done.jsonl') });
    const t = s.actions.createChat({ projectId: 'demo', text: 'Hola' });
    await s.orch.waitIdle();
    const wt = s.store.getTask(t.id).worktreePath!;
    expect(existsSync(wt)).toBe(true);
    await s.actions.discard(t.id);
    expect(existsSync(wt)).toBe(false);
    expect(s.store.getTask(t.id).state).toBe('discarded');
  });

  it('un mensaje a un chat en idle lo encola', async () => {
    const s = setupWithCoordinator({ FAKE_FIXTURES: fixture('stream-done.jsonl') });
    const t = s.actions.createChat({ projectId: 'demo', text: 'Hola' });
    await s.orch.waitIdle();
    s.actions.message(t.id, '¿Y ahora?');
    await s.orch.waitIdle();
    expect(s.store.listRuns(t.id)).toHaveLength(2);
  });
});

describe('ReviewActions · revisión final de la fase 2', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function setupWs(env: Record<string, string>, wsOver: (ws: GitWorkspaces) => Partial<GitWorkspaces>) {
    const repo = makeRepo();
    const config = makeConfig(repo);
    const store = new Store(':memory:');
    const bus = new Bus();
    const base = new GitWorkspaces();
    const workspaces = Object.assign(new GitWorkspaces(), wsOver(base));
    const runner = new Runner({ store, bus, claudeBin: config.claudeBin, env, killGraceMs: 100 });
    const orch = new Orchestrator({ store, config, bus, runner, workspaces, runChecks: runTaskChecks, setTimer: () => {} });
    const actions = new ReviewActions({ store, config, bus, workspaces, orchestrator: orch, runner });
    return { repo, config, store, orch, actions, bus };
  }

  it('I1: mientras se integra solo (nivel 3), las acciones del usuario se rechazan y la tarea acaba hecha', async () => {
    const s = setupWs(DONE, (base) => ({
      merge: async (p, t) => { await sleep(400); return base.merge(p, t); },
    }));
    s.config.projects[0].checks!.push({ name: 'tests', command: 'true' });
    const t = s.actions.createTask({ ...input, level: 3 });
    await until(() => isIntegrating(t.id));
    expect(() => s.actions.message(t.id, 'espera')).toThrow(ActionError);
    expect(() => s.actions.message(t.id, 'espera')).toThrow('Se está integrando; espera un momento');
    expect(() => s.actions.requestChanges(t.id, 'otra cosa')).toThrow('Se está integrando');
    await expect(s.actions.approve(t.id)).rejects.toThrow('Se está integrando');
    await expect(s.actions.discard(t.id)).rejects.toThrow('Se está integrando');
    await s.orch.waitIdle();
    expect(s.store.getTask(t.id).state).toBe('done');
    expect(isIntegrating(t.id)).toBe(false);
    expect(s.store.listComments(t.id).some((c) => c.author === 'user')).toBe(false);
  });

  it('I1: integrate rechaza una segunda integración simultánea de la misma tarea', async () => {
    await expect(withIntegrationLock('X-1', () => withIntegrationLock('X-1', async () => 1))).rejects.toThrow('ya se está integrando');
    expect(isIntegrating('X-1')).toBe(false);
  });

  it('M1: el borrador de un conflicto conserva el lanzamiento de la tarea', async () => {
    const s = setupWs(DONE, () => ({}));
    const t = s.actions.createTask({ ...input, release: 'build' });
    await s.orch.waitIdle();
    writeFileSync(path.join(s.repo, 'hola.txt'), 'otra cosa\n');
    gitSync(s.repo, 'add', '.');
    gitSync(s.repo, 'commit', '-qm', 'main crea hola distinto');
    const r = await s.actions.approve(t.id);
    expect(r.status).toBe('conflict');
    expect(s.store.getTask((r as { followUpTaskId: string }).followUpTaskId).release).toBe('build');
  });

  it('M2: un borrador de conflicto de nivel 4 se aprueba sin cambiarlo; una subtarea de nivel 2 no sube a 4', () => {
    const s = setupWs(DONE, () => ({}));
    const project = getProject(s.config, 'demo');
    const parent = s.store.createTask(project, { title: 'P', description: '', profileId: 'dev', level: 4 });
    const conflict = s.store.createTask(project, { title: 'C', description: '', profileId: 'dev', level: 4, parentId: parent.id });
    const sub = s.store.createTask(project, { title: 'S', description: '', profileId: 'dev', level: 2, parentId: parent.id });
    expect(() => s.actions.approveDraft(sub.id, 4)).toThrow(BadRequestError);
    expect(s.actions.approveDraft(conflict.id, 4)).toMatchObject({ state: 'queued', level: 4 });
  });

  it('M5: descartar mientras se prepara el primer worktree lo archiva y no lanza al agente', async () => {
    let created = '';
    const s = setupWs(DONE, (base) => ({
      create: async (p, t) => { await sleep(300); const wt = await base.create(p, t); created = wt.path; return wt; },
    }));
    const t = s.actions.createTask(input);
    await sleep(50);
    await s.actions.discard(t.id);
    await s.orch.waitIdle();
    expect(s.store.getTask(t.id).state).toBe('discarded');
    expect(s.store.listRuns(t.id)).toEqual([]);
    expect(created).not.toBe('');
    expect(existsSync(created)).toBe(false);
    expect(gitSync(s.repo, 'branch', '--list', 'archive/*').trim()).not.toBe('');
  });

  it('M7: interrumpir durante las comprobaciones las corta enseguida y vuelve a la cola, no a revisión', async () => {
    const dir = tmpDir();
    const mark = path.join(dir, 'mark');
    const s = setupWs(DONE, () => ({}));
    // La primera vez la comprobación tarda 30 s; las siguientes, nada.
    s.config.projects[0].checks!.push({ name: 'Lenta', command: `if [ -f '${mark}' ]; then exit 0; fi; touch '${mark}'; sleep 30` });
    const states: string[] = [];
    s.bus.subscribe((m) => { if (m.type === 'task') states.push(m.task.state); });
    const t = s.actions.createTask(input);
    await until(() => existsSync(mark));
    const start = Date.now();
    s.actions.message(t.id, 'cambia una cosa', { interrupt: true });
    await s.orch.waitIdle();
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(s.store.listRuns(t.id)).toHaveLength(2);
    // Ni la ejecución interrumpida ni la segunda (que pasa la comprobación y se integra sola) emiten «review».
    expect(states.filter((x) => x === 'review')).toHaveLength(0);
    expect(s.store.getTask(t.id).state).toBe('done');
  }, 20_000);
});

describe('ReviewActions · varios repos', () => {
  function multiSetup(env: Record<string, string>) {
    const config = makeMultiConfig({ coordinatorProfile: 'dev' });
    const store = new Store(':memory:');
    const bus = new Bus();
    const workspaces = new GitWorkspaces();
    const runner = new Runner({ store, bus, claudeBin: config.claudeBin, env, killGraceMs: 100 });
    const orch = new Orchestrator({ store, config, bus, runner, workspaces, runChecks: runTaskChecks, setTimer: () => {} });
    const actions = new ReviewActions({ store, config, bus, workspaces, orchestrator: orch, runner });
    const project = getProject(config, 'multi');
    const repo = (id: string) => project.repos!.find((r) => r.id === id)!.path;
    return { store, orch, actions, repo };
  }

  it('discard multi-repo guarda lo sin commitear, archiva la rama en cada repo y borra la carpeta', async () => {
    const s = multiSetup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'a/x.txt', FAKE_WRITE_ARTIFACT: 'b/y.txt' });
    const t = s.actions.createTask({ projectId: 'multi', title: 'Dos repos', description: '', profileId: 'dev', level: 1 });
    await s.orch.waitIdle();
    const { branch, worktreePath } = s.store.getTask(t.id);
    writeFileSync(path.join(worktreePath!, 'b', 'sin-commit.txt'), 'a medias\n');
    await s.actions.discard(t.id);
    expect(s.store.getTask(t.id).state).toBe('discarded');
    expect(existsSync(worktreePath!)).toBe(false);
    for (const id of ['a', 'b']) expect(gitSync(s.repo(id), 'branch', '--list', `archive/${branch}`)).toContain(branch!);
    expect(gitSync(s.repo('b'), 'show', `archive/${branch}:sin-commit.txt`)).toBe('a medias\n');
  });

  it('discard multi-repo sin el worktree de un repo guarda igual lo de los demás y lo deja dicho', async () => {
    const s = multiSetup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_WRITE: 'a/x.txt', FAKE_WRITE_ARTIFACT: 'b/y.txt' });
    const t = s.actions.createTask({ projectId: 'multi', title: 'Falta uno', description: '', profileId: 'dev', level: 1 });
    await s.orch.waitIdle();
    const { branch, worktreePath } = s.store.getTask(t.id);
    // El worktree de `a` ha desaparecido (borrado a mano); en `b` hay trabajo sin commitear.
    gitSync(s.repo('a'), 'worktree', 'remove', '--force', path.join(worktreePath!, 'a'));
    writeFileSync(path.join(worktreePath!, 'b', 'sin-commit.txt'), 'a medias\n');
    await s.actions.discard(t.id);
    expect(s.store.getTask(t.id).state).toBe('discarded');
    expect(gitSync(s.repo('b'), 'show', `archive/${branch}:sin-commit.txt`)).toBe('a medias\n');
    for (const id of ['a', 'b']) expect(gitSync(s.repo(id), 'branch', '--list', `archive/${branch}`)).toContain(branch!);
    expect(s.store.listComments(t.id).some((c) => c.author === 'faro' && c.body.includes('a') && c.body.includes('worktree'))).toBe(true);
  });

  it('archivar un chat multi-repo borra sus worktrees y la carpeta', async () => {
    const s = multiSetup({ FAKE_FIXTURES: fixture('stream-done.jsonl') });
    const t = s.actions.createChat({ projectId: 'multi', text: 'Hola' });
    await s.orch.waitIdle();
    const wt = s.store.getTask(t.id).worktreePath!;
    expect(existsSync(path.join(wt, 'a'))).toBe(true);
    await s.actions.discard(t.id);
    expect(existsSync(wt)).toBe(false);
    for (const id of ['a', 'b']) expect(gitSync(s.repo(id), 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });
});
