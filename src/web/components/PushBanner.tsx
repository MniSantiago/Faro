import { useState } from 'react';
import { api, type PushState } from '../api';
import { pushSummary } from '../push-state';

/** Un aviso por proyecto con cambios sin subir: un solo botón sube todo y aprueba los push pendientes. */
export function PushBanner({ state, onPushed }: { state: PushState; onPushed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const what = pushSummary(state);
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
