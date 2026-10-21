import { useEffect, useState } from 'react';
import type { Task } from '../../server/types';
import { api, mergeTasks, STATE_LABEL, subscribe } from '../api';
import { chatList, loadSeen, SEEN_EVENT, seedSeenIfMissing, unreadChats } from '../chats';
import { useProject } from '../project';

const excerpt = (s: string) => (s.length > 140 ? `${s.slice(0, 140)}…` : s);

/** Chats con el Coordinador: lista (más recientes primero, con punto si hay respuesta sin leer) y botón «Nuevo chat». */
export function Chats() {
  const { projectId } = useProject();
  const project = projectId ?? undefined;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<Record<string, string>>(loadSeen);

  useEffect(() => {
    let ignore = false;
    const refresh = () => {
      api.tasks(project).then((list) => {
        if (ignore) return;
        seedSeenIfMissing(list);
        setError(null);
        setLoaded(true);
        setTasks((prev) => mergeTasks(prev, list));
      }).catch((e: Error) => { if (!ignore) setError(e.message); });
    };
    const off = subscribe((m) => { if (m.type === 'task' && (!project || m.task.projectId === project)) setTasks((prev) => mergeTasks(prev, [m.task])); }, refresh);
    refresh();
    const onSeen = () => setSeen(loadSeen());
    window.addEventListener(SEEN_EVENT, onSeen);
    return () => { ignore = true; off(); window.removeEventListener(SEEN_EVENT, onSeen); };
  }, [project]);

  if (error) return <p className="error" role="alert">{error}</p>;

  const chats = chatList(tasks);
  const unread = new Set(unreadChats(chats, seen));

  return (
    <div className="inbox">
      <h1 className="page-head">Chats <a href="#/chat/nuevo" className="btn primary small">Nuevo chat</a></h1>
      {!loaded ? <p className="muted">Cargando…</p>
        : chats.length === 0 ? <p className="muted">Habla con el Coordinador para planificar trabajo.</p> : (
          <ul className="cards">
            {chats.map((t) => (
              <li key={t.id} className={`card${unread.has(t.id) ? ' unread' : ''}`}>
                <a className="row" href={`#/tarea/${t.id}`}>
                  {unread.has(t.id) && <span className="dot" aria-label="sin leer" />}
                  <span className="title">{t.title}</span>
                  <span className={`pill${t.state === 'working' ? ' g' : t.state === 'blocked' ? ' a' : ''}`}>{STATE_LABEL[t.state]}</span>
                </a>
                {t.summary && <p className="sub">{excerpt(t.summary)}</p>}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
