import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useProject } from '../project';

export function NewChat() {
  const { projectId } = useProject();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const t = await api.createChat(projectId ?? '', text);
      location.hash = `/tarea/${t.id}`;
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <form className="form" onSubmit={submit}>
      <h1>Nuevo chat con el Coordinador</h1>
      <label>Tu mensaje<textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} required autoFocus
        placeholder="Qué quieres conseguir; el Coordinador propondrá las tareas" /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy || !text.trim()}>Empezar</button>
    </form>
  );
}
