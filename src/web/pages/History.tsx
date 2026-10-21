import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task } from '../../server/types';
import { api, STATE_LABEL } from '../api';
import { useProject } from '../project';

const PAGE = 50;
const when = (iso: string) => new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Historial: tareas hechas y descartadas, más recientes primero, de 50 en 50. */
export function History() {
  const { projectId } = useProject();
  const project = projectId ?? undefined;
  const [items, setItems] = useState<Task[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback((offset: number) => {
    setLoading(true);
    setError(null);
    api.history(offset, project).then((page) => {
      if (!alive.current) return;
      setItems((prev) => {
        const ids = new Set(prev.map((t) => t.id));
        return [...prev, ...page.filter((t) => !ids.has(t.id))];
      });
      setMore(page.length === PAGE);
    }).catch((e: Error) => { if (alive.current) setError(e.message); })
      .finally(() => { if (alive.current) setLoading(false); });
  }, [project]);

  useEffect(() => {
    alive.current = true;
    load(0);
    return () => { alive.current = false; };
  }, [load]);

  return (
    <div className="inbox">
      <a href="#/bandeja" className="back">← Bandeja</a>
      <h1>Historial</h1>
      {items.length === 0 && !loading && !error && <p className="muted">Todavía no hay tareas terminadas.</p>}
      {items.length > 0 && (
        <ul className="cards">
          {items.map((t) => (
            <li key={t.id} className="card done">
              <a className="row" href={`#/tarea/${t.id}`}>
                <span className="id">{t.id}</span>
                <span className="title">{t.title}</span>
                <span className="pill">{STATE_LABEL[t.state]}</span>
              </a>
              <p className="sub">{t.kind === 'chat' ? 'Chat · ' : ''}{when(t.updatedAt)}</p>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {loading ? <p className="muted">Cargando…</p>
        : (more || error) && <p><button className="btn" onClick={() => load(items.length)}>{error ? 'Reintentar' : 'Cargar más'}</button></p>}
    </div>
  );
}
