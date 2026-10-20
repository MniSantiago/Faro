import { useState } from 'react';
import type { Task } from '../../server/types';
import { api } from '../api';
import { composerMode } from '../thread';

export function Composer({ task, onSent }: { task: Task; onSent: () => void }) {
  const mode = composerMode(task);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!mode.enabled) {
    return (task.state === 'done' || task.state === 'discarded') && task.kind === 'task'
      ? <div className="composer off"><a className="btn" href={`#/nueva?desde=${task.id}`}>Nueva tarea a partir de esta</a></div>
      : null;
  }

  const send = async (interrupt: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.message(task.id, text, interrupt);
      setText('');
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder={mode.placeholder} aria-label="Mensaje"
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && !busy) send(false); }} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn primary" disabled={busy || !text.trim()} onClick={() => send(false)}>{mode.send}</button>
        {mode.canInterrupt && <button className="btn" disabled={busy || !text.trim()} onClick={() => send(true)}>Interrumpir y enviar</button>}
      </div>
    </div>
  );
}
