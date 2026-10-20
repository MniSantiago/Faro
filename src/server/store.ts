import { randomUUID, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import { assertTransition } from './taskState';
import { AsoRepo } from './aso/repo';
import type { Snapshot, SourceId } from './metrics/types';
import type { OverrideKind, OverrideRow } from './overrides';
import type {
  Approval, ApprovalState, Artifact, ArtifactKind, Comment, CommentAuthor, Device, EventKind, EventRow,
  FinalAction, Job, JobKind, JobState, Level, ProjectConfig, Question, Release, RoutineRow, Run, RunOutcome, Task,
  TaskKind, TaskState, TaskStats, Spend,
} from './types';

export interface PushKeys { p256dh: string; auth: string }
export interface PushSubscriptionRow {
  id: number; deviceId: string | null; endpoint: string; keys: PushKeys; createdAt: string; lastError: string | null;
}

export class NotFoundError extends Error {}

export type TaskPatch = Partial<Pick<Task,
  'title' | 'description' | 'level' | 'branch' | 'worktreePath' | 'sessionId' | 'sessionStarted' | 'nextPrompt' |
  'blockedReason' | 'summary' | 'attempts' | 'questions' | 'release'>>;

export interface NewTaskInput {
  title: string;
  description: string;
  profileId: string;
  level: Level;
  parentId?: string | null;
  routineId?: string | null;
  kind?: TaskKind;
  release?: Release;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS counters (project_id TEXT PRIMARY KEY, next INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
  profile_id TEXT NOT NULL, state TEXT NOT NULL, level INTEGER NOT NULL, parent_id TEXT, routine_id TEXT,
  branch TEXT, worktree_path TEXT, session_id TEXT, session_started INTEGER NOT NULL DEFAULT 0, next_prompt TEXT, blocked_reason TEXT, summary TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task', questions TEXT, release TEXT NOT NULL DEFAULT 'none'
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, session_id TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL, context_tokens INTEGER, context_window INTEGER, model TEXT, session_total_usd REAL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, task_id TEXT NOT NULL,
  kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events (task_id, id);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cron TEXT, enabled INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT, next_run_at TEXT, last_skip_reason TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, output_path TEXT, meta TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, endpoint TEXT NOT NULL UNIQUE, keys TEXT NOT NULL,
  created_at TEXT NOT NULL, last_error TEXT
);
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, source TEXT NOT NULL, taken_at TEXT NOT NULL,
  ok INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}', error TEXT
);
CREATE INDEX IF NOT EXISTS metric_snapshots_lookup ON metric_snapshots (project_id, source, taken_at);
CREATE TABLE IF NOT EXISTS daily_downloads (
  project_id TEXT NOT NULL, day TEXT NOT NULL, country TEXT NOT NULL, units INTEGER NOT NULL,
  PRIMARY KEY (project_id, day, country)
);
CREATE TABLE IF NOT EXISTS config_overrides (
  kind TEXT NOT NULL, id TEXT NOT NULL, origin TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, device_id TEXT,
  PRIMARY KEY (kind, id)
);
`;

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

const TASK_COLUMNS: Record<keyof TaskPatch, string> = {
  title: 'title', description: 'description', level: 'level', branch: 'branch', worktreePath: 'worktree_path',
  sessionId: 'session_id', sessionStarted: 'session_started', nextPrompt: 'next_prompt', blockedReason: 'blocked_reason', summary: 'summary',
  attempts: 'attempts', questions: 'questions', release: 'release',
};

const toTask = (r: Row): Task => ({
  id: r.id as string,
  projectId: r.project_id as string,
  title: r.title as string,
  description: r.description as string,
  profileId: r.profile_id as string,
  state: r.state as TaskState,
  level: r.level as Level,
  parentId: (r.parent_id as string | null) ?? null,
  routineId: (r.routine_id as string | null) ?? null,
  branch: (r.branch as string | null) ?? null,
  worktreePath: (r.worktree_path as string | null) ?? null,
  sessionId: (r.session_id as string | null) ?? null,
  sessionStarted: r.session_started === 1,
  kind: ((r.kind as string | null) ?? 'task') as TaskKind,
  questions: r.questions ? (JSON.parse(r.questions as string) as Question[]) : null,
  release: ((r.release as string | null) ?? 'none') as Release,
  nextPrompt: (r.next_prompt as string | null) ?? null,
  blockedReason: (r.blocked_reason as string | null) ?? null,
  summary: (r.summary as string | null) ?? null,
  attempts: r.attempts as number,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toRun = (r: Row): Run => ({
  id: r.id as number,
  taskId: r.task_id as string,
  sessionId: r.session_id as string,
  startedAt: r.started_at as string,
  endedAt: (r.ended_at as string | null) ?? null,
  outcome: (r.outcome as RunOutcome | null) ?? null,
  inputTokens: r.input_tokens as number,
  outputTokens: r.output_tokens as number,
  costUsd: (r.cost_usd as number | null) ?? null,
  sessionTotalUsd: (r.session_total_usd as number | null) ?? null,
  contextTokens: (r.context_tokens as number | null) ?? null,
  contextWindow: (r.context_window as number | null) ?? null,
  model: (r.model as string | null) ?? null,
});

const toEvent = (r: Row): EventRow => ({
  id: r.id as number,
  runId: r.run_id as number,
  taskId: r.task_id as string,
  kind: r.kind as EventKind,
  payload: JSON.parse(r.payload as string),
  createdAt: r.created_at as string,
});

const toArtifact = (r: Row): Artifact => ({
  id: r.id as number, taskId: r.task_id as string, kind: r.kind as ArtifactKind,
  path: r.path as string, label: r.label as string,
});

const toApproval = (r: Row): Approval => ({
  id: r.id as number, taskId: r.task_id as string, action: r.action as FinalAction,
  state: r.state as ApprovalState, decidedAt: (r.decided_at as string | null) ?? null,
});

const toComment = (r: Row): Comment => ({
  id: r.id as number, taskId: r.task_id as string, author: r.author as CommentAuthor,
  body: r.body as string, createdAt: r.created_at as string, deliveredAt: (r.delivered_at as string | null) ?? null,
});

const toRoutine = (r: Row): RoutineRow => ({
  id: r.id as string, projectId: r.project_id as string, cron: (r.cron as string | null) ?? null, enabled: r.enabled === 1,
  lastRunAt: (r.last_run_at as string | null) ?? null, nextRunAt: (r.next_run_at as string | null) ?? null,
  lastSkipReason: (r.last_skip_reason as string | null) ?? null,
});

const toJob = (r: Row): Job => ({
  id: r.id as number, taskId: r.task_id as string, kind: r.kind as JobKind, state: r.state as JobState,
  startedAt: r.started_at as string, endedAt: (r.ended_at as string | null) ?? null,
  outputPath: (r.output_path as string | null) ?? null, meta: JSON.parse((r.meta as string) || '{}'),
});

const toDevice = (r: Row): Device => ({
  id: r.id as string, name: r.name as string, createdAt: r.created_at as string, lastSeenAt: (r.last_seen_at as string | null) ?? null,
});

/** Compara dos hashes hex sin filtrar por tiempo dónde difieren. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}


export class Store {
  readonly db: Database.Database;
  readonly aso: AsoRepo;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
    this.aso = new AsoRepo(this.db);
  }

  /** Migraciones aditivas de bases de datos creadas por versiones anteriores. */
  private migrate(): void {
    const columns = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const tasks = columns('tasks');
    if (!tasks.includes('session_started')) this.db.exec('ALTER TABLE tasks ADD COLUMN session_started INTEGER NOT NULL DEFAULT 0');
    if (!tasks.includes('kind')) this.db.exec("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'");
    if (!tasks.includes('questions')) this.db.exec('ALTER TABLE tasks ADD COLUMN questions TEXT');
    if (!tasks.includes('release')) this.db.exec("ALTER TABLE tasks ADD COLUMN release TEXT NOT NULL DEFAULT 'none'");
    const runs = columns('runs');
    if (!runs.includes('cost_usd')) this.db.exec('ALTER TABLE runs ADD COLUMN cost_usd REAL');
    if (!runs.includes('context_tokens')) this.db.exec('ALTER TABLE runs ADD COLUMN context_tokens INTEGER');
    if (!runs.includes('context_window')) this.db.exec('ALTER TABLE runs ADD COLUMN context_window INTEGER');
    if (!runs.includes('model')) this.db.exec('ALTER TABLE runs ADD COLUMN model TEXT');
    if (!runs.includes('session_total_usd')) this.db.exec('ALTER TABLE runs ADD COLUMN session_total_usd REAL');
    if (!columns('comments').includes('delivered_at')) {
      this.db.transaction(() => {
        this.db.exec('ALTER TABLE comments ADD COLUMN delivered_at TEXT');
        // Los comentarios de antes de la fase 2 ya llegaron al agente por nextPrompt.
        this.db.exec('UPDATE comments SET delivered_at = created_at');
      })();
    }
    // El código de emparejamiento vive solo en memoria (Auth): un agente que lea la base no puede recuperarlo.
    this.db.exec('DROP TABLE IF EXISTS pairing_codes');
  }

  // --- métricas ---

  addSnapshot(projectId: string, source: SourceId, ok: boolean, data: Snapshot['data'], error: string | null, at: Date = new Date()): Snapshot {
    const takenAt = at.toISOString();
    const info = this.db.prepare('INSERT INTO metric_snapshots (project_id, source, taken_at, ok, data, error) VALUES (?, ?, ?, ?, ?, ?)')
      .run(projectId, source, takenAt, ok ? 1 : 0, JSON.stringify(data), error);
    return { id: Number(info.lastInsertRowid), projectId, source, takenAt, ok, data, error };
  }

  private toSnapshot(r: Row): Snapshot {
    return {
      id: r.id as number, projectId: r.project_id as string, source: r.source as SourceId, takenAt: r.taken_at as string,
      ok: r.ok === 1, data: JSON.parse(r.data as string) as Snapshot['data'], error: (r.error as string | null) ?? null,
    };
  }

  latestSnapshot(projectId: string, source: SourceId, okOnly: boolean): Snapshot | null {
    const r = this.db.prepare(
      `SELECT * FROM metric_snapshots WHERE project_id = ? AND source = ? ${okOnly ? 'AND ok = 1' : ''} ORDER BY taken_at DESC, id DESC LIMIT 1`,
    ).get(projectId, source) as Row | undefined;
    return r ? this.toSnapshot(r) : null;
  }

  /** La foto correcta (ok) más cercana en el tiempo a `at`. */
  snapshotNear(projectId: string, source: SourceId, at: Date): Snapshot | null {
    const rows = this.db.prepare('SELECT * FROM metric_snapshots WHERE project_id = ? AND source = ? AND ok = 1').all(projectId, source) as Row[];
    let best: Row | null = null;
    let bestDist = Infinity;
    for (const r of rows) {
      const dist = Math.abs(Date.parse(r.taken_at as string) - at.getTime());
      if (dist < bestDist) { best = r; bestDist = dist; }
    }
    return best ? this.toSnapshot(best) : null;
  }

  /** Fotos correctas (ok) desde `fromIso`, de la más antigua a la más reciente. */
  snapshotsSince(projectId: string, source: SourceId, fromIso: string): Snapshot[] {
    return (this.db.prepare('SELECT * FROM metric_snapshots WHERE project_id = ? AND source = ? AND ok = 1 AND taken_at >= ? ORDER BY taken_at, id')
      .all(projectId, source, fromIso) as Row[]).map((r) => this.toSnapshot(r));
  }

  listSnapshots(projectId: string, source: SourceId, limit: number): Snapshot[] {
    return (this.db.prepare('SELECT * FROM metric_snapshots WHERE project_id = ? AND source = ? ORDER BY taken_at DESC, id DESC LIMIT ?')
      .all(projectId, source, limit) as Row[]).map((r) => this.toSnapshot(r));
  }

  /**
   * Sustituye por completo las descargas de ese día de informe. Con `rows` vacío guarda una fila `country ''` con 0 unidades,
   * para que el día cuente como conocido (día sin ventas); al sumar unidades esa fila no afecta, y quien agrupe por país la ignora.
   */
  upsertDailyDownloads(projectId: string, day: string, rows: { country: string; units: number }[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM daily_downloads WHERE project_id = ? AND day = ?').run(projectId, day);
      const ins = this.db.prepare('INSERT INTO daily_downloads (project_id, day, country, units) VALUES (?, ?, ?, ?)');
      for (const r of rows.length ? rows : [{ country: '', units: 0 }]) ins.run(projectId, day, r.country, r.units);
    })();
  }

  downloadDays(projectId: string, fromDay: string): Set<string> {
    const rows = this.db.prepare('SELECT DISTINCT day FROM daily_downloads WHERE project_id = ? AND day >= ?').all(projectId, fromDay) as Row[];
    return new Set(rows.map((r) => r.day as string));
  }

  dailyDownloads(projectId: string, fromDay: string, toDay: string): { day: string; country: string; units: number }[] {
    return (this.db.prepare('SELECT day, country, units FROM daily_downloads WHERE project_id = ? AND day >= ? AND day <= ? ORDER BY day, country')
      .all(projectId, fromDay, toDay) as Row[]).map((r) => ({ day: r.day as string, country: r.country as string, units: r.units as number }));
  }

  close(): void {
    this.db.close();
  }

  // --- tareas ---

  createTask(project: ProjectConfig, input: NewTaskInput): Task {
    return this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO counters (project_id, next) VALUES (?, ?)').run(project.id, project.startNumber ?? 1);
      const { next } = this.db.prepare('SELECT next FROM counters WHERE project_id = ?').get(project.id) as { next: number };
      this.db.prepare('UPDATE counters SET next = next + 1 WHERE project_id = ?').run(project.id);
      const id = `${project.prefix}-${next}`;
      const t = now();
      this.db.prepare(
        `INSERT INTO tasks (id, project_id, title, description, profile_id, state, level, parent_id, routine_id, attempts, created_at, updated_at, kind, release)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(id, project.id, input.title, input.description, input.profileId, input.level,
        input.parentId ?? null, input.routineId ?? null, t, t, input.kind ?? 'task', input.release ?? 'none');
      return this.getTask(id);
    })();
  }

  findTask(id: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? toTask(r) : null;
  }

  getTask(id: string): Task {
    const t = this.findTask(id);
    if (!t) throw new NotFoundError(`La tarea ${id} no existe`);
    return t;
  }

  listTasks(states?: TaskState[], page?: { limit: number; offset: number; newestFirst?: boolean }): Task[] {
    const where = states && states.length ? `WHERE state IN (${states.map(() => '?').join(',')})` : '';
    const params: unknown[] = states && states.length ? [...states] : [];
    let sql = `SELECT * FROM tasks ${where} ORDER BY rowid${page?.newestFirst ? ' DESC' : ''}`;
    if (page) { sql += ' LIMIT ? OFFSET ?'; params.push(page.limit, page.offset); }
    return (this.db.prepare(sql).all(...params) as Row[]).map(toTask);
  }

  updateTask(id: string, patch: TaskPatch): Task {
    this.getTask(id);
    const entries = (Object.entries(patch) as [keyof TaskPatch, unknown][]).filter(([, v]) => v !== undefined);
    if (entries.length) {
      const sets = entries.map(([k]) => `${TASK_COLUMNS[k]} = ?`).join(', ');
      const values = entries.map(([k, v]) =>
        k === 'questions' ? (v === null ? null : JSON.stringify(v)) : typeof v === 'boolean' ? Number(v) : v);
      this.db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
    }
    return this.getTask(id);
  }

  setState(id: string, to: TaskState, patch: TaskPatch = {}): Task {
    const current = this.getTask(id);
    assertTransition(current.state, to);
    this.db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run(to, now(), id);
    // Las preguntas solo tienen sentido mientras la tarea está bloqueada.
    const p = to === 'blocked' || 'questions' in patch ? patch : { ...patch, questions: null };
    return this.updateTask(id, p);
  }

  listChildren(parentId: string): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY rowid').all(parentId) as Row[]).map(toTask);
  }

  listTasksByRoutine(routineId: string, limit: number): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE routine_id = ? ORDER BY rowid DESC LIMIT ?').all(routineId, limit) as Row[]).map(toTask);
  }

  // --- ejecuciones ---

  startRun(taskId: string, sessionId: string): Run {
    const info = this.db.prepare('INSERT INTO runs (task_id, session_id, started_at) VALUES (?, ?, ?)').run(taskId, sessionId, now());
    return this.getRun(Number(info.lastInsertRowid));
  }

  getRun(id: number): Run {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFoundError(`La ejecución ${id} no existe`);
    return toRun(r);
  }

  finishRun(
    runId: number, outcome: RunOutcome,
    usage: { input: number; output: number; costUsd?: number | null; sessionTotalUsd?: number | null; contextWindow?: number | null },
  ): Run {
    // COALESCE: el contexto y la ventana ya pueden venir de setRunContext; no se pisan con nulos.
    this.db.prepare(`UPDATE runs SET ended_at = ?, outcome = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?,
      session_total_usd = ?, context_window = COALESCE(?, context_window) WHERE id = ?`)
      .run(now(), outcome, usage.input, usage.output, usage.costUsd ?? null, usage.sessionTotalUsd ?? null,
        usage.contextWindow ?? null, runId);
    return this.getRun(runId);
  }

  /**
   * Coste propio de una ejecución a partir del total acumulado de la sesión (`total_cost_usd`):
   * total menos el último total guardado de la misma tarea y sesión. Si la sesión ya tenía ejecuciones
   * pero ninguna guardó su total (p. ej. anteriores a esta columna), el coste propio es desconocido → null.
   * La primera ejecución de la sesión se lleva el total entero. Nunca negativo.
   */
  runCostDelta(runId: number, total: number): number | null {
    const prev = this.db.prepare(`SELECT p.session_total_usd AS t FROM runs p JOIN runs r ON r.id = ?
      WHERE p.task_id = r.task_id AND p.session_id = r.session_id AND p.id < r.id AND p.session_total_usd IS NOT NULL
      ORDER BY p.id DESC LIMIT 1`).get(runId) as { t: number } | undefined;
    if (prev) return Math.max(0, total - prev.t);
    const earlier = this.db.prepare(`SELECT 1 FROM runs p JOIN runs r ON r.id = ?
      WHERE p.task_id = r.task_id AND p.session_id = r.session_id AND p.id < r.id LIMIT 1`).get(runId);
    return earlier ? null : Math.max(0, total);
  }

  setRunModel(runId: number, model: string | null): void {
    this.db.prepare('UPDATE runs SET model = ? WHERE id = ?').run(model, runId);
  }

  setRunContext(runId: number, contextTokens: number): void {
    this.db.prepare('UPDATE runs SET context_tokens = ? WHERE id = ?').run(contextTokens, runId);
  }

  /** Coste, contexto y último mensaje de cada tarea, con dos consultas agrupadas. */
  taskStats(taskIds: string[], defaultWindow: (taskId: string) => number): Record<string, TaskStats> {
    const out: Record<string, TaskStats> = {};
    if (!taskIds.length) return out;
    const marks = taskIds.map(() => '?').join(',');
    const runs = this.db.prepare(
      `SELECT task_id, ended_at, cost_usd, context_tokens, context_window, model FROM runs WHERE task_id IN (${marks}) ORDER BY id`,
    ).all(...taskIds) as Row[];
    const msgs = this.db.prepare(
      `SELECT task_id, payload FROM events WHERE id IN (
         SELECT MAX(id) FROM events WHERE kind = 'message' AND task_id IN (${marks}) GROUP BY task_id)`,
    ).all(...taskIds) as Row[];
    const last: Record<string, string> = {};
    for (const m of msgs) {
      const text = (JSON.parse(m.payload as string) as { text?: unknown } | null)?.text;
      if (typeof text === 'string') last[m.task_id as string] = text.split('\n')[0].slice(0, 140);
    }
    for (const id of taskIds) {
      out[id] = {
        costUsd: null, costPartial: false, contextTokens: null, contextWindow: defaultWindow(id),
        turns: 0, model: null, lastMessage: last[id] ?? null,
      };
    }
    for (const r of runs) { // en orden de id: las últimas filas con dato pisan a las anteriores
      const st = out[r.task_id as string];
      st.turns += 1;
      if (r.cost_usd != null) st.costUsd = (st.costUsd ?? 0) + (r.cost_usd as number);
      else if (r.ended_at != null) st.costPartial = true;
      if (r.context_tokens != null) st.contextTokens = r.context_tokens as number;
      if (r.context_window != null) { st.contextWindow = r.context_window as number; }
      if (r.model != null) st.model = r.model as string;
    }
    return out;
  }

  /** Gasto equivalente: hoy (desde las 00:00 locales) y últimos 7 días naturales incluido hoy. */
  spend(nowDate: Date): Spend {
    const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
    const startOfWeek = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 6);
    const sum = (from: Date) => (this.db.prepare(
      'SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE cost_usd IS NOT NULL AND started_at >= ?',
    ).get(from.toISOString()) as { s: number }).s;
    return { today: sum(startOfToday), week: sum(startOfWeek) };
  }

  // Las consultas de gasto van juntas: si se suma otra fuente de coste, se añade aquí a las tres.

  /** Gasto equivalente por día local desde `fromIso`; solo los días con gasto, en orden. */
  spendByDay(fromIso: string): { day: string; usd: number }[] {
    return (this.db.prepare(`SELECT date(started_at, 'localtime') AS day, SUM(cost_usd) AS usd FROM runs
      WHERE cost_usd IS NOT NULL AND started_at >= ? GROUP BY day ORDER BY day`).all(fromIso) as Row[])
      .map((r) => ({ day: r.day as string, usd: r.usd as number }));
  }

  /** Gasto equivalente desde `fromIso` por rutina o por perfil de la tarea, del más caro al más barato; por rutina no cuentan las tareas sin rutina. */
  spendBy(field: 'routine' | 'profile', fromIso: string): { key: string; usd: number; runs: number }[] {
    const col = field === 'routine' ? 't.routine_id' : 't.profile_id';
    return (this.db.prepare(`SELECT ${col} AS k, SUM(r.cost_usd) AS usd, COUNT(*) AS n FROM runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.cost_usd IS NOT NULL AND r.started_at >= ? AND ${col} IS NOT NULL GROUP BY k ORDER BY usd DESC, k`).all(fromIso) as Row[])
      .map((r) => ({ key: r.k as string, usd: r.usd as number, runs: r.n as number }));
  }

  /** Ejecuciones de agentes empezadas desde `fromIso` (con o sin coste conocido). */
  runCount(fromIso: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE started_at >= ?').get(fromIso) as { n: number }).n;
  }

  /**
   * Última ejecución terminada de cada tarea de rutina del proyecto, si empezó desde `fromIso`; en orden de ejecución.
   * `reason` es el motivo de bloqueo de la tarea, si lo tiene.
   */
  routineRuns(projectId: string, fromIso: string): { taskId: string; routineId: string; outcome: RunOutcome; endedAt: string; reason: string | null }[] {
    return (this.db.prepare(`SELECT t.id, t.routine_id, t.blocked_reason, r.outcome, r.ended_at FROM runs r JOIN tasks t ON t.id = r.task_id
      WHERE t.project_id = ? AND t.routine_id IS NOT NULL AND r.started_at >= ?
        AND r.id = (SELECT MAX(id) FROM runs x WHERE x.task_id = t.id AND x.ended_at IS NOT NULL)
      ORDER BY r.id`).all(projectId, fromIso) as Row[]).map((r) => ({
      taskId: r.id as string, routineId: r.routine_id as string, outcome: r.outcome as RunOutcome,
      endedAt: r.ended_at as string, reason: (r.blocked_reason as string | null) ?? null,
    }));
  }

  listRuns(taskId: string): Run[] {
    return (this.db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY id').all(taskId) as Row[]).map(toRun);
  }

  /** ¿La ejecución registró el evento de inicio de sesión (`system`/init)? */
  runSawInit(runId: number): boolean {
    return this.db.prepare("SELECT 1 FROM events WHERE run_id = ? AND kind = 'system' LIMIT 1").get(runId) !== undefined;
  }

  openRuns(): Run[] {
    return (this.db.prepare('SELECT * FROM runs WHERE ended_at IS NULL ORDER BY id').all() as Row[]).map(toRun);
  }

  // --- eventos ---

  addEvent(runId: number, taskId: string, kind: EventKind, payload: unknown): EventRow {
    const info = this.db.prepare('INSERT INTO events (run_id, task_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(runId, taskId, kind, JSON.stringify(payload ?? null), now());
    return toEvent(this.db.prepare('SELECT * FROM events WHERE id = ?').get(Number(info.lastInsertRowid)) as Row);
  }

  listEvents(taskId: string, afterId = 0): EventRow[] {
    return (this.db.prepare('SELECT * FROM events WHERE task_id = ? AND id > ? ORDER BY id LIMIT 5000').all(taskId, afterId) as Row[]).map(toEvent);
  }

  // --- artefactos ---

  addArtifact(taskId: string, kind: ArtifactKind, path: string, label: string): Artifact {
    const info = this.db.prepare('INSERT INTO artifacts (task_id, kind, path, label) VALUES (?, ?, ?, ?)').run(taskId, kind, path, label);
    return this.getArtifact(Number(info.lastInsertRowid));
  }

  getArtifact(id: number): Artifact {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFoundError(`El artefacto ${id} no existe`);
    return toArtifact(r);
  }

  listArtifacts(taskId: string): Artifact[] {
    return (this.db.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY id').all(taskId) as Row[]).map(toArtifact);
  }

  clearArtifacts(taskId: string): void {
    this.db.prepare('DELETE FROM artifacts WHERE task_id = ?').run(taskId);
  }

  // --- aprobaciones ---

  addApproval(taskId: string, action: FinalAction, state: ApprovalState): Approval {
    const info = this.db.prepare('INSERT INTO approvals (task_id, action, state, decided_at) VALUES (?, ?, ?, ?)')
      .run(taskId, action, state, state === 'pending' ? null : now());
    return toApproval(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(Number(info.lastInsertRowid)) as Row);
  }

  listApprovals(taskId: string): Approval[] {
    return (this.db.prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY id').all(taskId) as Row[]).map(toApproval);
  }

  /** Aprobaciones pendientes de `action` de todas las tareas de un proyecto, de la más antigua a la más nueva. */
  listPendingApprovals(projectId: string, action: FinalAction): Approval[] {
    return (this.db.prepare(
      `SELECT a.* FROM approvals a JOIN tasks t ON t.id = a.task_id
       WHERE t.project_id = ? AND a.action = ? AND a.state = 'pending' ORDER BY a.id`,
    ).all(projectId, action) as Row[]).map(toApproval);
  }

  decideApproval(id: number, state: ApprovalState): Approval {
    this.db.prepare('UPDATE approvals SET state = ?, decided_at = ? WHERE id = ?').run(state, now(), id);
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFoundError(`La aprobación ${id} no existe`);
    return toApproval(r);
  }

  // --- comentarios ---

  addComment(taskId: string, author: CommentAuthor, body: string, opts: { pending?: boolean } = {}): Comment {
    const t = now();
    const info = this.db.prepare('INSERT INTO comments (task_id, author, body, created_at, delivered_at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, author, body, t, opts.pending ? null : t);
    return toComment(this.db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(info.lastInsertRowid)) as Row);
  }

  listComments(taskId: string): Comment[] {
    return (this.db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY id').all(taskId) as Row[]).map(toComment);
  }

  /** Comentarios (del usuario y avisos de Faro) que el agente aún no ha recibido, en orden. */
  listUndelivered(taskId: string): Comment[] {
    return (this.db.prepare("SELECT * FROM comments WHERE task_id = ? AND delivered_at IS NULL AND author IN ('user', 'faro') ORDER BY id")
      .all(taskId) as Row[]).map(toComment);
  }

  markDelivered(ids: number[]): void {
    const st = this.db.prepare('UPDATE comments SET delivered_at = ? WHERE id = ?');
    const t = now();
    this.db.transaction(() => { for (const id of ids) st.run(t, id); })();
  }

  markUndelivered(ids: number[]): void {
    const st = this.db.prepare('UPDATE comments SET delivered_at = NULL WHERE id = ?');
    this.db.transaction(() => { for (const id of ids) st.run(id); })();
  }

  /** Devuelve a pendientes los mensajes (del usuario y de Faro) entregados desde `iso` (inicio de una ejecución). */
  markUndeliveredSince(taskId: string, iso: string): void {
    this.db.prepare("UPDATE comments SET delivered_at = NULL WHERE task_id = ? AND author IN ('user', 'faro') AND delivered_at >= ?")
      .run(taskId, iso);
  }

  hasPendingUserMessages(taskId: string): boolean {
    return this.db.prepare("SELECT 1 FROM comments WHERE task_id = ? AND author = 'user' AND delivered_at IS NULL LIMIT 1").get(taskId) !== undefined;
  }

  // --- overrides de config (panel) ---

  /** Overrides en el orden en que se guardaron (el más antiguo primero). */
  listOverrides(): OverrideRow[] {
    return (this.db.prepare('SELECT * FROM config_overrides ORDER BY updated_at, rowid').all() as Row[]).map((r) => ({
      kind: r.kind as OverrideKind,
      id: r.id as string,
      origin: r.origin as OverrideRow['origin'],
      data: JSON.parse(r.data as string) as Record<string, unknown>,
      updatedAt: r.updated_at as string,
      deviceId: (r.device_id as string | null) ?? null,
    }));
  }

  setOverride(o: OverrideRow): void {
    this.db.prepare(`INSERT INTO config_overrides (kind, id, origin, data, updated_at, device_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (kind, id) DO UPDATE SET origin = excluded.origin, data = excluded.data, updated_at = excluded.updated_at, device_id = excluded.device_id`)
      .run(o.kind, o.id, o.origin, JSON.stringify(o.data), o.updatedAt, o.deviceId);
  }

  deleteOverride(kind: OverrideKind, id: string): void {
    this.db.prepare('DELETE FROM config_overrides WHERE kind = ? AND id = ?').run(kind, id);
  }

  // --- rutinas ---

  /** Alta de una rutina de la config. Si ya existía, conserva su estado salvo que haya cambiado el cron. */
  upsertRoutine(id: string, projectId: string, cron: string | null, initialNext: string | null): RoutineRow {
    const cur = this.getRoutine(id);
    if (!cur) {
      this.db.prepare('INSERT INTO routines (id, project_id, cron, enabled, next_run_at) VALUES (?, ?, ?, 0, ?)').run(id, projectId, cron, initialNext);
    } else if (cur.cron !== cron) {
      this.db.prepare('UPDATE routines SET project_id = ?, cron = ?, next_run_at = ? WHERE id = ?').run(projectId, cron, initialNext, id);
    } else {
      this.db.prepare('UPDATE routines SET project_id = ? WHERE id = ?').run(projectId, id);
    }
    return this.getRoutine(id)!;
  }

  deleteRoutinesExcept(ids: string[]): void {
    const keep = new Set(ids);
    for (const r of this.listRoutines()) if (!keep.has(r.id)) this.db.prepare('DELETE FROM routines WHERE id = ?').run(r.id);
  }

  listRoutines(): RoutineRow[] {
    return (this.db.prepare('SELECT * FROM routines ORDER BY id').all() as Row[]).map(toRoutine);
  }

  getRoutine(id: string): RoutineRow | null {
    const r = this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as Row | undefined;
    return r ? toRoutine(r) : null;
  }

  updateRoutine(id: string, patch: Partial<Pick<RoutineRow, 'enabled' | 'lastRunAt' | 'nextRunAt' | 'lastSkipReason'>>): RoutineRow {
    const cols: Record<string, string> = { enabled: 'enabled', lastRunAt: 'last_run_at', nextRunAt: 'next_run_at', lastSkipReason: 'last_skip_reason' };
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length) {
      this.db.prepare(`UPDATE routines SET ${entries.map(([k]) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`)
        .run(...entries.map(([, v]) => (typeof v === 'boolean' ? Number(v) : v)), id);
    }
    const r = this.getRoutine(id);
    if (!r) throw new NotFoundError(`La rutina ${id} no existe`);
    return r;
  }

  // --- jobs de lanzamiento ---

  createJob(taskId: string, kind: JobKind): Job {
    const info = this.db.prepare("INSERT INTO jobs (task_id, kind, state, started_at) VALUES (?, ?, 'running', ?)").run(taskId, kind, now());
    return this.getJob(Number(info.lastInsertRowid));
  }

  finishJob(id: number, state: JobState, extra: { meta?: Job['meta']; outputPath?: string } = {}): Job {
    const cur = this.getJob(id);
    this.db.prepare('UPDATE jobs SET state = ?, ended_at = ?, meta = ?, output_path = ? WHERE id = ?')
      .run(state, now(), JSON.stringify({ ...cur.meta, ...extra.meta }), extra.outputPath ?? cur.outputPath, id);
    return this.getJob(id);
  }

  setJobMeta(id: number, meta: Job['meta']): void {
    const cur = this.getJob(id);
    this.db.prepare('UPDATE jobs SET meta = ? WHERE id = ?').run(JSON.stringify({ ...cur.meta, ...meta }), id);
  }

  getJob(id: number): Job {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFoundError(`El lanzamiento ${id} no existe`);
    return toJob(r);
  }

  listJobs(taskId: string): Job[] {
    return (this.db.prepare('SELECT * FROM jobs WHERE task_id = ? ORDER BY id').all(taskId) as Row[]).map(toJob);
  }

  runningJobs(): Job[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE state = 'running' ORDER BY id").all() as Row[]).map(toJob);
  }

  // --- dispositivos y emparejamiento ---

  createDevice(name: string, tokenHash: string, at: string = now()): Device {
    const id = randomUUID();
    this.db.prepare('INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').run(id, name, tokenHash, at);
    return toDevice(this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Row);
  }

  /** El dispositivo si existe y su hash coincide (comparación en tiempo constante); si no, null. */
  findDeviceByTokenHash(id: string, hash: string): Device | null {
    const r = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Row | undefined;
    if (!r || !sameHash(r.token_hash as string, hash)) return null;
    return toDevice(r);
  }

  touchDevice(id: string, at: string = now()): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(at, id);
  }

  listDevices(): Device[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY created_at, id').all() as Row[]).map(toDevice);
  }

  /** Borra el dispositivo y sus suscripciones push. */
  deleteDevice(id: string): void {
    this.db.transaction(() => {
      const info = this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
      if (info.changes === 0) throw new NotFoundError(`El dispositivo ${id} no existe`);
      this.db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(id);
    })();
  }

  // --- suscripciones push ---

  upsertPushSubscription(deviceId: string | null, endpoint: string, keys: PushKeys): void {
    this.db.prepare(
      `INSERT INTO push_subscriptions (device_id, endpoint, keys, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, keys = excluded.keys, last_error = NULL`,
    ).run(deviceId, endpoint, JSON.stringify(keys), now());
  }

  deletePushSubscription(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  listPushSubscriptions(): PushSubscriptionRow[] {
    return (this.db.prepare('SELECT * FROM push_subscriptions ORDER BY id').all() as Row[]).map((r) => ({
      id: Number(r.id), deviceId: (r.device_id as string | null) ?? null, endpoint: String(r.endpoint),
      keys: JSON.parse(String(r.keys)) as PushKeys, createdAt: String(r.created_at), lastError: (r.last_error as string | null) ?? null,
    }));
  }

  setPushError(endpoint: string, error: string | null): void {
    this.db.prepare('UPDATE push_subscriptions SET last_error = ? WHERE endpoint = ?').run(error, endpoint);
  }

  // --- meta ---

  getMeta<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : null;
  }

  setMeta(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }
}
