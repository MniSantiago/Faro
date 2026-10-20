/** Puntuaciones ASO (0-100, enteras). Funciones puras. */

/** Longitudes de prefijo a consultar al autocompletado: 2…min(len, 8) y, si len > 8, también len. */
export function PREFIX_LENGTHS(termLen: number): number[] {
  const out: number[] = [];
  for (let n = 2; n <= Math.min(termLen, 8); n++) out.push(n);
  if (termLen > 8) out.push(termLen);
  return out;
}

/**
 * Popularidad: cuanto antes sugiere Apple el término (prefijo corto, posición alta), más popular.
 *   lenF = (termLen - prefixLen + 1) / (termLen - 1)   → 1 con 2 letras, 1/(termLen-1) con el término entero
 *   posF = 1 / (1 + 0.25 * position)                    → 1 en primera posición, ~0.31 en la décima
 *   nota = max(1, round(100 * lenF * posF)); 0 si no aparece.
 */
export function popularity(firstHit: { prefixLen: number; position: number } | null, termLen: number): number {
  if (!firstHit) return 0;
  const lenF = termLen <= 2 ? 1 : Math.min(1, Math.max(0, (termLen - firstHit.prefixLen + 1) / (termLen - 1)));
  const posF = 1 / (1 + 0.25 * Math.max(0, firstHit.position));
  return Math.max(1, Math.round(100 * lenF * posF));
}

/**
 * Dificultad: media, sobre las apps del top, de
 *   0.8 * volumen + 0.2 * (nota / 5)
 * con volumen = min(1, log10(valoraciones + 1) / 6) (escala logarítmica: 1 M de valoraciones = tope).
 * La nota pesa menos que el volumen. Sin apps → 0. Resultado ×100 redondeado.
 */
export function difficulty(top: { ratingCount: number; rating: number }[]): number {
  if (top.length === 0) return 0;
  let sum = 0;
  for (const a of top) {
    const vol = Math.min(1, Math.log10(Math.max(0, a.ratingCount) + 1) / 6);
    const rate = Math.min(1, Math.max(0, a.rating / 5));
    sum += 0.8 * vol + 0.2 * rate;
  }
  return Math.round((sum / top.length) * 100);
}

export function opportunity(pop: number, diff: number): number {
  return Math.round((pop * (100 - diff)) / 100);
}
