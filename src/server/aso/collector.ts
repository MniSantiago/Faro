import type { Push } from '../push';
import type { Store } from '../store';
import type { FaroConfig, ProjectConfig } from '../types';
import { competitorAlerts, rankAlerts, rankMessage, type CompetitorChange, type RankDrop } from './alerts';
import { AppleError, hints, lookup, search, subtitle } from './apple';
import { currentFicha, fichaWords, normalizeKeyword, readFicha } from './ficha';
import { difficulty, popularity, PREFIX_LENGTHS } from './scores';
import type { AsoStoreConfig } from './types';

const DAY = 24 * 60 * 60 * 1000;
const PAUSE_MS = 300;

export interface AsoCollectorDeps {
  store: Store;
  config: FaroConfig;
  push: Pick<Push, 'send'>;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  readFicha?: typeof readFicha;
}

interface Sent { ranking?: string; competencia?: string }

const isCut = (e: unknown): e is AppleError => e instanceof AppleError && (e.status === 403 || e.status === 429);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const keywordErrors = (storeId: string, failed: string[]) =>
  `${storeId}: ${failed.length} ${failed.length === 1 ? 'keyword' : 'keywords'} con error (${failed[0]})`;

export class AsoCollector {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly d: AsoCollectorDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  /** Una pasada por proyecto con `aso`. Si ya hay una en curso, espera a esa. */
  collectAll(): Promise<void> {
    this.running ??= this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<void> {
    for (const p of this.d.config.projects) {
      if (!p.aso) continue;
      const errors: string[] = [];
      try {
        await this.collectProject(p, errors);
      } catch (e) {
        errors.push(`La pasada falló: ${message(e)}`);
      }
      this.d.store.aso.setLastRun(p.id, {
        at: this.now().toISOString(), ok: errors.length === 0, error: errors.length ? errors.join('; ') : null,
      });
    }
  }

  /** `fetch` que deja ≥ 300 ms entre peticiones consecutivas de la pasada. */
  private throttled(): typeof fetch {
    const base = this.d.fetch ?? fetch;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let first = true;
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (!first) await sleep(PAUSE_MS);
      first = false;
      return base(input, init);
    }) as typeof fetch;
  }

  private async collectProject(project: ProjectConfig, errors: string[]): Promise<void> {
    const aso = project.aso!;
    const f = this.throttled();
    const drops: (RankDrop & { storeId: string })[] = [];
    const cutStores = new Set<string>();

    for (const store of aso.stores) {
      try {
        await this.collectStore(f, project, store, errors, cutStores, drops);
      } catch (e) {
        errors.push(`${store.id}: ${message(e)}`);
      }
    }

    const changes: CompetitorChange[] = [];
    for (const store of aso.stores) {
      if (cutStores.has(store.id)) continue;
      try {
        await this.collectCompetitors(f, project, store, errors, cutStores, changes);
      } catch (e) {
        errors.push(`${store.id}: competidores: ${message(e)}`);
      }
    }

    await this.notify(project.id, rankMessage(project.name, drops), 'ranking');
    await this.notify(project.id, competitorAlerts(changes), 'competencia');
  }

  private async collectStore(
    f: typeof fetch, project: ProjectConfig, store: AsoStoreConfig, errors: string[],
    cutStores: Set<string>, drops: (RankDrop & { storeId: string })[],
  ): Promise<void> {
    const repo = this.d.store.aso;
    const keywords = repo.listKeywords(project.id, store.id);
    const followed = new Set(keywords.map((k) => normalizeKeyword(k.text)));
    const failed: string[] = [];
    for (const kw of keywords) {
      const takenAt = this.now().toISOString();
      try {
        const term = normalizeKeyword(kw.text);
        let hit: { prefixLen: number; position: number } | null = null;
        let fetchedFull = false;
        for (const len of PREFIX_LENGTHS(term.length)) {
          const suggestions = (await hints(f, term.slice(0, len), store.storefront)).map(normalizeKeyword);
          if (len === term.length) fetchedFull = true;
          if (len === 3 || len === term.length) {
            for (const s of suggestions) if (s && !followed.has(s)) repo.addCandidate(project.id, store.id, s);
          }
          const position = suggestions.indexOf(term);
          if (position >= 0) { hit = { prefixLen: len, position }; break; }
        }
        if (!fetchedFull) {
          // Solo para candidatas: si falla, la observación de la keyword no cambia.
          try {
            for (const s of (await hints(f, term, store.storefront)).map(normalizeKeyword)) {
              if (s && !followed.has(s)) repo.addCandidate(project.id, store.id, s);
            }
          } catch { /* sin candidatas de la keyword completa */ }
        }
        const results = await search(f, term, store.country);
        const idx = results.findIndex((r) => String(r.trackId) === project.aso!.appId);
        repo.addObservation({
          keywordId: kw.id, takenAt, ok: true,
          popularity: popularity(hit, term.length), difficulty: difficulty(results.slice(0, 10)),
          rank: idx >= 0 ? idx + 1 : null, error: null,
        });
      } catch (e) {
        repo.addObservation({ keywordId: kw.id, takenAt, ok: false, popularity: null, difficulty: null, rank: null, error: message(e) });
        if (isCut(e)) {
          cutStores.add(store.id);
          if (failed.length) errors.push(keywordErrors(store.id, failed));
          errors.push(`${store.id}: pasada cortada (${message(e)})`);
          return;
        }
        failed.push(message(e));
      }
    }
    if (failed.length) errors.push(keywordErrors(store.id, failed));

    let words: Set<string> | null = null;
    try {
      const ficha = await currentFicha(f, project, store, this.d.readFicha ?? readFicha);
      repo.setStoredFicha(project.id, store.id, { takenAt: this.now().toISOString(), ficha });
      words = fichaWords(ficha);
    } catch { /* sin ficha no hay avisos de ranking en esta tienda */ }
    if (words) for (const d of rankAlerts(repo, project.id, store.id, words, this.now())) drops.push({ ...d, storeId: store.id });
  }

  private async collectCompetitors(
    f: typeof fetch, project: ProjectConfig, store: AsoStoreConfig, errors: string[],
    cutStores: Set<string>, changes: CompetitorChange[],
  ): Promise<void> {
    const repo = this.d.store.aso;
    const competitors = repo.listCompetitors(project.id);
    if (competitors.length === 0) return;
    try {
      const found = await lookup(f, competitors.map((c) => c.appId), store.country);
      for (const c of competitors) {
        const info = found.get(c.appId);
        if (!info) continue;
        const sub = await subtitle(f, c.appId, store.country).catch((e) => { if (isCut(e)) throw e; return undefined; });
        if (sub === undefined) continue;
        const snaps = repo.competitorSnaps(c.id, store.id, 50);
        const prev = snaps[0];
        // Un subtítulo null intermitente no oculta un cambio real: se compara con la última foto que tuvo subtítulo.
        const prevSub = snaps.find((x) => x.subtitle !== null)?.subtitle ?? null;
        const saved = repo.saveCompetitorSnap({
          competitorId: c.id, storeId: store.id, takenAt: this.now().toISOString(), name: info.name, subtitle: sub, version: info.version,
        });
        if (!saved || !prev) continue;
        if (prev.name !== info.name) changes.push({ name: c.name, storeId: store.id, field: 'nombre' });
        if (prevSub !== null && sub !== null && prevSub !== sub) changes.push({ name: c.name, storeId: store.id, field: 'subtítulo' });
      }
    } catch (e) {
      if (isCut(e)) {
        cutStores.add(store.id);
        errors.push(`${store.id}: competidores cortados (${message(e)})`);
      } else {
        errors.push(`${store.id}: competidores: ${message(e)}`);
      }
    }
  }

  /** Un push de cada tipo por proyecto y día. */
  private async notify(projectId: string, msg: { title: string; body: string; url: string } | null, kind: 'ranking' | 'competencia'): Promise<void> {
    if (!msg) return;
    const key = `aso.avisos.${projectId}`;
    const today = this.now().toISOString().slice(0, 10);
    const sent = this.d.store.getMeta<Sent>(key) ?? {};
    if (sent[kind] === today) return;
    try {
      // Abre ASO en este proyecto y respeta a los dispositivos que lo silenciaron.
      await this.d.push.send({ ...msg, url: `${msg.url}?p=${projectId}` }, { projectId });
      this.d.store.setMeta(key, { ...(this.d.store.getMeta<Sent>(key) ?? {}), [kind]: today });
    } catch (e) {
      console.error('[faro] error enviando aviso de ASO', e);
    }
  }

  start(intervalMs = DAY): void {
    if (this.timer) return;
    const now = this.now().getTime();
    const stale = this.d.config.projects.some((p) => {
      if (!p.aso) return false;
      const last = this.d.store.aso.lastRun(p.id);
      return !last || now - Date.parse(last.at) > DAY;
    });
    if (stale) void this.collectAll().catch((e) => console.error('[faro] error recogiendo ASO', e));
    this.timer = setInterval(() => {
      void this.collectAll().catch((e) => console.error('[faro] error recogiendo ASO', e));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
