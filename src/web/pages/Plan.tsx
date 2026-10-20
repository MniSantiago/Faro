import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type ConfigView, type PlanState } from '../api';

const fecha = (iso: string) => (iso ? new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) : '');

/** «Plan»: pendientes (el mismo backlog que el plugin de Claude Code), lo hecho sin enviar a la tienda y lo que falta probar. */
export function Plan() {
  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [projectId, setProjectId] = useState('');
  const [state, setState] = useState<PlanState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback((pid: string) => {
    api.plan(pid).then((s) => { setState(s); setError(null); }).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    api.config().then((c) => {
      setCfg(c);
      const pid = c.projects[0]?.id ?? '';
      setProjectId(pid);
      if (pid) load(pid);
    }).catch((e: Error) => setError(e.message));
  }, [load]);

  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    fn().then(() => load(projectId)).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    act(() => api.planAdd(projectId, text).then(() => setText('')));
  };

  if (error && !state) return <p className="error" role="alert">{error}</p>;
  if (!state) return <p className="muted">Cargando…</p>;

  const open = state.backlog?.filter((i) => !i.isDone) ?? [];
  const doneItems = state.backlog?.filter((i) => i.isDone) ?? [];
  const toTest = state.unshipped.filter((u) => u.taskId && u.touchesApp && !u.tested);
  const tested = state.unshipped.filter((u) => u.taskId && u.touchesApp && u.tested);
  const b = state.build;

  return (
    <div className="plan">
      <div className="page-head">
        <h1>Plan</h1>
        {cfg && cfg.projects.length > 1 && (
          <select value={projectId} onChange={(e) => { setProjectId(e.target.value); load(e.target.value); }}>
            {cfg.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {state.github && (
        <section className="plan-github">
          <h2 className="sec">GitHub</h2>
          <p className="plan-ci">
            {state.github.ci ? (
              <a href={state.github.ci.url} target="_blank" rel="noreferrer" className={`pill ${state.github.ci.state === 'success' ? 'g' : state.github.ci.state === 'failure' ? 'r' : 'a'}`}>
                CI de main: {state.github.ci.state === 'success' ? 'en verde' : state.github.ci.state === 'failure' ? 'falla' : 'en curso'}
              </a>
            ) : <span className="muted">Sin datos del CI de main.</span>}
            {state.github.ci && <span className="muted"> · <code>{state.github.ci.sha.slice(0, 7)}</code> · {state.github.ci.workflows.join(', ')}</span>}
            {state.github.error && <span className="error"> · {state.github.error}</span>}
          </p>
          {state.github.prs.length === 0 ? <p className="muted">No hay PR abiertos.</p> : (
            <ul className="plan-list">
              {state.github.prs.map((pr) => (
                <li key={pr.number}>
                  <a className="id" href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a>
                  <span className="text">{pr.title}</span>
                  {pr.isDraft && <span className="pill">borrador</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <h2 className="sec">Pendientes <span className="count">{open.length}</span></h2>
        {state.backlog === null ? (
          <p className="muted">{state.backlogError ?? 'Este proyecto no tiene backlog configurado (backlogFile).'}</p>
        ) : (
          <>
            <form className="plan-add" onSubmit={add}>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Añadir un pendiente…" aria-label="Nuevo pendiente" maxLength={240} />
              <button className="btn" disabled={busy || !text.trim()}>Añadir</button>
            </form>
            {open.length === 0 ? <p className="muted">Nada pendiente.</p> : (
              <ul className="plan-list">
                {open.map((i) => (
                  <li key={i.id}>
                    <input type="checkbox" checked={false} disabled={busy} aria-label={`Marcar #${i.id} como hecho`}
                      onChange={() => act(() => api.planDone(projectId, i.id, true))} />
                    <span className="id">#{i.id}</span>
                    <span className="text">{i.text}</span>
                    <a className="chip" href={`#/nueva?titulo=${encodeURIComponent(i.text)}`}>Crear tarea</a>
                  </li>
                ))}
              </ul>
            )}
            {doneItems.length > 0 && (
              <details>
                <summary className="muted">Hechos ({doneItems.length})</summary>
                <ul className="plan-list done">
                  {doneItems.map((i) => (
                    <li key={i.id}>
                      <input type="checkbox" checked disabled={busy} aria-label={`Reabrir #${i.id}`}
                        onChange={() => act(() => api.planDone(projectId, i.id, false))} />
                      <span className="id">#{i.id}</span>
                      <span className="text">{i.text}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>

      <section>
        <h2 className="sec">Sin enviar a la tienda <span className="count">{state.unshipped.length}</span></h2>
        <p className="muted plan-build">
          {b ? <>Desde la {b.version} (build {b.buildNumber}, {fecha(b.createdAt)}, commit <code>{b.commit.slice(0, 7)}</code>)</> : 'No se conoce el último build de la tienda.'}
          {' '}<button className="link" disabled={busy} onClick={() => act(() => api.planRefresh(projectId))}>Actualizar</button>
          {state.buildError && <span className="error"> · EAS: {state.buildError}</span>}
        </p>
        {state.unshippedError && <p className="error">{state.unshippedError}</p>}
        {b && state.unshipped.length === 0 && !state.unshippedError && <p className="muted">Todo lo integrado ya está en el último build.</p>}
        {state.unshipped.length > 0 && (
          <ul className="plan-list">
            {state.unshipped.map((u) => (
              <li key={u.taskId ?? `${u.title}-${u.lastAt}`}>
                {u.taskId ? <a className="id" href={`#/tarea/${u.taskId}`}>{u.taskId}</a> : <span className="id">commit</span>}
                <span className="text">{u.title}</span>
                {u.touchesApp && <span className="pill">app</span>}
                <span className="when">{fecha(u.lastAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="sec">Por probar en el iPhone <span className="count">{toTest.length}</span></h2>
        <p className="muted plan-build">Lo de la app que está integrado y aún no has probado en un dispositivo.</p>
        {toTest.length === 0 ? <p className="muted">Nada por probar.</p> : (
          <ul className="plan-list">
            {toTest.map((u) => (
              <li key={u.taskId}>
                <input type="checkbox" checked={false} disabled={busy} aria-label={`Marcar ${u.taskId} como probado`}
                  onChange={() => act(() => api.planTested(projectId, u.taskId!, true))} />
                <a className="id" href={`#/tarea/${u.taskId}`}>{u.taskId}</a>
                <span className="text">{u.title}</span>
              </li>
            ))}
          </ul>
        )}
        {tested.length > 0 && (
          <details>
            <summary className="muted">Probados ({tested.length})</summary>
            <ul className="plan-list done">
              {tested.map((u) => (
                <li key={u.taskId}>
                  <input type="checkbox" checked disabled={busy} aria-label={`Desmarcar ${u.taskId}`}
                    onChange={() => act(() => api.planTested(projectId, u.taskId!, false))} />
                  <a className="id" href={`#/tarea/${u.taskId}`}>{u.taskId}</a>
                  <span className="text">{u.title}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}
