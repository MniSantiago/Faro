import type { Snapshot } from '../../server/metrics/types';
import type { MetricsView } from '../api';

/** Embudo de PostHog (7 días): cada paso con su barra relativa al primero. `ph` es la última foto correcta de PostHog. */
export function Funnel({ funnel, ph }: { funnel: NonNullable<MetricsView['funnel']>; ph: Snapshot | null | undefined }) {
  if (!ph) return <p className="muted">PostHog aún no ha dado datos.</p>;
  const first = funnel.steps[0]?.event;
  const top = first && typeof ph.data[first] === 'number' ? (ph.data[first] as number) : 0;
  return (
    <div className="funnel">
      {funnel.steps.map(({ event: e, label }) => {
        const n = typeof ph.data[e] === 'number' ? (ph.data[e] as number) : 0;
        const pct = top > 0 ? (n / top) * 100 : 0;
        return (
          <div className="funnel-row" key={e}>
            <span className="funnel-name">{label}</span>
            <span className="funnel-track"><span className="funnel-bar" style={{ width: `${Math.min(100, pct)}%` }} /></span>
            <span className="funnel-n">{n.toLocaleString('es-ES')} · {pct.toLocaleString('es-ES', { maximumFractionDigits: 0 })} %</span>
          </div>
        );
      })}
    </div>
  );
}
