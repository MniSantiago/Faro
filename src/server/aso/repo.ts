import type Database from 'better-sqlite3';
import { normalizeKeyword, type CurrentFicha } from './ficha';

export interface AsoKeyword {
  id: number; projectId: string; storeId: string; text: string; source: 'user' | 'agent'; createdAt: string; archived: boolean;
}
export interface AsoObservation {
  keywordId: number; takenAt: string; ok: boolean; popularity: number | null; difficulty: number | null; rank: number | null; error: string | null;
}
export interface AsoCompetitor { id: number; projectId: string; appId: string; name: string; archived: boolean }
export interface AsoCompetitorSnap {
  competitorId: number; storeId: string; takenAt: string; name: string; subtitle: string | null; version: string | null;
}
export interface AsoProposal {
  id: number; projectId: string; storeId: string | null; kind: 'follow' | 'unfollow' | 'competitor' | 'ficha';
  payload: Record<string, unknown>; why: string; taskId: string | null;
  /** `superseded`: ficha pendiente que otra más nueva de la misma tienda sustituyó (no la rechazó el usuario). */
  state: 'pending' | 'accepted' | 'rejected' | 'superseded'; createdAt: string;
}
export interface AsoCandidate { projectId: string; storeId: string; text: string; firstSeen: string }
export interface AsoLastRun { at: string; ok: boolean; error: string | null }
export interface AsoStoredFicha { takenAt: string; ficha: CurrentFicha }

const pad = (n: number) => String(n).padStart(2, '0');
/** Día natural (AAAA-MM-DD) de un instante en la zona horaria de la máquina. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS aso_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, store_id TEXT NOT NULL, text TEXT NOT NULL,
  source TEXT NOT NULL, created_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, store_id, text)
);
CREATE TABLE IF NOT EXISTS aso_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, keyword_id INTEGER NOT NULL, taken_at TEXT NOT NULL, ok INTEGER NOT NULL,
  popularity REAL, difficulty REAL, rank INTEGER, error TEXT
);
CREATE INDEX IF NOT EXISTS aso_observations_lookup ON aso_observations (keyword_id, taken_at);
CREATE TABLE IF NOT EXISTS aso_competitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, app_id TEXT NOT NULL, name TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, UNIQUE (project_id, app_id)
);
CREATE TABLE IF NOT EXISTS aso_competitor_snaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, competitor_id INTEGER NOT NULL, store_id TEXT NOT NULL, taken_at TEXT NOT NULL,
  name TEXT NOT NULL, subtitle TEXT, version TEXT
);
CREATE INDEX IF NOT EXISTS aso_competitor_snaps_lookup ON aso_competitor_snaps (competitor_id, store_id, taken_at);
CREATE TABLE IF NOT EXISTS aso_candidates (
  project_id TEXT NOT NULL, store_id TEXT NOT NULL, text TEXT NOT NULL, first_seen TEXT NOT NULL,
  PRIMARY KEY (project_id, store_id, text)
);
CREATE TABLE IF NOT EXISTS aso_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, store_id TEXT, kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}', why TEXT NOT NULL, task_id TEXT, state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS aso_proposals_lookup ON aso_proposals (project_id, state);
`;

/** Error de decideProposal: la propuesta no existe o ya estaba decidida. */
export class AsoProposalError extends Error {
  constructor(message: string, readonly reason: 'not_found' | 'decided' | 'invalid') {
    super(message);
  }
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

const toKeyword = (r: Row): AsoKeyword => ({
  id: r.id as number, projectId: r.project_id as string, storeId: r.store_id as string, text: r.text as string,
  source: r.source as AsoKeyword['source'], createdAt: r.created_at as string, archived: r.archived === 1,
});
const toObservation = (r: Row): AsoObservation => ({
  keywordId: r.keyword_id as number, takenAt: r.taken_at as string, ok: r.ok === 1,
  popularity: (r.popularity as number | null) ?? null, difficulty: (r.difficulty as number | null) ?? null,
  rank: (r.rank as number | null) ?? null, error: (r.error as string | null) ?? null,
});
const toCompetitor = (r: Row): AsoCompetitor => ({
  id: r.id as number, projectId: r.project_id as string, appId: r.app_id as string, name: r.name as string, archived: r.archived === 1,
});
const toSnap = (r: Row): AsoCompetitorSnap => ({
  competitorId: r.competitor_id as number, storeId: r.store_id as string, takenAt: r.taken_at as string, name: r.name as string,
  subtitle: (r.subtitle as string | null) ?? null, version: (r.version as string | null) ?? null,
});
const toProposal = (r: Row): AsoProposal => ({
  id: r.id as number, projectId: r.project_id as string, storeId: (r.store_id as string | null) ?? null,
  kind: r.kind as AsoProposal['kind'], payload: JSON.parse(r.payload as string) as Record<string, unknown>,
  why: r.why as string, taskId: (r.task_id as string | null) ?? null, state: r.state as AsoProposal['state'], createdAt: r.created_at as string,
});
const toCandidate = (r: Row): AsoCandidate => ({
  projectId: r.project_id as string, storeId: r.store_id as string, text: r.text as string, firstSeen: r.first_seen as string,
});

/** Clave de comparación de una propuesta: keyword normalizada o appId; null si no aplica (ficha). */
function proposalKey(kind: AsoProposal['kind'], payload: Record<string, unknown>): string | null {
  if (kind === 'follow' || kind === 'unfollow') return normalizeKeyword(String(payload.keyword ?? ''));
  if (kind === 'competitor') return String(payload.appId ?? '');
  return null;
}

export class AsoRepo {
  /** `db` debe tener ya la tabla `meta` (la crea Store antes de construir el repo). */
  constructor(private readonly db: Database.Database) {
    this.db.exec(SCHEMA);
  }

  // --- keywords ---

  addKeyword(projectId: string, storeId: string, text: string, source: AsoKeyword['source']): AsoKeyword {
    const norm = normalizeKeyword(text);
    this.db.prepare('INSERT OR IGNORE INTO aso_keywords (project_id, store_id, text, source, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, storeId, norm, source, now());
    this.db.prepare('UPDATE aso_keywords SET archived = 0 WHERE project_id = ? AND store_id = ? AND text = ?').run(projectId, storeId, norm);
    return toKeyword(this.db.prepare('SELECT * FROM aso_keywords WHERE project_id = ? AND store_id = ? AND text = ?').get(projectId, storeId, norm) as Row);
  }

  listKeywords(projectId: string, storeId: string, includeArchived = false): AsoKeyword[] {
    const rows = this.db.prepare(
      `SELECT * FROM aso_keywords WHERE project_id = ? AND store_id = ? ${includeArchived ? '' : 'AND archived = 0'} ORDER BY id`,
    ).all(projectId, storeId) as Row[];
    return rows.map(toKeyword);
  }

  /** false si no existe. */
  archiveKeyword(id: number): boolean {
    return this.db.prepare('UPDATE aso_keywords SET archived = 1 WHERE id = ?').run(id).changes > 0;
  }

  // --- observaciones ---

  /** Una observación por keyword y día natural (hora local): la última pasada del día sustituye a las anteriores. */
  addObservation(o: AsoObservation): void {
    const upsert = this.db.transaction(() => {
      const t = Date.parse(o.takenAt);
      const near = this.db.prepare('SELECT id, taken_at FROM aso_observations WHERE keyword_id = ? AND taken_at >= ? AND taken_at <= ?')
        .all(o.keywordId, new Date(t - 36 * 3_600_000).toISOString(), new Date(t + 36 * 3_600_000).toISOString()) as { id: number; taken_at: string }[];
      const day = localDay(o.takenAt);
      const del = this.db.prepare('DELETE FROM aso_observations WHERE id = ?');
      for (const r of near) if (localDay(r.taken_at) === day) del.run(r.id);
      this.db.prepare('INSERT INTO aso_observations (keyword_id, taken_at, ok, popularity, difficulty, rank, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(o.keywordId, o.takenAt, o.ok ? 1 : 0, o.popularity, o.difficulty, o.rank, o.error);
    });
    upsert();
  }

  observations(keywordId: number, sinceIso: string): AsoObservation[] {
    return (this.db.prepare('SELECT * FROM aso_observations WHERE keyword_id = ? AND taken_at >= ? ORDER BY taken_at ASC, id ASC')
      .all(keywordId, sinceIso) as Row[]).map(toObservation);
  }

  latestObservation(keywordId: number): AsoObservation | null {
    const r = this.db.prepare('SELECT * FROM aso_observations WHERE keyword_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1').get(keywordId) as Row | undefined;
    return r ? toObservation(r) : null;
  }

  // --- competidores ---

  addCompetitor(projectId: string, appId: string, name: string): AsoCompetitor {
    this.db.prepare('INSERT OR IGNORE INTO aso_competitors (project_id, app_id, name) VALUES (?, ?, ?)').run(projectId, appId, name);
    this.db.prepare('UPDATE aso_competitors SET archived = 0 WHERE project_id = ? AND app_id = ?').run(projectId, appId);
    return toCompetitor(this.db.prepare('SELECT * FROM aso_competitors WHERE project_id = ? AND app_id = ?').get(projectId, appId) as Row);
  }

  listCompetitors(projectId: string, includeArchived = false): AsoCompetitor[] {
    return (this.db.prepare(`SELECT * FROM aso_competitors WHERE project_id = ? ${includeArchived ? '' : 'AND archived = 0'} ORDER BY id`)
      .all(projectId) as Row[]).map(toCompetitor);
  }

  /** false si no existe. */
  archiveCompetitor(id: number): boolean {
    return this.db.prepare('UPDATE aso_competitors SET archived = 1 WHERE id = ?').run(id).changes > 0;
  }

  /** Inserta solo si nombre, subtítulo o versión cambian respecto a la última foto de esa tienda. */
  saveCompetitorSnap(s: AsoCompetitorSnap): boolean {
    const last = this.db.prepare('SELECT * FROM aso_competitor_snaps WHERE competitor_id = ? AND store_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1')
      .get(s.competitorId, s.storeId) as Row | undefined;
    if (last) {
      const p = toSnap(last);
      if (p.name === s.name && p.subtitle === s.subtitle && p.version === s.version) return false;
    }
    this.db.prepare('INSERT INTO aso_competitor_snaps (competitor_id, store_id, taken_at, name, subtitle, version) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.competitorId, s.storeId, s.takenAt, s.name, s.subtitle, s.version);
    return true;
  }

  competitorSnaps(competitorId: number, storeId: string, limit: number): AsoCompetitorSnap[] {
    return (this.db.prepare('SELECT * FROM aso_competitor_snaps WHERE competitor_id = ? AND store_id = ? ORDER BY taken_at DESC, id DESC LIMIT ?')
      .all(competitorId, storeId, limit) as Row[]).map(toSnap);
  }

  // --- candidatas ---

  addCandidate(projectId: string, storeId: string, text: string): void {
    this.db.prepare('INSERT OR IGNORE INTO aso_candidates (project_id, store_id, text, first_seen) VALUES (?, ?, ?, ?)')
      .run(projectId, storeId, normalizeKeyword(text), now());
  }

  candidates(projectId: string, storeId: string, sinceIso: string): AsoCandidate[] {
    return (this.db.prepare('SELECT * FROM aso_candidates WHERE project_id = ? AND store_id = ? AND first_seen >= ? ORDER BY first_seen, text')
      .all(projectId, storeId, sinceIso) as Row[]).map(toCandidate);
  }

  // --- propuestas ---

  addProposal(p: Omit<AsoProposal, 'id' | 'state' | 'createdAt'>): AsoProposal | null {
    const insert = this.db.transaction((): AsoProposal | null => {
      if (p.kind === 'ficha') {
        this.db.prepare("UPDATE aso_proposals SET state = 'superseded' WHERE project_id = ? AND kind = 'ficha' AND store_id IS ? AND state = 'pending'")
          .run(p.projectId, p.storeId);
      } else {
        const key = proposalKey(p.kind, p.payload);
        const same = (this.db.prepare(
          "SELECT * FROM aso_proposals WHERE project_id = ? AND kind = ? AND store_id IS ? AND state IN ('pending', 'rejected')",
        ).all(p.projectId, p.kind, p.storeId) as Row[]).map(toProposal);
        if (same.some((o) => proposalKey(o.kind, o.payload) === key)) return null;
      }
      const info = this.db.prepare('INSERT INTO aso_proposals (project_id, store_id, kind, payload, why, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(p.projectId, p.storeId, p.kind, JSON.stringify(p.payload), p.why, p.taskId, now());
      return this.getProposal(Number(info.lastInsertRowid));
    });
    return insert();
  }

  private getProposal(id: number): AsoProposal {
    const r = this.db.prepare('SELECT * FROM aso_proposals WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new AsoProposalError(`Propuesta ${id} no encontrada`, 'not_found');
    return toProposal(r);
  }

  listProposals(projectId: string, state?: AsoProposal['state']): AsoProposal[] {
    const rows = state
      ? this.db.prepare('SELECT * FROM aso_proposals WHERE project_id = ? AND state = ? ORDER BY id').all(projectId, state)
      : this.db.prepare('SELECT * FROM aso_proposals WHERE project_id = ? ORDER BY id').all(projectId);
    return (rows as Row[]).map(toProposal);
  }

  decideProposal(id: number, decision: 'accepted' | 'rejected'): AsoProposal {
    const decide = this.db.transaction((): AsoProposal => {
      const p = this.getProposal(id);
      if (p.state !== 'pending') {
        const label = p.state === 'accepted' ? 'aceptada' : p.state === 'superseded' ? 'sustituida por otra más nueva' : 'rechazada';
        throw new AsoProposalError(`La propuesta ${id} ya está ${label}`, 'decided');
      }
      if (decision === 'accepted') this.apply(p);
      this.db.prepare('UPDATE aso_proposals SET state = ? WHERE id = ?').run(decision, id);
      return this.getProposal(id);
    });
    return decide();
  }

  private apply(p: AsoProposal): void {
    if (p.kind === 'follow' && p.storeId) {
      this.addKeyword(p.projectId, p.storeId, String(p.payload.keyword ?? ''), 'agent');
    } else if (p.kind === 'unfollow' && p.storeId) {
      const norm = normalizeKeyword(String(p.payload.keyword ?? ''));
      this.db.prepare('UPDATE aso_keywords SET archived = 1 WHERE project_id = ? AND store_id = ? AND text = ?').run(p.projectId, p.storeId, norm);
    } else if (p.kind === 'competitor') {
      const appId = String(p.payload.appId ?? '');
      if (!/^\d+$/.test(appId)) throw new AsoProposalError(`El appId «${appId}» no es numérico`, 'invalid');
      this.addCompetitor(p.projectId, appId, String(p.payload.name ?? appId));
    }
  }

  // --- ficha vigente guardada por el colector ---

  storedFicha(projectId: string, storeId: string): AsoStoredFicha | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`aso.ficha.${projectId}.${storeId}`) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as AsoStoredFicha) : null;
  }

  setStoredFicha(projectId: string, storeId: string, f: AsoStoredFicha): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`aso.ficha.${projectId}.${storeId}`, JSON.stringify(f));
  }

  // --- última pasada ---

  lastRun(projectId: string): AsoLastRun | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`aso.ultima.${projectId}`) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as AsoLastRun) : null;
  }

  setLastRun(projectId: string, r: AsoLastRun): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`aso.ultima.${projectId}`, JSON.stringify(r));
  }
}
