import { useCallback, useEffect, useState } from 'react';
import { api, type AsoCompetitorView, type AsoObservationView, type AsoProposalView, type AsoView } from '../api';
import { useCurrentProject, useProject } from '../project';
import { charCount, competitorChanges, formatDelta, formatRank, showSubtitle, sortKeywords, type KeywordRow, type SortBy } from '../aso';

const STORE_KEY = 'faro.aso.store';
const STORE_LABEL: Record<string, string> = { es: 'España (es)', 'es-MX': 'México (es-MX)', en: 'Inglés (en)' };

const time = (iso: string) => new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });

function loadStore(): string | null {
  try { return localStorage.getItem(STORE_KEY); } catch { return null; }
}
function saveStore(id: string) {
  try { localStorage.setItem(STORE_KEY, id); } catch { /* sin almacenamiento: no se recuerda */ }
}

const SORTS: [SortBy, string][] = [['oportunidad', 'Oportunidad'], ['popularidad', 'Popularidad'], ['dificultad', 'Dificultad'], ['puesto', 'Puesto']];

function proposalText(p: AsoProposalView): string {
  const k = String(p.payload.keyword ?? '');
  if (p.kind === 'follow') return `Seguir «${k}»`;
  if (p.kind === 'unfollow') return `Dejar de seguir «${k}»`;
  if (p.kind === 'competitor') return `Seguir al competidor ${String(p.payload.name ?? p.payload.appId ?? '')}`;
  return 'Cambio de ficha';
}

/** Puestos del histórico como línea SVG (el 1 arriba). Con menos de dos puntos no hay línea. */
function Sparkline({ ranks }: { ranks: number[] }) {
  if (ranks.length < 2) return null;
  const w = 160, h = 36;
  const min = Math.min(...ranks), max = Math.max(...ranks);
  const span = max - min || 1;
  const pts = ranks.map((r, i) => `${(i / (ranks.length - 1)) * w},${2 + ((r - min) / span) * (h - 4)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label="Evolución del puesto">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function KeywordHistory({ id }: { id: number }) {
  const [rows, setRows] = useState<AsoObservationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let ignore = false;
    api.asoHistory(id).then((r) => { if (!ignore) setRows(r); }).catch((e: Error) => { if (!ignore) setError(e.message); });
    return () => { ignore = true; };
  }, [id]);
  if (error) return <p className="error">{error}</p>;
  if (!rows) return <p className="muted">Cargando histórico…</p>;
  const ranked = rows.filter((o) => o.ok && o.rank !== null);
  if (ranked.length === 0) return <p className="muted">Sin puestos registrados en los últimos 90 días.</p>;
  return (
    <div className="aso-history">
      <Sparkline ranks={ranked.map((o) => o.rank as number)} />
      <ul className="muted">
        {ranked.slice(-8).reverse().map((o) => <li key={o.takenAt}>{day(o.takenAt)}: puesto {o.rank}</li>)}
      </ul>
    </div>
  );
}

function Keywords({ rows, onChange, onAdd }: { rows: KeywordRow[]; onChange: () => void; onAdd: (text: string) => Promise<void> }) {
  const [by, setBy] = useState<SortBy>('oportunidad');
  const [open, setOpen] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true); setError(null);
    try { await onAdd(text.trim()); setText(''); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const archive = async (k: KeywordRow) => {
    setError(null);
    try { await api.asoArchiveKeyword(k.id); onChange(); } catch (err) { setError((err as Error).message); }
  };

  return (
    <section>
      <h2>Keywords</h2>
      <div className="aso-sorts" role="group" aria-label="Ordenar por">
        {SORTS.map(([id, label]) => (
          <button key={id} type="button" className="chip" aria-pressed={by === id} onClick={() => setBy(id)}>{label}</button>
        ))}
      </div>
      {rows.length === 0 ? <p className="muted">Todavía no sigues ninguna keyword en esta tienda.</p> : (
        <div className="aso-table-wrap">
          <table className="aso-table">
            <thead><tr><th>Keyword</th><th>Pop.</th><th>Dif.</th><th>Puesto</th><th>7 días</th><th /></tr></thead>
            <tbody>
              {sortKeywords(rows, by).map((k) => (
                <KeywordRowView key={k.id} k={k} open={open === k.id} onToggle={() => setOpen(open === k.id ? null : k.id)} onArchive={() => archive(k)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="aso-inline" onSubmit={add}>
        <input aria-label="Añadir keyword" placeholder="Añadir keyword" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn" disabled={busy || !text.trim()}>Añadir</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function KeywordRowView({ k, open, onToggle, onArchive }: { k: KeywordRow; open: boolean; onToggle: () => void; onArchive: () => void }) {
  return (
    <>
      <tr className={open ? 'open' : undefined}>
        <td>
          <button type="button" className="linklike" aria-expanded={open} onClick={onToggle}>{k.text}</button>
          {k.inFicha && <span className="badge in-ficha">en la ficha</span>}
          {!k.ok && k.takenAt && <span className="muted"> · sin datos</span>}
        </td>
        <td>{k.popularity ?? '—'}</td>
        <td>{k.difficulty ?? '—'}</td>
        <td>{formatRank(k.rank)}</td>
        <td className={k.rankDelta7 === null ? undefined : k.rankDelta7 > 0 ? 'worse' : k.rankDelta7 < 0 ? 'better' : undefined}>{formatDelta(k.rankDelta7)}</td>
        <td><button type="button" className="btn small" onClick={onArchive} aria-label={`Archivar ${k.text}`}>Archivar</button></td>
      </tr>
      {open && <tr className="aso-detail"><td colSpan={6}><KeywordHistory id={k.id} /></td></tr>}
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setMsg('Copiado'); } catch { setMsg('No se pudo copiar: selecciónalo a mano'); }
    setTimeout(() => setMsg(null), 2500);
  };
  return <><button type="button" className="btn small" onClick={copy}>Copiar</button>{msg && <span className="muted" role="status"> {msg}</span>}</>;
}

function Ficha({ view, onDecide, busy }: { view: AsoView['ficha']; onDecide: (id: number, d: 'accepted' | 'rejected') => void; busy: boolean }) {
  const { current, proposal } = view;
  const fields: ['name' | 'subtitle' | 'keywords', string, number][] = [['name', 'Nombre', 30], ['subtitle', 'Subtítulo', 30], ['keywords', 'Palabras clave', 100]];
  return (
    <section>
      <h2>Ficha</h2>
      <h3>Actual</h3>
      {!current ? <p className="muted">Ficha actual no disponible.</p> : (
        <dl className="aso-ficha">
          {fields.map(([f, label]) => (
            <div key={f}>
              <dt>{label}{current.sources[f] && <span className="muted"> · {current.sources[f]}</span>}</dt>
              <dd>{current[f] ?? <span className="muted">—</span>}</dd>
            </div>
          ))}
        </dl>
      )}
      {proposal && (
        <>
          <h3>Propuesta</h3>
          <p className="muted">{proposal.why}</p>
          <dl className="aso-ficha">
            {fields.map(([f, label, limit]) => {
              const v = typeof proposal.payload[f] === 'string' ? (proposal.payload[f] as string) : '';
              const c = charCount(v, limit);
              return (
                <div key={f}>
                  <dt>{label} <span className={c.over ? 'error' : 'muted'}>{c.n}/{limit}</span></dt>
                  <dd>{v || <span className="muted">—</span>} {v && <CopyButton text={v} />}</dd>
                </div>
              );
            })}
          </dl>
          <div className="actions">
            <button className="btn primary" disabled={busy} onClick={() => onDecide(proposal.id, 'accepted')}>Aceptar</button>
            <button className="btn" disabled={busy} onClick={() => onDecide(proposal.id, 'rejected')}>Rechazar</button>
          </div>
        </>
      )}
    </section>
  );
}

function Competitors({ project, rows, onChange }: { project: string; rows: AsoCompetitorView[]; onChange: () => void }) {
  const [appId, setAppId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.asoAddCompetitor(project, appId.trim(), name.trim()); setAppId(''); setName(''); onChange(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const archive = async (c: AsoCompetitorView) => {
    setError(null);
    try { await api.asoArchiveCompetitor(c.id); onChange(); } catch (err) { setError((err as Error).message); }
  };
  return (
    <section>
      <h2>Competidores</h2>
      {rows.length === 0 ? <p className="muted">Sin competidores.</p> : (
        <ul className="routines">
          {rows.map((c) => {
            const changes = competitorChanges(c.changes);
            return (
              <li key={c.id} className="card">
                <div className="row">
                  <strong>{c.current?.name || c.name}</strong>
                  <button type="button" className="btn small" onClick={() => archive(c)} aria-label={`Archivar ${c.name}`}>Archivar</button>
                </div>
                <p className="muted">
                  {c.current ? `${showSubtitle(c.current.subtitle)}${c.current.version ? ` · versión ${c.current.version}` : ''}` : 'Sin datos todavía'}
                </p>
                {changes.length > 0 && (
                  <ul className="aso-changes muted">
                    {changes.map((ch) => <li key={ch.takenAt}>{day(ch.takenAt)}: {ch.text}</li>)}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form className="aso-inline" onSubmit={add}>
        <input aria-label="appId del competidor" placeholder="appId (número)" inputMode="numeric" value={appId} onChange={(e) => setAppId(e.target.value)} />
        <input aria-label="Nombre del competidor" placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={busy || !appId.trim() || !name.trim()}>Añadir</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

export function Aso() {
  // Solo el proyecto actual, y solo si tiene ASO.
  const cur = useCurrentProject();
  const project = cur?.aso ? cur.id : null;
  const many = useProject().projects.length > 1;
  const [storeId, setStoreId] = useState<string | null>(loadStore);
  const [view, setView] = useState<AsoView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  // Una tienda recordada que ya no existe cae a la primera de la respuesta.
  const effectiveStore = view && !view.stores.some((s) => s.id === storeId) ? view.stores[0]?.id ?? null : storeId;
  const query = effectiveStore ?? loadStore() ?? 'es';

  useEffect(() => {
    if (!project) return;
    let ignore = false;
    api.aso(project, query)
      .then((v) => { if (!ignore) { setView(v); setError(null); } })
      .catch((e: Error) => {
        if (ignore) return;
        // Tienda recordada que ya no existe: se vuelve a la de por defecto.
        if (e.message === 'Tienda desconocida' && query !== 'es') { setStoreId('es'); return; }
        setError(e.message);
      });
    return () => { ignore = true; };
  }, [project, query, tick]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setActionError(null);
    try { await fn(); } catch (e) { setActionError((e as Error).message); } finally { setBusy(false); reload(); }
  };

  const pickStore = (id: string) => { setStoreId(id); saveStore(id); setView(null); };

  if (error && !view) return <div className="inbox"><p className="error" role="alert">{error}</p><button className="btn" onClick={reload}>Reintentar</button></div>;
  if (project && !view) return <p className="muted">Cargando…</p>;
  if (!project || !view) return <div><p className="muted">{many ? 'Este proyecto no tiene ASO en faro.config.ts.' : 'Ningún proyecto tiene ASO en faro.config.ts.'}</p></div>;

  const pending = view.pending;
  const refresh = () => run(async () => {
    const r = await api.asoRefresh();
    if (!r.ok) setActionError('La recogida tardó demasiado; vuelve a mirar en un minuto.');
  });

  return (
    <div className="inbox aso">
      <h1>ASO <button className="btn small" onClick={refresh} disabled={busy}>{busy ? 'Actualizando…' : 'Actualizar'}</button></h1>
      <div className="aso-sorts" role="group" aria-label="Tienda">
        {view.stores.map((s) => (
          <button key={s.id} type="button" className="chip" aria-pressed={s.id === effectiveStore} onClick={() => pickStore(s.id)}>{STORE_LABEL[s.id] ?? s.id}</button>
        ))}
      </div>
      <p className="muted">
        {view.lastRun ? `Última recogida: ${time(view.lastRun.at)}` : 'Todavía no hay ninguna recogida.'}
        {view.lastRun && !view.lastRun.ok && <span className="error"> · Error: {view.lastRun.error ?? 'desconocido'}</span>}
      </p>
      <p className="muted note">Popularidad y dificultad son estimaciones (0-100), no búsquedas reales.</p>
      {error && <p className="error" role="alert">No se pudo actualizar la vista: {error} <button className="btn small" onClick={reload}>Reintentar</button></p>}
      {actionError && <p className="error" role="alert">{actionError}</p>}

      {pending.length > 0 && (
        <section>
          <h2>Pendiente de revisar <button className="btn small" disabled={busy} onClick={() => run(() => api.asoAcceptAll(project, query))}>Aceptar todas</button></h2>
          <ul className="routines">
            {pending.map((p) => (
              <li key={p.id} className="card">
                <strong>{proposalText(p)}</strong>
                <p className="muted">{p.why}</p>
                <div className="actions">
                  <button className="btn primary small" disabled={busy} onClick={() => run(() => api.asoDecide(p.id, 'accepted'))}>Aceptar</button>
                  <button className="btn small" disabled={busy} onClick={() => run(() => api.asoDecide(p.id, 'rejected'))}>Rechazar</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Keywords rows={view.keywords} onChange={reload} onAdd={async (text) => { await api.asoAddKeyword(project, query, text); reload(); }} />
      <Ficha view={view.ficha} busy={busy} onDecide={(id, d) => run(() => api.asoDecide(id, d))} />
      <Competitors project={project} rows={view.competitors} onChange={reload} />
    </div>
  );
}
