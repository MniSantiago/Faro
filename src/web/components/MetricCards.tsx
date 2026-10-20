import { useEffect, useState } from 'react';
import type { Card } from '../../server/metrics/summary';
import { formatValue } from '../../shared/format';
import { api, type MetricsView } from '../api';

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export function MetricCard({ c }: { c: Card }) {
  const d = c.deltaPct !== null && Math.round(Math.abs(c.deltaPct) * 10) === 0 ? 0 : c.deltaPct;
  return (
    <div className="card metric">
      <span className="muted metric-label">{c.label}</span>
      <strong className="metric-value">{formatValue(c.value, c.format)}</strong>
      {d !== null && (
        <span className={`delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`}>
          {d > 0 ? '▲ ' : d < 0 ? '▼ ' : ''}{Math.abs(d).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %
        </span>
      )}
      <span className="muted metric-time">{time(c.takenAt)}</span>
    </div>
  );
}

export function useMetrics(): { view: MetricsView | null; project: string | null; loading: boolean; error: string | null; reload: () => void } {
  const [project, setProject] = useState<string | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [view, setView] = useState<MetricsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let ignore = false;
    setError(null);
    api.config()
      .then((c) => { if (!ignore) { setProject(c.projects.find((p) => p.metrics)?.id ?? null); setConfigLoaded(true); } })
      .catch((e: Error) => { if (!ignore) setError(e.message); });
    return () => { ignore = true; };
  }, [tick]);
  useEffect(() => {
    if (!project) return;
    let ignore = false;
    api.metrics(project).then((v) => { if (!ignore) { setView(v); setError(null); } }).catch((e: Error) => { if (!ignore) setError(e.message); });
    return () => { ignore = true; };
  }, [project, tick]);
  const loading = !error && (!configLoaded || (project !== null && view === null));
  return { view, project, loading, error, reload: () => setTick((t) => t + 1) };
}

export function MetricCards() {
  const { view, project } = useMetrics();
  if (!project || !view) return null;
  return (
    <section>
      <h2>Métricas <a href="#/metricas" className="btn small">Ver más</a></h2>
      {view.cards.length === 0 ? (
        <a href="#/metricas" className="card metric"><span className="muted metric-label">Métricas</span><strong>Sin configurar</strong></a>
      ) : (
        <div className="metrics-row">{view.cards.map((c) => <MetricCard key={c.id} c={c} />)}</div>
      )}
    </section>
  );
}
