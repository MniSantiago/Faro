import { useEffect, useState } from 'react';
import { api, type HomeMetric, type MetricsView, type SeriesView } from '../api';
import { Funnel } from '../components/Funnel';
import { LineChart } from '../components/LineChart';
import { deltaTone, formatDelta, formatMetric, METRIC_FORMAT, rowFormat } from '../home';
import { useHomeProject } from './Home';

const TITLE: Record<HomeMetric, string> = { descargas: 'Descargas', conversion: 'Conversión', mrr: 'MRR', gasto: 'Gasto de Faro' };
const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];

/** Qué es el valor grande de cada cifra (ver `SeriesView.current`). */
const currentLabel = (metric: HomeMetric, days: number) =>
  metric === 'gasto' ? `Total de ${days} días` : metric === 'descargas' ? 'Últimos 7 días' : 'Ahora';

/** Vista de detalle de una cifra de la home (`#/inicio/<cifra>`): gráfica con periodo, valor, variación y desgloses. */
export function HomeDetail({ metric }: { metric: HomeMetric }) {
  const { projects, project, loaded, error: configError } = useHomeProject();
  const [days, setDays] = useState<Period>(30);
  const [series, setSeries] = useState<SeriesView | null>(null);
  const [metrics, setMetrics] = useState<MetricsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [funnelError, setFunnelError] = useState(false);
  const hasMetrics = projects.find((p) => p.id === project)?.metrics ?? false;

  useEffect(() => {
    if (!project) return;
    let ignore = false;
    setSeries(null);
    setError(null);
    api.homeSeries(project, metric, days).then((s) => { if (!ignore) { setSeries(s); setError(null); } })
      .catch((e: Error) => { if (!ignore) setError(e.message); });
    return () => { ignore = true; };
  }, [project, metric, days]);

  // El embudo es el de Métricas (últimos 7 días): no depende del periodo.
  useEffect(() => {
    if (!project || metric !== 'conversion' || !hasMetrics) return;
    let ignore = false;
    setFunnelError(false);
    api.metrics(project).then((v) => { if (!ignore) setMetrics(v); }).catch(() => { if (!ignore) setFunnelError(true); });
    return () => { ignore = true; };
  }, [project, metric, hasMetrics]);

  const err = configError ?? error;
  const back = <a href="#/" className="back">← Inicio</a>;
  if (err && !series) return <div className="home-detail">{back}<p className="error" role="alert">{err}</p></div>;
  if (loaded && !project) return <div className="home-detail">{back}<p className="muted">No hay proyectos en faro.config.ts.</p></div>;

  const format = METRIC_FORMAT[metric];
  const tone = series ? deltaTone(series.deltaPct, metric !== 'gasto') : 'muted';
  const delta = series ? formatDelta(series.deltaPct) : null;
  const funnel = metrics?.funnel;
  const ph = metrics?.status.find((s) => s.source === 'posthog')?.lastOk;

  return (
    <div className="home-detail">
      {back}
      <h1 className="page-head">{TITLE[metric]}</h1>
      <div className="detail-head">
        <div>
          <span className="tile-k">{currentLabel(metric, days)}</span>
          <strong className="detail-v">{series ? formatMetric(metric, series.current, format) : '…'}</strong>
          {delta && <span className={`tile-d ${tone}`}>{delta} vs semana pasada</span>}
        </div>
        <div className="aso-sorts" role="group" aria-label="Periodo">
          {PERIODS.map((d) => (
            <button key={d} type="button" className="chip" aria-pressed={d === days} onClick={() => setDays(d)}>{d} días</button>
          ))}
        </div>
      </div>
      {series?.note && (
        <p className="muted detail-note">
          {series.note}{series.note === 'Sin configurar' && <> · <a href="#/metricas">Configurar en Métricas →</a></>}
        </p>
      )}
      <section className="card">
        {series ? <LineChart points={series.points} metric={metric} format={format} zero={metric !== 'conversion' && metric !== 'mrr'} />
          : <p className="muted">Cargando…</p>}
      </section>
      {series?.breakdowns.map((b) => (
        <section key={b.title}>
          <h2>{b.title}</h2>
          {b.rows.length === 0 ? <p className="muted">Sin datos en este periodo.</p> : (
            <div className="aso-table-wrap">
              <table className="aso-table">
                <tbody>
                  {b.rows.map((r) => (
                    <tr key={r.label}><td>{r.label}</td><td className="num">{formatMetric(metric, r.value, rowFormat(metric, r.label))}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
      {metric === 'conversion' && funnelError && <p className="muted">No se pudo cargar el embudo</p>}
      {metric === 'conversion' && funnel && (
        <section>
          <h2>{funnel.title} (7 días)</h2>
          <Funnel funnel={funnel} ph={ph} />
        </section>
      )}
    </div>
  );
}
