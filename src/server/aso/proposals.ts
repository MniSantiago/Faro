/** Importa el resultado de la rutina ASO (bloque ```aso-json``` de su mensaje final) como propuestas pendientes. */
import { z } from 'zod';
import type { Store } from '../store';
import type { ProjectConfig } from '../types';
import { fichaWords, normalizeKeyword } from './ficha';

const Why = z.object({ keyword: z.string(), why: z.string() });

export const AsoResultSchema = z.object({
  stores: z.record(z.string(), z.object({
    follow: z.array(Why).optional(),
    unfollow: z.array(Why).optional(),
    ficha: z.object({ name: z.string(), subtitle: z.string(), keywords: z.string(), why: z.string() }).nullable().optional(),
  })),
  competitors: z.array(z.object({ appId: z.string(), name: z.string(), why: z.string() })).optional(),
});

export const FICHA_LIMITS = { name: 30, subtitle: 30, keywords: 100 } as const;
/** Como mucho tantas propuestas `follow` por tienda en cada importación. */
export const MAX_FOLLOW_PER_STORE = 10;

const BLOCK = /```aso-json[^\n]*\n([\s\S]*?)```/g;

/** Contenido del último bloque ```aso-json``` del texto (el agente puede corregirse); null si no hay ninguno. */
export function extractAsoJson(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(BLOCK)) last = m[1]!;
  return last;
}

/** Problemas de una ficha propuesta; vacío si cumple los límites y no repite palabras. */
function fichaProblems(f: { name: string; subtitle: string; keywords: string }): string[] {
  const out: string[] = [];
  for (const k of ['name', 'subtitle', 'keywords'] as const) {
    const n = [...f[k]].length;
    if (n > FICHA_LIMITS[k]) out.push(`${k === 'name' ? 'el nombre' : k === 'subtitle' ? 'el subtítulo' : 'las keywords'} tiene ${n} caracteres (máximo ${FICHA_LIMITS[k]})`);
  }
  if (/\s,|,\s/.test(f.keywords)) out.push('las keywords deben ir separadas por comas sin espacios');
  const own = fichaWords({ name: f.name, subtitle: f.subtitle, keywords: null });
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const w of normalizeKeyword(f.keywords).split(/[,\s]+/).filter(Boolean)) {
    if (own.has(w) || seen.has(w)) repeated.add(w);
    seen.add(w);
  }
  if (repeated.size) out.push(`las keywords repiten palabras: ${[...repeated].join(', ')}`);
  return out;
}

export function importAsoResult(
  store: Store, project: ProjectConfig, taskId: string, json: string,
): { created: number; errors: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return { created: 0, errors: ['el bloque aso-json no es un JSON válido'] }; }
  const parsed = AsoResultSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { created: 0, errors: [`el bloque aso-json no tiene la forma esperada${i ? ` (${i.path.join('.') || 'raíz'}: ${i.message})` : ''}`] };
  }
  const stores = new Set((project.aso?.stores ?? []).map((s) => s.id));
  const errors: string[] = [];
  let created = 0;
  const add = (storeId: string | null, kind: 'follow' | 'unfollow' | 'competitor' | 'ficha', payload: Record<string, unknown>, why: string) => {
    if (store.aso.addProposal({ projectId: project.id, storeId, kind, payload, why, taskId })) created++;
  };
  // Fichas ya vistas: pendientes, aceptadas o rechazadas por el usuario (las sustituidas no cuentan).
  const seenFichas = store.aso.listProposals(project.id).filter((o) => o.kind === 'ficha' && o.state !== 'superseded');

  for (const [storeId, s] of Object.entries(parsed.data.stores)) {
    if (!stores.has(storeId)) continue;
    const followed = new Set(store.aso.listKeywords(project.id, storeId).map((k) => k.text));
    let follows = 0;
    for (const kind of ['follow', 'unfollow'] as const) {
      for (const k of s[kind] ?? []) {
        const keyword = normalizeKeyword(k.keyword);
        if (!keyword) { errors.push(`${storeId}: ${kind} con keyword vacía, omitida`); continue; }
        if (kind === 'follow' && followed.has(keyword)) { errors.push(`${storeId}: «${keyword}» ya se sigue, omitida`); continue; }
        if (kind === 'unfollow' && !followed.has(keyword)) { errors.push(`${storeId}: «${keyword}» no se sigue, no hay nada que dejar`); continue; }
        if (kind === 'follow' && ++follows > MAX_FOLLOW_PER_STORE) {
          errors.push(`${storeId}: más de ${MAX_FOLLOW_PER_STORE} follow, «${keyword}» omitida`);
          continue;
        }
        add(storeId, kind, { keyword }, k.why);
      }
    }
    if (s.ficha) {
      const f = s.ficha;
      const problems = fichaProblems(f);
      if (problems.length) errors.push(`${storeId}: ficha rechazada (${problems.join('; ')})`);
      else if (seenFichas.some((o) => o.storeId === storeId && o.payload.name === f.name && o.payload.subtitle === f.subtitle && o.payload.keywords === f.keywords)) continue;
      else add(storeId, 'ficha', { name: f.name, subtitle: f.subtitle, keywords: f.keywords }, f.why);
    }
  }
  for (const c of parsed.data.competitors ?? []) {
    const appId = c.appId.trim();
    if (!appId) { errors.push('competidor sin appId, omitido'); continue; }
    if (!/^\d+$/.test(appId)) { errors.push(`competidor con appId no numérico «${appId}», omitido`); continue; }
    add(null, 'competitor', { appId, name: c.name.trim() || appId }, c.why);
  }
  return { created, errors };
}
