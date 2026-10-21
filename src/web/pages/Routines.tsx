import { useCallback, useEffect, useState } from 'react';
import { api, STATE_LABEL, subscribe, type RoutineView } from '../api';
import { describeCron } from '../cron';
import { useProject } from '../project';

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export function Routines() {
  const { projectId } = useProject();
  const project = projectId ?? undefined;
  const [list, setList] = useState<RoutineView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => { api.routines(project).then(setList).catch((e: Error) => setError(e.message)); }, [project]);
  useEffect(() => subscribe((m) => { if (m.type === 'task' && m.task.routineId && (!project || m.task.projectId === project)) load(); }, load), [load, project]);
  useEffect(load, [load]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setError(null);
    try { await fn(); load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  if (!list) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">Cargando…</p>;
  return (
    <div>
      <h1>Rutinas</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {list.length === 0 && <p className="muted">No hay rutinas en la configuración.</p>}
      <ul className="routines">
        {list.map((r) => (
          <li key={r.id} className="card">
            <div className="row">
              <strong>{r.name}</strong>
              <span className={`badge ${r.enabled ? 'working' : ''}`}>{r.enabled ? 'Activa' : 'Pausada'}</span>
            </div>
            <p className="meta">
              <span>{describeCron(r.cron)}</span>
              {r.enabled && r.cron && <span>Próxima: {fmt(r.nextRunAt)}</span>}
              <span>{r.profileId} · nivel {r.level}{r.draft ? ' · borrador' : ''}</span>
            </p>
            {r.lastSkipReason && <p className="reason">Última omitida: {r.lastSkipReason}</p>}
            {r.recent.length > 0 && (
              <ul className="recent">
                {r.recent.map((t) => <li key={t.id}><a href={`#/tarea/${t.id}`}><span className="id">{t.id}</span> {STATE_LABEL[t.state]}</a></li>)}
              </ul>
            )}
            <div className="actions">
              <button className="btn primary" disabled={busy === r.id} onClick={() => act(r.id, () => api.runRoutine(r.id))}>Ejecutar ahora</button>
              <button className="btn" disabled={busy === r.id} onClick={() => act(r.id, () => api.toggleRoutine(r.id))}>{r.enabled ? 'Pausar' : 'Activar'}</button>
              <a className="btn" href={`#/config/rutinas/${encodeURIComponent(r.id)}`}>Editar</a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
