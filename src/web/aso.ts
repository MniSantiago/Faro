/** Funciones puras de la página ASO. */

export interface KeywordRow {
  id: number; text: string; source: 'user' | 'agent'; inFicha: boolean;
  popularity: number | null; difficulty: number | null; opportunity: number | null;
  rank: number | null; rankDelta7: number | null; takenAt: string | null; ok: boolean;
}

export type SortBy = 'oportunidad' | 'popularidad' | 'dificultad' | 'puesto';

/** Oportunidad y popularidad de mayor a menor; dificultad y puesto de menor a mayor. Sin dato, siempre al final. */
export function sortKeywords(rows: KeywordRow[], by: SortBy = 'oportunidad'): KeywordRow[] {
  const key = (r: KeywordRow): number | null =>
    by === 'oportunidad' ? r.opportunity : by === 'popularidad' ? r.popularity : by === 'dificultad' ? r.difficulty : r.rank;
  const sign = by === 'oportunidad' || by === 'popularidad' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return sign * (x - y);
  });
}

export const formatRank = (r: number | null): string => (r === null ? '—' : String(r));

/** Cambio de puesto: el número sube = empeora (↓); baja = mejora (↑). */
export function formatDelta(d: number | null): string {
  if (d === null) return '—';
  const n = Math.round(Math.abs(d));
  if (n === 0) return '=';
  return d > 0 ? `↓ ${n}` : `↑ ${n}`;
}

export function charCount(s: string, limit: number): { n: number; over: boolean } {
  const n = [...s].length;
  return { n, over: n > limit };
}

export interface CompetitorSnap { takenAt: string; name: string; subtitle: string | null; version: string | null }
export interface CompetitorChange { takenAt: string; text: string }

/** Subtítulo para mostrar: null es que no se pudo leer, no que no tenga. */
export const showSubtitle = (s: string | null): string => s ?? 'desconocido';

/**
 * Cambios de un competidor, del más reciente al más antiguo (`snaps` viene en ese orden). Un subtítulo null
 * nunca es un cambio: se compara con el último subtítulo conocido, como en los avisos. Las versiones sí salen.
 */
export function competitorChanges(snaps: CompetitorSnap[]): CompetitorChange[] {
  const out: CompetitorChange[] = [];
  snaps.forEach((cur, i) => {
    const prev = snaps[i + 1];
    if (!prev) return;
    const prevSub = snaps.slice(i + 1).find((x) => x.subtitle !== null)?.subtitle ?? null;
    const parts: string[] = [];
    if (cur.name !== prev.name) parts.push(`nombre «${prev.name}» → «${cur.name}»`);
    if (cur.subtitle !== null && prevSub !== null && cur.subtitle !== prevSub) parts.push(`subtítulo «${prevSub}» → «${cur.subtitle}»`);
    if (cur.version !== prev.version && cur.version !== null && prev.version !== null) parts.push(`versión ${prev.version} → ${cur.version}`);
    if (parts.length) out.push({ takenAt: cur.takenAt, text: parts.join('; ') });
  });
  return out;
}
