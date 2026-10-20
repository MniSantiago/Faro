import { useState } from 'react';
import type { Task } from '../../server/types';
import { api } from '../api';

/** Formulario de las preguntas del agente: opciones como botones, «Otra respuesta» y texto libre. */
export function QuestionForm({ task, onDone, autoFocus = false }: { task: Task; onDone: () => void; autoFocus?: boolean }) {
  const qs = task.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string, opt: string, multiple?: boolean) => setPicked((p) => {
    const cur = p[id] ?? [];
    const next = multiple ? (cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt]) : [opt];
    return { ...p, [id]: next };
  });

  const answers: Record<string, string | string[]> = {};
  for (const q of qs) {
    const vals = [...(picked[q.id] ?? []), ...(other[q.id]?.trim() ? [other[q.id].trim()] : [])];
    if (vals.length) answers[q.id] = q.multiple ? vals : vals.join(', ');
  }
  const canSend = Object.keys(answers).length > 0 || text.trim() !== '';

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.answer(task.id, { answers, text: text.trim() || undefined });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qform">
      {qs.map((q, i) => (
        <fieldset key={q.id}>
          <legend>{q.text}</legend>
          {q.options && (
            <div className="options">
              {q.options.map((o, j) => {
                const on = (picked[q.id] ?? []).includes(o);
                return (
                  <button key={o} type="button" className={`opt${on ? ' on' : ''}`} aria-pressed={on}
                    autoFocus={autoFocus && i === 0 && j === 0} onClick={() => toggle(q.id, o, q.multiple)}>
                    {q.multiple ? (on ? '☑ ' : '☐ ') : ''}{o}
                  </button>
                );
              })}
            </div>
          )}
          <input value={other[q.id] ?? ''} onChange={(e) => setOther((p) => ({ ...p, [q.id]: e.target.value }))}
            placeholder={q.options ? 'Otra respuesta' : 'Tu respuesta'} aria-label={`Respuesta a: ${q.text}`}
            autoFocus={autoFocus && i === 0 && !q.options} />
        </fieldset>
      ))}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Algo más (opcional)" aria-label="Algo más" />
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy || !canSend} onClick={send}>Enviar</button>
    </div>
  );
}
