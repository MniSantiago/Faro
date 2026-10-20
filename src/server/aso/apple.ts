/** Clientes de las APIs públicas de Apple (sugerencias, búsqueda, lookup y página de la app). Sin dormir: el ritmo lo pone quien llama. */

export class AppleError extends Error {
  constructor(
    message: string,
    public status: number | null,
  ) {
    super(message);
    this.name = 'AppleError';
  }
}

/** Tiempo máximo de cada petición a Apple (cabeceras y cuerpo). Agotarlo es un error normal (status null), no un corte. */
export const APPLE_TIMEOUT_MS = 15_000;

const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

async function get(f: typeof fetch, url: string, headers?: Record<string, string>): Promise<string> {
  const signal = AbortSignal.timeout(APPLE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await f(url, headers ? { headers, signal } : { signal });
  } catch (e) {
    if (isTimeout(e)) throw new AppleError('Apple no respondió a tiempo', null);
    throw new AppleError(`No se pudo contactar con Apple: ${(e as Error).message}`, null);
  }
  if (res.status !== 200) throw new AppleError(`Apple respondió ${res.status}`, res.status);
  try {
    return await res.text();
  } catch (e) {
    if (isTimeout(e)) throw new AppleError('Apple no respondió a tiempo', null);
    throw new AppleError(`No se pudo leer la respuesta de Apple: ${(e as Error).message}`, null);
  }
}

async function getJson(f: typeof fetch, url: string): Promise<{ results?: Array<Record<string, unknown>> }> {
  const body = await get(f, url);
  try {
    const json = JSON.parse(body);
    if (json === null || typeof json !== 'object') throw new Error('no es un objeto');
    return json;
  } catch {
    throw new AppleError('Apple no devolvió JSON válido', null);
  }
}

/** Un número fuera de Unicode haría lanzar a fromCodePoint: se deja la entidad tal cual. */
function codePoint(n: number, original: string): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : original;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codePoint(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => codePoint(parseInt(d, 10), m))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Sugerencias de búsqueda: el plist trae `<key>term</key><string>…</string>` por cada sugerencia. */
export async function hints(f: typeof fetch, term: string, storefront: string): Promise<string[]> {
  const url = `https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=${encodeURIComponent(term)}`;
  const body = await get(f, url, { 'X-Apple-Store-Front': storefront });
  // Un cuerpo que no es un plist (p. ej. una página HTML de mantenimiento) es un error, no «sin sugerencias».
  if (!/<plist[\s>]/.test(body)) throw new AppleError('Apple no devolvió un plist válido', null);
  const out: string[] = [];
  for (const m of body.matchAll(/<key>term<\/key>\s*<string>([^<]*)<\/string>/g)) out.push(decodeEntities(m[1]));
  return out;
}

export async function search(
  f: typeof fetch,
  term: string,
  country: string,
): Promise<{ trackId: number; name: string; ratingCount: number; rating: number }[]> {
  const json = await getJson(
    f,
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${encodeURIComponent(country)}&entity=software&limit=200`,
  );
  if (!Array.isArray(json.results)) throw new AppleError('Respuesta de búsqueda sin resultados', null);
  return json.results.map((r) => ({
    trackId: Number(r.trackId),
    name: String(r.trackName ?? ''),
    ratingCount: Number(r.userRatingCount ?? 0) || 0,
    rating: Number(r.averageUserRating ?? 0) || 0,
  }));
}

export async function lookup(
  f: typeof fetch,
  ids: string[],
  country: string,
): Promise<Map<string, { name: string; version: string | null }>> {
  const json = await getJson(f, `https://itunes.apple.com/lookup?id=${ids.map(encodeURIComponent).join(',')}&country=${encodeURIComponent(country)}`);
  if (!Array.isArray(json.results)) throw new AppleError('Respuesta de lookup sin resultados', null);
  const out = new Map<string, { name: string; version: string | null }>();
  for (const r of json.results) {
    out.set(String(r.trackId), {
      name: String(r.trackName ?? ''),
      version: typeof r.version === 'string' ? r.version : null,
    });
  }
  return out;
}

/**
 * Subtítulo de la ficha. La página pública pinta la cabecera como `<h1>nombre</h1>` seguido de
 * `<p class="subtitle …">subtítulo</p>` (el sufijo de la clase es un hash de Svelte que cambia, por eso
 * solo se exige el prefijo `subtitle`). Las apps parecidas de más abajo usan otro elemento con la misma
 * clase, así que se ancla al cierre del primer `</h1>` y se toma el primer `<p>` justo después.
 * Si la estructura cambia y no encaja, devuelve null: nunca lanza por la extracción.
 */
export async function subtitle(f: typeof fetch, appId: string, country: string): Promise<string | null> {
  const html = await get(f, `https://apps.apple.com/${encodeURIComponent(country)}/app/id${encodeURIComponent(appId)}`);
  const m = /<\/h1>\s*<p\s+class="subtitle[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(html);
  if (!m) return null;
  const text = decodeEntities(m[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  return text || null;
}
