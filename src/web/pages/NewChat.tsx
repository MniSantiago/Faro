import { useEffect, useState, type FormEvent } from 'react';
import { api, type ConfigView } from '../api';

export function NewChat() {
  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [projectId, setProjectId] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.config().then((c) => { setCfg(c); setProjectId(c.projects[0]?.id ?? ''); }).catch((e: Error) => setError(e.message)); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const t = await api.createChat(projectId, text);
      location.hash = `/tarea/${t.id}`;
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  if (!cfg) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">Cargando…</p>;
  return (
    <form className="form" onSubmit={submit}>
      <h1>Nuevo chat con el Coordinador</h1>
      {cfg.projects.length > 1 && (
        <label>Proyecto
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {cfg.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
      <label>Tu mensaje<textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} required autoFocus
        placeholder="Qué quieres conseguir; el Coordinador propondrá las tareas" /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy || !text.trim()}>Empezar</button>
    </form>
  );
}
