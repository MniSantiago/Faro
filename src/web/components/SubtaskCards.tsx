import { useCallback, useEffect, useState } from 'react';
import type { Level, Task } from '../../server/types';
import { api, LEVEL_LABEL, mergeTasks, STATE_LABEL, subscribe } from '../api';

export function SubtaskCards({ parentId }: { parentId: string }) {
  const [kids, setKids] = useState<Task[]>([]);
  const [levels, setLevels] = useState<Record<string, Level>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { api.children(parentId).then((l) => setKids((p) => mergeTasks(p, l))).catch(() => {}); }, [parentId]);
  useEffect(() => subscribe((m) => {
    if (m.type === 'task' && m.task.parentId === parentId) setKids((p) => mergeTasks(p, [m.task]));
  }, load), [parentId, load]);
  useEffect(load, [load]);

  if (kids.length === 0) return null;
  const drafts = kids.filter((k) => k.state === 'draft');
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const approve = (k: Task) => api.queueDraft(k.id, levels[k.id] ?? k.level);

  return (
    <section className="subtasks">
      <h2>Subtareas</h2>
      {error && <p className="error" role="alert">{error}</p>}
      <ul>
        {kids.map((k) => (
          <li key={k.id} className="card">
            <div className="row">
              <a href={`#/tarea/${k.id}`}><span className="id">{k.id}</span> {k.title}</a>
              <span className={`badge ${k.state}`}>{STATE_LABEL[k.state]}</span>
            </div>
            <p className="meta">{k.profileId}</p>
            {k.description && <details><summary>Descripción</summary><p className="desc">{k.description}</p></details>}
            {k.state === 'draft' && (
              <div className="actions">
                <select value={levels[k.id] ?? k.level} aria-label={`Nivel de ${k.id}`}
                  onChange={(e) => setLevels((p) => ({ ...p, [k.id]: Number(e.target.value) as Level }))}>
                  {/* Hasta 3, o el nivel del borrador si es mayor (el de un conflicto de una tarea de nivel 4). */}
                  {([1, 2, 3, 4] as Level[]).filter((l) => l <= Math.max(3, k.level)).map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                </select>
                <button className="btn primary" disabled={busy} onClick={() => run(() => approve(k))}>Aprobar y encolar</button>
                <button className="btn danger" disabled={busy} onClick={() => run(() => api.discard(k.id))}>Descartar</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {drafts.length > 1 && (
        <button className="btn" disabled={busy} onClick={() => run(async () => { for (const k of drafts) await approve(k); })}>Aprobar todas ({drafts.length})</button>
      )}
    </section>
  );
}
