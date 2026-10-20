/** Avisos del módulo ASO: caídas de ranking en keywords de la ficha y cambios de la competencia. */
import type { PushMessage } from '../push';
import { inFicha } from './ficha';
import type { AsoObservation, AsoRepo } from './repo';

const DAY = 24 * 60 * 60 * 1000;
const URL = '/#/aso';
/** Fuera del top 200 cuenta como 201 en las cuentas. */
const OUT = 201;

export interface RankDrop { keyword: string; from: number | null; to: number | null }
export interface CompetitorChange { name: string; storeId: string; field: 'nombre' | 'subtítulo' }

/** Observaciones previas mínimas (días distintos: hay una por día) para comparar con la media. */
export const MIN_PRIOR_DAYS = 3;

/**
 * Ventana de comparación del puesto, la misma para los avisos y para «7 días» de la página:
 * `today` es la última observación hasta `now` y `prior` las ok de los 7 días anteriores a `now` (sin `today`).
 * Como el repo guarda una observación por keyword y día, `prior.length` cuenta días distintos.
 */
export function rankWindow(repo: Pick<AsoRepo, 'observations'>, keywordId: number, now: Date): { today: AsoObservation | null; prior: AsoObservation[] } {
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  const all = repo.observations(keywordId, since).filter((o) => o.takenAt <= now.toISOString());
  const today = all.at(-1) ?? null;
  return { today, prior: all.slice(0, -1).filter((o) => o.ok) };
}

/**
 * Keywords de la ficha cuya posición de hoy (última observación) ha caído: la anterior era ≤ 10 y ahora > 10 o fuera,
 * o hoy empeora en 10 o más puestos la media de los 7 días anteriores (mínimo 3 días con observación ok; ver rankWindow).
 */
export function rankAlerts(repo: AsoRepo, projectId: string, storeId: string, fichaWords: Set<string>, now: Date): RankDrop[] {
  const out: RankDrop[] = [];
  for (const kw of repo.listKeywords(projectId, storeId)) {
    if (!inFicha(kw.text, fichaWords)) continue;
    const { today, prior } = rankWindow(repo, kw.id, now);
    if (!today || !today.ok) continue;
    if (prior.length < MIN_PRIOR_DAYS) continue;
    const prev = prior[prior.length - 1]!;
    const n = (r: number | null) => r ?? OUT;
    const avg = prior.reduce((s, o) => s + n(o.rank), 0) / prior.length;
    if ((n(prev.rank) <= 10 && n(today.rank) > 10) || n(today.rank) - avg >= 10) {
      out.push({ keyword: kw.text, from: prev.rank, to: today.rank });
    }
  }
  return out;
}

const pos = (r: number | null) => (r === null ? '—' : String(r));

export function rankMessage(appName: string, drops: (RankDrop & { storeId: string })[]): PushMessage | null {
  if (drops.length === 0) return null;
  if (drops.length === 1) {
    const d = drops[0]!;
    return { title: `${appName} baja en «${d.keyword}» (${d.storeId})`, body: `Del ${pos(d.from)} al ${pos(d.to)}`, url: URL };
  }
  const stores = [...new Set(drops.map((d) => d.storeId))].join(', ');
  return {
    title: `${appName} baja en ${drops.length} keywords (${stores})`,
    body: drops.map((d) => `«${d.keyword}» (${d.storeId}): del ${pos(d.from)} al ${pos(d.to)}`).join('\n'),
    url: URL,
  };
}

export function competitorAlerts(changes: CompetitorChange[]): PushMessage | null {
  if (changes.length === 0) return null;
  if (changes.length === 1) {
    const c = changes[0]!;
    return { title: `${c.name} ha cambiado su ${c.field} (${c.storeId})`, body: 'Mira el detalle en ASO', url: URL };
  }
  return {
    title: `${changes.length} cambios en la competencia`,
    body: changes.map((c) => `${c.name}: ${c.field} (${c.storeId})`).join('\n'),
    url: URL,
  };
}
