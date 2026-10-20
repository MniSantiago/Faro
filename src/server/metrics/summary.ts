import { formatValue, type ValueFormat } from '../../shared/format';
import type { Store } from '../store';
import { CONVERSION_KEY } from './posthog';
import type { MetricsConfig, Snapshot, SourceId } from './types';

export interface Card {
  id: string; label: string; value: number | string | null;
  format: ValueFormat;
  deltaPct: number | null; takenAt: string | null; source: SourceId;
}

const DEFS: { id: string; label: string; source: SourceId; format: ValueFormat }[] = [
  { id: 'mrr', label: 'MRR', source: 'revenuecat', format: 'money' },
  { id: 'active_trials', label: 'Pruebas activas', source: 'revenuecat', format: 'int' },
  { id: 'active_subscriptions', label: 'Suscripciones activas', source: 'revenuecat', format: 'int' },
  { id: CONVERSION_KEY, label: 'Conversión', source: 'posthog', format: 'percent' },
  { id: 'rating', label: 'Valoración', source: 'appstore', format: 'rating' },
  { id: 'review_state', label: 'Estado de la versión', source: 'appstore', format: 'text' },
];

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** Una foto de referencia solo vale si cae a ±1,5 días de hace 7 días. */
const REF_TOLERANCE = 1.5 * DAY;

/** Tarjetas de resumen; `metrics` (la config del proyecto) pone el nombre de la conversión del embudo. */
export function buildCards(store: Store, projectId: string, now: Date, metrics?: MetricsConfig): Card[] {
  const latest = new Map<SourceId, Snapshot | null>();
  const old = new Map<SourceId, Snapshot | null>();
  const cards: Card[] = [];
  for (const d of DEFS) {
    if (!latest.has(d.source)) {
      latest.set(d.source, store.latestSnapshot(projectId, d.source, true));
      const target = now.getTime() - WEEK;
      const near = store.snapshotNear(projectId, d.source, new Date(target));
      old.set(d.source, near && Math.abs(Date.parse(near.takenAt) - target) <= REF_TOLERANCE ? near : null);
    }
    const snap = latest.get(d.source);
    if (!snap) continue;
    // Sin ninguna valoración la App Store da 0: se dice tal cual en vez de un 0,0 que parece una nota.
    if (d.id === 'rating' && snap.data.rating_count === 0) {
      cards.push({ id: d.id, label: d.label, value: 'Sin valoraciones', format: 'text', deltaPct: null, takenAt: snap.takenAt, source: d.source });
      continue;
    }
    const value = snap.data[d.id] ?? null;
    const ref = old.get(d.source);
    const before = ref && ref.id !== snap.id ? ref.data[d.id] : null;
    const deltaPct = typeof value === 'number' && typeof before === 'number' && before !== 0
      ? ((value - before) / Math.abs(before)) * 100 : null;
    const label = d.id === CONVERSION_KEY ? metrics?.posthogFunnel?.conversion?.label ?? d.label : d.label;
    if (d.id === CONVERSION_KEY && !Object.hasOwn(snap.data, CONVERSION_KEY)) continue;
    cards.push({ id: d.id, label, value, format: d.format, deltaPct, takenAt: snap.takenAt, source: d.source });
  }
  return cards;
}

const pct = (d: number) => d.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const trend = (d: number | null) => (d === null ? 'sin referencia de hace 7 días' : `${d >= 0 ? '+' : ''}${pct(d)} % frente a hace 7 días`);
const num = (v: unknown) => (typeof v === 'number' ? v : null);

export function metricsContext(store: Store, projectId: string, now: Date, metrics?: MetricsConfig): string | null {
  const cards = buildCards(store, projectId, now, metrics);
  if (cards.length === 0) return null;
  const lines = cards.map((c) => `- ${c.label}: ${c.value === null ? 'sin dato' : formatValue(c.value, c.format)} (${trend(c.deltaPct)})`);
  const ph = store.latestSnapshot(projectId, 'posthog', true);
  if (ph) {
    const funnel = Object.entries(ph.data).filter(([k, v]) => k !== CONVERSION_KEY && typeof v === 'number');
    if (funnel.length) lines.push(`- Embudo de los últimos 7 días (personas): ${funnel.map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  const as = store.latestSnapshot(projectId, 'appstore', true);
  if (as) {
    const extra = [
      num(as.data.downloads) !== null ? `descargas del último informe ${formatValue(num(as.data.downloads), 'int')}` : null,
      num(as.data.rating_count) ? `${formatValue(num(as.data.rating_count), 'int')} valoraciones` : null,
      typeof as.data.version === 'string' ? `versión pública ${as.data.version}` : null,
    ].filter(Boolean);
    if (extra.length) lines.push(`- App Store: ${extra.join(', ')}`);
  }
  const taken = cards.map((c) => c.takenAt).filter((t): t is string => !!t).sort().at(-1);
  if (taken) {
    const days = Math.floor((now.getTime() - Date.parse(taken)) / DAY);
    lines.push(`Última foto: ${taken}${days > 2 ? ` (foto de hace ${days} días)` : ''}`);
  }
  return lines.join('\n');
}
