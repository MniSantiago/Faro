const dec = (n: number, digits: number) => n.toFixed(digits).replace('.', ',');

export { formatUsd } from '../shared/format';

/** Tokens abreviados: «999», «57 k», «1 M», «1,5 M». */
export function formatTokens(n: number | null): string {
  if (n === null) return '—';
  if (n < 1000) return String(Math.round(n));
  const k = Math.round(n / 1000);
  if (k < 1000) return `${k} k`;
  return `${dec(Math.round(n / 100000) / 10, 1).replace(/,0$/, '')} M`;
}

/** Nivel de la barra de contexto: verde < 60 %, ámbar < 85 %, roja a partir de ahí. */
export function contextLevel(tokens: number | null, window: number): 'ok' | 'warn' | 'high' | null {
  if (tokens === null || !(window > 0)) return null;
  const r = tokens / window;
  return r < 0.6 ? 'ok' : r < 0.85 ? 'warn' : 'high';
}
