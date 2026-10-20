/** Lectura de la ficha de la App Store y normalización de palabras. */
import { exec } from '../exec';
import type { ProjectConfig } from '../types';
import { lookup, subtitle } from './apple';
import type { AsoRepo } from './repo';
import type { AsoStoreConfig } from './types';

export interface Ficha {
  name: string | null;
  subtitle: string | null;
  keywords: string | null;
}

/** Minúsculas, sin tildes (la «ñ» se conserva), espacios colapsados y recortados. */
export function normalizeKeyword(s: string): string {
  return s
    .normalize('NFD')
    .replace(/ñ/g, '\u0001') // protege la ñ antes de quitar diacríticos
    .replace(/Ñ/g, '\u0001')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\u0001/g, 'ñ')
    .replace(/\s+/g, ' ')
    .trim();
}

function section(md: string, title: string): string | null {
  // Expresión para extraer los campos de la ficha en Markdown.
  const re = new RegExp(`^## ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\n\`\`\`\\n([\\s\\S]*?)\\n\`\`\``, 'm');
  const m = re.exec(md);
  return m ? m[1]! : null;
}

export function parseFicha(md: string): Ficha {
  return {
    name: section(md, 'Nombre'),
    subtitle: section(md, 'Subtítulo'),
    keywords: section(md, 'Palabras clave'),
  };
}

/** Palabras normalizadas de la ficha. Keywords: por comas y espacios; nombre y subtítulo: por no letras/números. */
export function fichaWords(f: Ficha): Set<string> {
  const out = new Set<string>();
  const add = (text: string | null, sep: RegExp) => {
    if (!text) return;
    for (const w of normalizeKeyword(text).split(sep)) if (w) out.add(w);
  };
  add(f.keywords, /[,\s]+/);
  add(f.name, /[^\p{L}\p{N}]+/u);
  add(f.subtitle, /[^\p{L}\p{N}]+/u);
  return out;
}

/** Todas las palabras de la keyword (normalizada) están en la ficha. Los plurales cuentan como distintas. */
export function inFicha(keyword: string, words: Set<string>): boolean {
  const parts = normalizeKeyword(keyword).split(' ').filter(Boolean);
  return parts.length > 0 && parts.every((w) => words.has(w));
}

/** Ficha publicada en la rama base: `git show <base>:<file>`. null si el archivo no existe en esa rama. */
export async function readFicha(repoPath: string, baseBranch: string, file: string): Promise<Ficha | null> {
  const r = await exec('git', ['show', `${baseBranch}:${file}`], { cwd: repoPath, timeoutMs: 15_000 });
  return r.code === 0 ? parseFicha(r.stdout) : null;
}

export interface CurrentFicha extends Ficha {
  sources: { name: 'tienda' | 'repo' | null; subtitle: 'tienda' | 'repo' | null; keywords: 'repo' | null };
}

/**
 * Ficha vigente: nombre (lookup) y subtítulo (página pública) de la tienda; si alguno falla se usa el del repo.
 * Las keywords no se publican en ninguna API, así que siempre vienen del repo.
 */
export async function currentFicha(
  f: typeof fetch,
  project: ProjectConfig,
  store: AsoStoreConfig,
  read: typeof readFicha = readFicha,
): Promise<CurrentFicha> {
  const repo = await read(project.repoPath, project.baseBranch, store.fichaFile).catch(() => null);
  const appId = project.aso?.appId ?? '';
  const storeName = await lookup(f, [appId], store.country).then((m) => m.get(appId)?.name || null).catch(() => null);
  const storeSub = await subtitle(f, appId, store.country).catch(() => null);
  const name = storeName ?? repo?.name ?? null;
  const sub = storeSub ?? repo?.subtitle ?? null;
  return {
    name,
    subtitle: sub,
    keywords: repo?.keywords ?? null,
    sources: {
      name: storeName ? 'tienda' : repo?.name ? 'repo' : null,
      subtitle: storeSub ? 'tienda' : repo?.subtitle ? 'repo' : null,
      keywords: repo?.keywords ? 'repo' : null,
    },
  };
}

/** `fetch` con un tiempo máximo propio por petición, combinado con la señal de quien llama. */
export function withTimeout(f: typeof fetch, ms: number): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const t = AbortSignal.timeout(ms);
    return f(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, t]) : t });
  }) as typeof fetch;
}

/** Tiempo máximo de cada petición cuando la página o la rutina piden una ficha que el colector aún no guardó. */
export const QUICK_FICHA_TIMEOUT_MS = 5_000;

/**
 * Ficha vigente para la página y la rutina: la que guardó el colector en su última pasada; si no hay ninguna,
 * se consulta solo esta tienda con un tiempo corto (y, si Apple no responde, se usan los valores del repo).
 */
export async function storedOrCurrentFicha(
  repo: Pick<AsoRepo, 'storedFicha'>,
  f: typeof fetch,
  project: ProjectConfig,
  store: AsoStoreConfig,
  read: typeof readFicha = readFicha,
): Promise<CurrentFicha> {
  const stored = repo.storedFicha(project.id, store.id);
  if (stored) return stored.ficha;
  return currentFicha(withTimeout(f, QUICK_FICHA_TIMEOUT_MS), project, store, read);
}
