import type { HomeMetric } from '../server/home';
import type { ValueFormat } from '../shared/format';

export const HOME_METRICS: HomeMetric[] = ['descargas', 'conversion', 'mrr', 'gasto'];

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Trazo SVG (`d`) de una serie que ocupa la caja `w`×`h`, de izquierda a derecha y con el máximo arriba.
 * Los `null` cortan la línea: cada tramo empieza con su propio `M`. Sin `domain`, la escala va del mínimo al máximo de la serie;
 * si todos los valores son iguales, la línea queda en el centro.
 */
export function sparkPath(values: (number | null)[], w: number, h: number, domain?: [number, number]): string {
  const known = values.filter((v): v is number => v !== null);
  if (!known.length) return '';
  const [lo, hi] = domain ?? [Math.min(...known), Math.max(...known)];
  const x = (i: number) => (values.length === 1 ? w / 2 : (i / (values.length - 1)) * w);
  const y = (v: number) => (hi === lo ? h / 2 : h - ((v - lo) / (hi - lo)) * h);
  let d = '';
  let open = false;
  values.forEach((v, i) => {
    if (v === null) { open = false; return; }
    d += `${open ? 'L' : 'M'}${r1(x(i))},${r1(y(v))}`;
    open = true;
  });
  // Un punto suelto (sin vecinos con dato) se dibuja como un trazo de longitud 0, que con `stroke-linecap: round` se ve.
  return d.replace(/M([\d.,-]+)(?=M|$)/g, 'M$1h0');
}

/** Variación redondeada a una décima, como se pinta (lo que se ve como «0 %» cuenta como 0). */
const shown = (deltaPct: number) => Math.round(deltaPct * 10) / 10;

/** Color de la variación: verde si va en la buena dirección, rojo si no; apagado si no hay variación. */
export function deltaTone(deltaPct: number | null, upIsGood: boolean): 'ok' | 'bad' | 'muted' {
  if (deltaPct === null || shown(deltaPct) === 0) return 'muted';
  return (deltaPct > 0) === upIsGood ? 'ok' : 'bad';
}

/** «▲ 12,5 %», «▼ 3 %», «0 %»; null si no hay referencia. */
export function formatDelta(deltaPct: number | null): string | null {
  if (deltaPct === null) return null;
  const d = shown(deltaPct);
  const n = `${Math.abs(d).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
  return d > 0 ? `▲ ${n}` : d < 0 ? `▼ ${n}` : n;
}

/** Formato de una fila de desglose: dinero en el gasto y en el MRR, enteros en el resto (descargas, pruebas, suscripciones). */
export function rowFormat(metric: HomeMetric, label: string): ValueFormat {
  if (metric === 'gasto') return 'money';
  if (metric === 'mrr') return label === 'MRR' ? 'money' : 'int';
  if (metric === 'conversion') return 'percent';
  return 'int';
}

/** Formato del valor de una cifra. */
export const METRIC_FORMAT: Record<HomeMetric, ValueFormat> = { descargas: 'int', conversion: 'percent', mrr: 'money', gasto: 'money' };

/**
 * Marcas «redondas» del eje vertical que cubren [min, max] (unas `count`, de abajo arriba). Las descargas y el gasto empiezan en 0;
 * una serie plana se abre un poco para que la línea no quede pegada a un borde.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    if (min === 0) return [0, 1];
    const pad = Math.abs(min) * 0.1;
    min -= pad; max += pad;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Redondeo para que 0,1 + 0,2 no dé 0,30000000000000004.
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** «20 oct» de un día local `AAAA-MM-DD`. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }).replace('.', '');
}

const PROJECT_KEY = 'faro:home-project';

/** Proyecto elegido en la home (o null si no hay o el navegador no deja leer). */
export function loadHomeProject(): string | null {
  try { return localStorage.getItem(PROJECT_KEY); } catch { return null; }
}

export function saveHomeProject(id: string): void {
  try { localStorage.setItem(PROJECT_KEY, id); } catch { /* sin almacenamiento: no se recuerda */ }
}
