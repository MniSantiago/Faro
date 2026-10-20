import { useState } from 'react';
import { api, type PushState } from '../api';

const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;

/** Un aviso por proyecto con cambios sin subir: un solo botón sube todo y aprueba los push pendientes. */
export function PushBanner({ state, onPushed }: { state: PushState; onPushed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tasks = state.pending.length;
  const what = state.ahead > 0
    ? `${state.baseBranch} va ${commits(state.ahead)} por delante de ${state.remote}`
    : `${tasks} ${tasks === 1 ? 'tarea' : 'tareas'} con el push pendiente`;
  const push = () => {
    setBusy(true);
    setError(null);
    api.pushProject(state.id).then(onPushed).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <div className="banner push-banner" role="status">
      <span>
        <strong>{state.name}</strong>: {what}
        {error && <span className="error"> · {error}</span>}
      </span>
      <button className="btn" disabled={busy} onClick={push}>{busy ? 'Subiendo…' : 'Subir'}</button>
    </div>
  );
}
