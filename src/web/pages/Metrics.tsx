import { useState } from 'react';
import { MetricCard, useMetrics } from '../components/MetricCards';
import { api } from '../api';

const FUNNEL: [string, string][] = [
  ['onboarding_iniciado', 'Onboarding iniciado'], ['permiso_tiempo_uso', 'Permiso concedido'], ['apps_elegidas', 'Apps elegidas'],
  ['onboarding_completado', 'Onboarding completado'], ['paywall_visto', 'Paywall visto'], ['compra_iniciada', 'Compra iniciada'],
  ['compra_completada', 'Compra completada'],
];

const KEYCHAIN_HELP: { account: string; text: string }[] = [
  { account: 'revenuecat', text: 'RevenueCat → Project settings → API keys: clave secreta v2 con permiso de solo lectura de Charts/métricas, nada más.' },
  { account: 'posthog', text: 'PostHog → Personal API keys: solo «Query: read» sobre tu proyecto.' },
  { account: 'asc-key-id', text: 'App Store Connect → Usuarios y acceso → Claves de API: el ID de una clave con el rol «Ventas» y ninguno más.' },
  { account: 'asc-issuer', text: 'App Store Connect → Claves de API: el Issuer ID que aparece arriba de la lista.' },
  { account: 'asc-p8', text: 'El contenido del archivo .p8 de esa clave (solo se puede descargar una vez).' },
];

// En el móvil la barra inferior no tiene «Dispositivos»: se llega desde aquí.
const devicesLink = <p className="mobile-only"><a href="#/dispositivos" className="chip">Dispositivos →</a> <a href="#/aso" className="chip">ASO →</a></p>;

const time = (iso: string) => new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Metrics() {
  const { view, project, loading, error: loadError, reload } = useMetrics();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.refreshMetrics();
      if (!r.ok) setError('La actualización tardó demasiado; vuelve a mirar en un minuto.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); reload(); }
  };

  if (loadError && !view) return <div>{devicesLink}<p className="error" role="alert">{loadError}</p><button className="btn" onClick={reload}>Reintentar</button></div>;
  if (loading) return <p className="muted">Cargando…</p>;
  if (!project || !view) return <div>{devicesLink}<p className="muted">Ningún proyecto tiene métricas en faro.config.ts.</p></div>;

  const ph = view.status.find((s) => s.source === 'posthog')?.lastOk;
  const top = typeof ph?.data.onboarding_iniciado === 'number' ? ph.data.onboarding_iniciado : 0;

  return (
    <div className="inbox">
      {devicesLink}
      <h1>Métricas <button className="btn small" onClick={refresh} disabled={busy}>{busy ? 'Actualizando…' : 'Actualizar ahora'}</button></h1>
      {error && <p className="error" role="alert">{error}</p>}
      <section>
        <h2>Resumen</h2>
        {view.cards.length === 0 ? <p className="muted">Sin configurar: añade las claves del llavero (abajo) y pulsa «Actualizar ahora».</p>
          : <div className="metrics-row">{view.cards.map((c) => <MetricCard key={c.id} c={c} />)}</div>}
      </section>
      <section>
        <h2>Embudo de onboarding (7 días)</h2>
        {!ph ? <p className="muted">PostHog aún no ha dado datos.</p> : (
          <div className="funnel">
            {FUNNEL.map(([e, label]) => {
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
        )}
      </section>
      <section>
        <h2>Fuentes</h2>
        <ul className="routines">
          {view.status.map((s) => (
            <li key={s.source} className="card">
              <div className="row">
                <strong>{s.label}</strong>
                <span className="muted">{s.configured === false ? 'Sin configurar' : s.configured === true ? 'Configurada' : 'Sin datos todavía'}</span>
              </div>
              {s.lastOk && <p className="muted">Última foto correcta: {time(s.lastOk.takenAt)}</p>}
              {s.last && !s.last.ok && <p className="error">Último error ({time(s.last.takenAt)}): {s.last.error}</p>}
              {s.lastOk && typeof s.lastOk.data.notes === 'string' && <p className="muted">{s.lastOk.data.notes}</p>}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Claves en el llavero</h2>
        <p className="muted">Faro nunca te pide ni guarda claves: ejecútalo tú en la Terminal del Mac y pega la clave cuando la pida.</p>
        <p className="muted">
          <strong>Ojo:</strong> los agentes de nivel 2 o más corren como tu usuario y podrían leer estas claves (es un límite del llavero
          de macOS; Faro solo les impide usar la herramienta <code>security</code>). Crea claves de solo lectura con el mínimo permiso
          que se indica abajo y, si un agente hace algo raro, rótalas.
        </p>
        <ul className="routines">
          {KEYCHAIN_HELP.map((k) => (
            <li key={k.account} className="card">
              <code>{view.keychain[k.account]}</code>
              <p className="muted">{k.text}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
