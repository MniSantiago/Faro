import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, Store } from '../src/server/store';
import { InvalidTransitionError } from '../src/server/taskState';
import { getProject } from '../src/server/config';
import type { ProjectConfig } from '../src/server/types';
import { makeConfig, makeMultiConfig, makeRepo } from './helpers';

const project: ProjectConfig = {
  id: 'demo', name: 'Demo', prefix: 'DEM', repoPath: '/tmp/x', baseBranch: 'main', remote: 'origin',
  worktreesDir: '/tmp/wt', startNumber: 9, prepare: [], checks: [],
};

let store: Store;
beforeEach(() => { store = new Store(':memory:'); });

const newTask = (title = 'Tarea') =>
  store.createTask(project, { title, description: 'desc', profileId: 'ios', level: 2 });

describe('tareas', () => {
  it('sessionStarted empieza en false y se puede marcar', () => {
    const t = newTask();
    expect(t.sessionStarted).toBe(false);
    expect(store.updateTask(t.id, { sessionStarted: true }).sessionStarted).toBe(true);
  });

  it('migra una base de datos antigua sin session_started', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'faro-db-')), 'faro.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      profile_id TEXT NOT NULL, state TEXT NOT NULL, level INTEGER NOT NULL, parent_id TEXT, routine_id TEXT,
      branch TEXT, worktree_path TEXT, session_id TEXT, next_prompt TEXT, blocked_reason TEXT, summary TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    old.prepare(`INSERT INTO tasks (id, project_id, title, description, profile_id, state, level, session_id, created_at, updated_at)
      VALUES ('DEM-1', 'demo', 't', '', 'dev', 'blocked', 2, 'sess-vieja', 'x', 'x')`).run();
    old.close();
    const s1 = new Store(file);
    expect(s1.getTask('DEM-1')).toMatchObject({ sessionId: 'sess-vieja', sessionStarted: false });
    s1.close();
    const s2 = new Store(file);
    expect(s2.getTask('DEM-1').sessionStarted).toBe(false);
    s2.close();
  });

  it('runSawInit indica si la ejecución registró el evento de inicio', () => {
    const t = newTask();
    const a = store.startRun(t.id, 's');
    const b = store.startRun(t.id, 's');
    store.addEvent(a.id, t.id, 'system', { sessionId: 's' });
    store.addEvent(b.id, t.id, 'message', { text: 'x' });
    expect(store.runSawInit(a.id)).toBe(true);
    expect(store.runSawInit(b.id)).toBe(false);
  });

  it('sin startNumber, prepare ni checks numera desde 1', () => {
    const s = new Store(':memory:');
    const { startNumber: _n, prepare: _p, checks: _c, ...bare } = project;
    expect(s.createTask({ ...bare, id: 'otro', prefix: 'OTR' }, { title: 'T', description: '', profileId: 'dev', level: 2 }).id).toBe('OTR-1');
  });

  it('numera desde startNumber y crea en borrador', () => {
    const a = newTask();
    const b = newTask();
    expect(a.id).toBe('DEM-9');
    expect(b.id).toBe('DEM-10');
    expect(a.state).toBe('draft');
    expect(a.attempts).toBe(0);
  });

  it('setState valida la transición y aplica el patch', () => {
    const t = newTask();
    const q = store.setState(t.id, 'queued', { nextPrompt: 'hola' });
    expect(q.state).toBe('queued');
    expect(q.nextPrompt).toBe('hola');
    expect(() => store.setState(t.id, 'done')).toThrow(InvalidTransitionError);
  });

  it('updateTask acepta null y deja intacto lo no indicado', () => {
    const t = store.updateTask(newTask().id, { branch: 'DEM-9-x', summary: 'algo' });
    const u = store.updateTask(t.id, { summary: null });
    expect(u.branch).toBe('DEM-9-x');
    expect(u.summary).toBeNull();
  });

  it('listTasks filtra por estado y ordena por creación', () => {
    const a = newTask('a');
    const b = newTask('b');
    store.setState(b.id, 'queued');
    expect(store.listTasks().map((t) => t.id)).toEqual([a.id, b.id]);
    expect(store.listTasks(['queued']).map((t) => t.id)).toEqual([b.id]);
  });

  it('getTask lanza NotFoundError y findTask devuelve null', () => {
    expect(() => store.getTask('DEM-999')).toThrow(NotFoundError);
    expect(store.findTask('DEM-999')).toBeNull();
  });
});

describe('ejecuciones y eventos', () => {
  it('registra ejecuciones abiertas y cerradas', () => {
    const t = newTask();
    const run = store.startRun(t.id, 'sess-1');
    expect(store.openRuns().map((r) => r.id)).toEqual([run.id]);
    const done = store.finishRun(run.id, 'done', { input: 5, output: 7 });
    expect(done.outcome).toBe('done');
    expect(done.outputTokens).toBe(7);
    expect(store.openRuns()).toEqual([]);
  });

  it('guarda eventos con payload JSON y pagina por id', () => {
    const t = newTask();
    const run = store.startRun(t.id, 's');
    const e1 = store.addEvent(run.id, t.id, 'message', { text: 'hola' });
    store.addEvent(run.id, t.id, 'tool', { name: 'Write' });
    expect(store.listEvents(t.id).map((e) => e.kind)).toEqual(['message', 'tool']);
    expect(store.listEvents(t.id, e1.id).map((e) => e.payload)).toEqual([{ name: 'Write' }]);
  });
});

describe('artefactos, aprobaciones, comentarios y meta', () => {
  it('artefactos', () => {
    const t = newTask();
    const a = store.addArtifact(t.id, 'diff', '/tmp/d.patch', 'Diff');
    expect(store.getArtifact(a.id).label).toBe('Diff');
    store.clearArtifacts(t.id);
    expect(store.listArtifacts(t.id)).toEqual([]);
    expect(() => store.getArtifact(a.id)).toThrow(NotFoundError);
  });

  it('aprobaciones', () => {
    const t = newTask();
    const p = store.addApproval(t.id, 'push', 'pending');
    expect(p.decidedAt).toBeNull();
    const d = store.decideApproval(p.id, 'approved');
    expect(d.state).toBe('approved');
    expect(d.decidedAt).not.toBeNull();
  });

  it('comentarios y meta', () => {
    const t = newTask();
    store.addComment(t.id, 'user', 'hola');
    expect(store.listComments(t.id)[0]).toMatchObject({ author: 'user', body: 'hola' });
    expect(store.getMeta('queue')).toBeNull();
    store.setMeta('queue', { paused: true });
    expect(store.getMeta<{ paused: boolean }>('queue')).toEqual({ paused: true });
  });
});

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), 'faro-db-'));

describe('Store · fase 2', () => {
  it('tareas: kind, release y questions por defecto', () => {
    const s = new Store(':memory:');
    const t = s.createTask(project, { title: 'T', description: '', profileId: 'dev', level: 2 });
    expect(t).toMatchObject({ kind: 'task', release: 'none', questions: null });
    const c = s.createTask(project, { title: 'C', description: '', profileId: 'dev', level: 1, kind: 'chat', release: 'build' });
    expect(c).toMatchObject({ kind: 'chat', release: 'build' });
  });

  it('questions se guarda al bloquear y se borra al salir de blocked', () => {
    const s = new Store(':memory:');
    const t = s.createTask(project, { title: 'T', description: '', profileId: 'dev', level: 2 });
    s.setState(t.id, 'queued');
    s.setState(t.id, 'working');
    const qs = [{ id: 'q1', text: '¿Color?', options: ['Rojo', 'Azul'] }];
    expect(s.setState(t.id, 'blocked', { questions: qs }).questions).toEqual(qs);
    expect(s.setState(t.id, 'queued').questions).toBeNull();
  });

  it('comentarios pendientes: listar, entregar y devolver a pendiente', () => {
    const s = new Store(':memory:');
    const t = s.createTask(project, { title: 'T', description: '', profileId: 'dev', level: 2 });
    const a = s.addComment(t.id, 'agent', 'hecho');
    expect(a.deliveredAt).not.toBeNull();
    const u = s.addComment(t.id, 'user', 'cambia esto', { pending: true });
    const f = s.addComment(t.id, 'faro', 'aviso', { pending: true });
    expect(s.listUndelivered(t.id).map((c) => c.id)).toEqual([u.id, f.id]);
    expect(s.hasPendingUserMessages(t.id)).toBe(true);
    s.markDelivered([u.id, f.id]);
    expect(s.listUndelivered(t.id)).toEqual([]);
    expect(s.hasPendingUserMessages(t.id)).toBe(false);
    s.markUndelivered([u.id]);
    expect(s.listUndelivered(t.id).map((c) => c.id)).toEqual([u.id]);
  });

  it('un aviso de Faro pendiente no cuenta como mensaje del usuario', () => {
    const s = new Store(':memory:');
    const t = s.createTask(project, { title: 'T', description: '', profileId: 'dev', level: 2 });
    s.addComment(t.id, 'faro', 'aviso', { pending: true });
    expect(s.hasPendingUserMessages(t.id)).toBe(false);
  });

  it('hijos y tareas de una rutina', () => {
    const s = new Store(':memory:');
    const p = s.createTask(project, { title: 'P', description: '', profileId: 'dev', level: 2 });
    const h = s.createTask(project, { title: 'H', description: '', profileId: 'dev', level: 2, parentId: p.id });
    const r1 = s.createTask(project, { title: 'R1', description: '', profileId: 'dev', level: 1, routineId: 'semanal' });
    const r2 = s.createTask(project, { title: 'R2', description: '', profileId: 'dev', level: 1, routineId: 'semanal' });
    expect(s.listChildren(p.id).map((t) => t.id)).toEqual([h.id]);
    expect(s.listTasksByRoutine('semanal', 5).map((t) => t.id)).toEqual([r2.id, r1.id]);
  });

  it('rutinas: upsert conserva estado salvo que cambie el cron, y borra las que sobran', () => {
    const s = new Store(':memory:');
    s.upsertRoutine('a', 'demo', '0 9 * * 1', '2026-10-19T07:00:00.000Z');
    s.updateRoutine('a', { enabled: true, nextRunAt: '2026-10-12T07:00:00.000Z' });
    expect(s.upsertRoutine('a', 'demo', '0 9 * * 1', '2099-01-01T00:00:00.000Z')).toMatchObject({ enabled: true, nextRunAt: '2026-10-12T07:00:00.000Z' });
    expect(s.upsertRoutine('a', 'demo', '0 10 * * 1', '2026-10-19T08:00:00.000Z')).toMatchObject({ enabled: true, cron: '0 10 * * 1', nextRunAt: '2026-10-19T08:00:00.000Z' });
    s.upsertRoutine('b', 'demo', null, null);
    s.deleteRoutinesExcept(['b']);
    expect(s.listRoutines().map((r) => r.id)).toEqual(['b']);
    expect(s.getRoutine('b')).toMatchObject({ enabled: false, cron: null });
  });

  it('jobs: crear, terminar con meta y listar los que siguen en marcha', () => {
    const s = new Store(':memory:');
    const t = s.createTask(project, { title: 'T', description: '', profileId: 'dev', level: 4 });
    const j = s.createJob(t.id, 'build');
    expect(j).toMatchObject({ state: 'running', meta: {}, endedAt: null });
    expect(s.runningJobs().map((x) => x.id)).toEqual([j.id]);
    const done = s.finishJob(j.id, 'ok', { meta: { buildId: 'b1', url: 'https://expo.dev/b1' }, outputPath: '/tmp/x.log' });
    expect(done).toMatchObject({ state: 'ok', meta: { buildId: 'b1' }, outputPath: '/tmp/x.log' });
    expect(done.endedAt).not.toBeNull();
    expect(s.runningJobs()).toEqual([]);
    expect(s.listJobs(t.id)).toHaveLength(1);
  });

  it('migra una base de la fase 1: columnas nuevas y comentarios viejos entregados', () => {
    const file = path.join(tmpDir(), 'old.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      profile_id TEXT NOT NULL, state TEXT NOT NULL, level INTEGER NOT NULL, parent_id TEXT, routine_id TEXT,
      branch TEXT, worktree_path TEXT, session_id TEXT, next_prompt TEXT, blocked_reason TEXT, summary TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO tasks VALUES ('DEM-1','demo','T','','dev','review',2,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,'2026-01-01','2026-01-01');
      INSERT INTO comments (task_id, author, body, created_at) VALUES ('DEM-1','user','hola','2026-01-01');`);
    old.close();
    const s = new Store(file);
    expect(s.getTask('DEM-1')).toMatchObject({ kind: 'task', release: 'none', questions: null, sessionStarted: false });
    expect(s.listComments('DEM-1')[0].deliveredAt).toBe('2026-01-01');
    expect(s.listUndelivered('DEM-1')).toEqual([]);
  });
});

describe('Store · comentarios pendientes', () => {
  it('M4: listUndelivered solo devuelve mensajes del usuario y de Faro', () => {
    const s = store;
    const t = newTask();
    s.addComment(t.id, 'agent', 'del agente', { pending: true });
    s.addComment(t.id, 'user', 'del usuario', { pending: true });
    s.addComment(t.id, 'faro', 'de faro', { pending: true });
    expect(s.listUndelivered(t.id).map((c) => c.author)).toEqual(['user', 'faro']);
  });
});

describe('estadísticas y gasto', () => {
  const fin = (taskId: string, usage: { costUsd?: number | null; ctx?: number; win?: number | null }) => {
    const r = store.startRun(taskId, 's');
    if (usage.ctx !== undefined) store.setRunContext(r.id, usage.ctx);
    return store.finishRun(r.id, 'done', { input: 1, output: 1, costUsd: usage.costUsd, contextWindow: usage.win });
  };
  const win = () => 200000;

  it('suma coste, toma contexto y ventana de la última ejecución', () => {
    const t = newTask();
    fin(t.id, { costUsd: 0.4, ctx: 49000 });
    fin(t.id, { costUsd: 1.12, ctx: 57000, win: 200000 });
    const s = store.taskStats([t.id], win)[t.id];
    expect(s.costUsd).toBeCloseTo(1.52);
    expect(s).toMatchObject({ costPartial: false, contextTokens: 57000, contextWindow: 200000, turns: 2 });
  });

  it('runCostDelta: total menos el último total guardado de la misma tarea y sesión', () => {
    const t = newTask();
    const otra = newTask('Otra');
    const a = store.startRun(t.id, 's1');
    expect(store.runCostDelta(a.id, 1)).toBe(1); // primera de la sesión: todo el total
    store.finishRun(a.id, 'done', { input: 1, output: 1, costUsd: 1, sessionTotalUsd: 1 });
    const b = store.startRun(t.id, 's1'); store.finishRun(b.id, 'done', { input: 1, output: 1 }); // sin resultado
    const c = store.startRun(t.id, 's2'); store.finishRun(c.id, 'done', { input: 1, output: 1, costUsd: 5, sessionTotalUsd: 5 });
    const d = store.startRun(otra.id, 's1'); store.finishRun(d.id, 'done', { input: 1, output: 1, costUsd: 7, sessionTotalUsd: 7 });
    const e = store.startRun(t.id, 's1');
    expect(store.runCostDelta(e.id, 1.25)).toBeCloseTo(0.25);
    expect(store.runCostDelta(e.id, 0.5)).toBe(0); // nunca negativo
    expect(store.runCostDelta(store.startRun(t.id, 's3').id, 0.4)).toBeCloseTo(0.4);
    expect(store.getRun(a.id)).toMatchObject({ costUsd: 1, sessionTotalUsd: 1 });
  });

  it('runCostDelta: sesión con ejecuciones anteriores sin total guardado (antes de la migración) → null', () => {
    const t = newTask();
    const old = store.startRun(t.id, 's1'); store.finishRun(old.id, 'done', { input: 1, output: 1 });
    const r = store.startRun(t.id, 's1');
    expect(store.runCostDelta(r.id, 40)).toBeNull();
  });


  it('marca el coste como parcial si una ejecución terminada no lo tiene', () => {
    const t = newTask();
    fin(t.id, {});
    fin(t.id, { costUsd: 0.5 });
    expect(store.taskStats([t.id], win)[t.id]).toMatchObject({ costUsd: 0.5, costPartial: true });
  });

  it('tarea sin ejecuciones usa la ventana por defecto', () => {
    const t = newTask();
    expect(store.taskStats([t.id], () => 123)[t.id]).toMatchObject({
      costUsd: null, costPartial: false, contextTokens: null, contextWindow: 123, turns: 0, model: null, lastMessage: null,
    });
  });

  it('una ejecución en marcha hereda la ventana de la anterior', () => {
    const t = newTask();
    fin(t.id, { costUsd: 1, ctx: 10, win: 1000000 });
    const r = store.startRun(t.id, 's');
    store.setRunContext(r.id, 30000);
    store.setRunModel(r.id, 'opus');
    expect(store.taskStats([t.id], win)[t.id]).toMatchObject({ contextWindow: 1000000, contextTokens: 30000, model: 'opus', turns: 2 });
  });

  it('lastMessage: primera línea del último mensaje, máx. 140', () => {
    const t = newTask();
    const r = store.startRun(t.id, 's');
    store.addEvent(r.id, t.id, 'message', { text: 'viejo' });
    store.addEvent(r.id, t.id, 'message', { text: `${'x'.repeat(200)}\nsegunda` });
    expect(store.taskStats([t.id], win)[t.id].lastMessage).toBe('x'.repeat(140));
  });

  it('spend: hoy y últimos 7 días', () => {
    const t = newTask();
    const days = (n: number) => new Date(new Date('2026-10-17T12:00:00').getTime() - n * 86400000).toISOString();
    const ids = [1, 2, 4].map((c) => fin(t.id, { costUsd: c }).id);
    const db = (store as unknown as { db: Database.Database }).db;
    [0, 3, 10].forEach((d, i) => db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(days(d), ids[i]));
    expect(store.spend(new Date('2026-10-17T12:00:00'))).toEqual({ today: 1, week: 3 });
  });

  describe('gasto por proyecto', () => {
    const other: ProjectConfig = { ...project, id: 'otro', prefix: 'OTR' };
    const setup = () => {
      const a = newTask();
      const b = store.createTask(other, { title: 'B', description: '', profileId: 'dev', level: 2 });
      fin(a.id, { costUsd: 1 });
      fin(b.id, { costUsd: 10 });
      store.recordAssistantCall(0.5, true, 'demo');
      store.recordAssistantCall(5, true, 'otro');
      store.recordAssistantCall(100, true); // fila vieja, sin proyecto
    };

    it('spend por proyecto suma solo sus ejecuciones y llamadas del asistente', () => {
      setup();
      const from = new Date(Date.now() - 86400000).toISOString();
      expect(store.spend(new Date(), 'demo')).toEqual({ today: 1.5, week: 1.5 });
      expect(store.spend(new Date(), 'otro')).toEqual({ today: 15, week: 15 });
      expect(store.spendByDay(from, 'demo').reduce((n, r) => n + r.usd, 0)).toBe(1.5);
      expect(store.spendBy('profile', from, 'demo')).toEqual([{ key: 'ios', usd: 1, runs: 1 }, { key: 'Asistente', usd: 0.5, runs: 1 }]);
      expect(store.runCount(from, 'otro')).toBe(1);
      expect(store.assistantCallsSince(from, 'demo')).toBe(1);
      expect(store.assistantCallsSince(from, 'nada')).toBe(0);
    });

    it('sin proyecto, el total no cambia (incluye las filas viejas sin proyecto)', () => {
      setup();
      const from = new Date(Date.now() - 86400000).toISOString();
      expect(store.spend(new Date())).toEqual({ today: 116.5, week: 116.5 });
      expect(store.runCount(from)).toBe(2);
      expect(store.assistantCallsSince(from)).toBe(3);
    });
  });

  it('migra una tabla runs antigua sin perder filas', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'faro-db-')), 'faro.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, session_id TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0)`);
    old.prepare("INSERT INTO runs (task_id, session_id, started_at, input_tokens) VALUES ('DEM-1', 's', 'x', 7)").run();
    old.close();
    const s = new Store(file);
    expect(s.listRuns('DEM-1')).toMatchObject([{ inputTokens: 7, costUsd: null, contextTokens: null, contextWindow: null, model: null, sessionTotalUsd: null }]);
  });

  it('listTasks pagina y ordena de más reciente a más antigua', () => {
    const ids = [1, 2, 3, 4].map((i) => newTask(`T${i}`).id);
    store.setState(ids[0], 'discarded');
    store.setState(ids[1], 'discarded');
    store.setState(ids[2], 'discarded');
    const page = store.listTasks(['done', 'discarded'], { limit: 2, offset: 0, newestFirst: true });
    expect(page.map((t) => t.id)).toEqual([ids[2], ids[1]]);
    expect(store.listTasks(['discarded'], { limit: 2, offset: 2 }).map((t) => t.id)).toEqual([ids[2]]);
    expect(store.listTasks(undefined, { limit: 1, offset: 0, newestFirst: true }).map((t) => t.id)).toEqual([ids[3]]);
  });
});

describe('descargas por día y país', () => {
  it('upsertDailyDownloads reemplaza el día entero y no duplica', () => {
    store.upsertDailyDownloads('demo', '2026-10-13', [{ country: 'ES', units: 5 }, { country: 'US', units: 3 }]);
    store.upsertDailyDownloads('demo', '2026-10-13', [{ country: 'ES', units: 6 }]);
    store.upsertDailyDownloads('demo', '2026-10-12', [{ country: 'ES', units: 1 }]);
    store.upsertDailyDownloads('otro', '2026-10-13', [{ country: 'ES', units: 99 }]);
    expect(store.dailyDownloads('demo', '2026-10-01', '2026-10-31')).toEqual([
      { day: '2026-10-12', country: 'ES', units: 1 }, { day: '2026-10-13', country: 'ES', units: 6 },
    ]);
    expect(store.dailyDownloads('demo', '2026-10-13', '2026-10-13')).toHaveLength(1);
    expect([...store.downloadDays('demo', '2026-10-13')]).toEqual(['2026-10-13']);
    expect(store.downloadDays('demo', '2026-10-01')).toEqual(new Set(['2026-10-12', '2026-10-13']));
  });

  it('un día vacío cuenta como conocido y suma 0', () => {
    store.upsertDailyDownloads('demo', '2026-10-05', []);
    expect(store.downloadDays('demo', '2026-10-01').has('2026-10-05')).toBe(true);
    expect(store.dailyDownloads('demo', '2026-10-05', '2026-10-05')).toEqual([{ day: '2026-10-05', country: '', units: 0 }]);
  });
});

describe('repos de la tarea', () => {
  it('createTask guarda repos en multi-repo y null en un repo', () => {
    const multi = getProject(makeMultiConfig(), 'multi');
    const mk = (p: ProjectConfig, repos?: string[]) => store.createTask(p, { title: 't', description: '', profileId: 'dev', level: 2, repos });
    expect(mk(multi, ['b']).repos).toEqual(['b']);
    expect(store.getTask('MUL-1').repos).toEqual(['b']);
    expect(mk(multi).repos).toBeNull();
    expect(() => mk(multi, ['zzz'])).toThrow(/repo desconocido zzz/);
    expect(mk(getProject(makeConfig(makeRepo()), 'demo'), ['main']).repos).toBeNull();
    expect(newTask().repos).toBeNull();
  });

  it('una fila antigua sin columna repos se lee como null', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'faro-db-')), 'faro.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      profile_id TEXT NOT NULL, state TEXT NOT NULL, level INTEGER NOT NULL, parent_id TEXT, routine_id TEXT,
      branch TEXT, worktree_path TEXT, session_id TEXT, next_prompt TEXT, blocked_reason TEXT, summary TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    old.prepare(`INSERT INTO tasks (id, project_id, title, description, profile_id, state, level, created_at, updated_at)
      VALUES ('DEM-1', 'demo', 't', '', 'dev', 'draft', 2, 'x', 'x')`).run();
    old.close();
    expect(new Store(file).getTask('DEM-1').repos).toBeNull();
  });
});
