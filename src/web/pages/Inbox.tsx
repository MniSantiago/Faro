import { useEffect, useRef, useState } from 'react';
import type { Spend, Task, TaskStats } from '../../server/types';
import { api, mergeTasks, subscribe, type PushState } from '../api';
import { PushBanner } from '../components/PushBanner';
import { TaskTree } from '../components/TaskCard';
import { formatUsd } from '../format';
import { inboxSections, taskTree } from '../inbox';
import { useProject } from '../project';

const ACTIVE = new Set<Task['state']>(['working', 'queued']);

export function Inbox() {
  const { projectId } = useProject();
  const project = projectId ?? undefined;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<Record<string, TaskStats>>({});
  const [spend, setSpend] = useState<Spend | null>(null);
  const [pushes, setPushes] = useState<PushState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const states = useRef(new Map<string, Task['state']>());

  useEffect(() => {
    let ignore = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loadStats = () => {
      api.stats(project).then((s) => { if (!ignore) { setStats(s.tasks); setSpend(s.spend); } }).catch(() => {});
      api.pushState(project).then((p) => { if (!ignore) setPushes(p.projects); }).catch(() => {});
    };
    // Al terminar una ejecución cambia el gasto: se vuelve a pedir, agrupando avisos seguidos.
    const loadStatsSoon = () => { clearTimeout(timer); timer = setTimeout(loadStats, 1000); };
    const refresh = () => {
      api.tasks(project).then((list) => {
        if (ignore) return;
        setError(null);
        for (const t of list) states.current.set(t.id, t.state);
        setTasks((prev) => mergeTasks(prev, list));
      }).catch((e: Error) => { if (!ignore) setError(e.message); });
      loadStats();
    };
    const off = subscribe((m) => {
      if (m.type === 'task') {
        if (project && m.task.projectId !== project) return;
        const before = states.current.get(m.task.id);
        states.current.set(m.task.id, m.task.state);
        if (before !== m.task.state && !ACTIVE.has(m.task.state)) loadStatsSoon();
        setTasks((prev) => mergeTasks(prev, [m.task]));
      } else if (m.type === 'stats') {
        setStats((prev) => ({ ...prev, [m.taskId]: m.stats }));
      }
    }, refresh);
    refresh();
    // Para que «● 6 min» avance sin esperar a un aviso del servidor.
    const tick = setInterval(() => setNow(new Date()), 30000);
    return () => { ignore = true; off(); clearTimeout(timer); clearInterval(tick); };
  }, [project]);

  if (error) return <p className="error" role="alert">{error}</p>;

  const s = inboxSections(tasks, now);
  const markQueued = (id: string) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, state: 'queued', questions: null } : t)));

  return (
    <div className="inbox">
      {pushes.map((p) => (
        <PushBanner key={p.id} state={p} onPushed={() => setPushes((prev) => prev.filter((x) => x.id !== p.id))} />
      ))}
      {spend && (
        <p className="spend">
          Hoy {formatUsd(spend.today)} · 7 días {formatUsd(spend.week)}{' '}
          <span className="note">equivalente API; tu plan no lo cobra</span>
        </p>
      )}
      <section>
        <h2 className="sec">Te necesita <span className="count">{s.need.length}</span></h2>
        {s.need.length === 0 ? <p className="muted">Nada pendiente.</p> : (
          <ul className="cards">
            <TaskTree nodes={taskTree(s.need, tasks)} section="need" stats={stats} now={now} onAnswered={markQueued} />
          </ul>
        )}
      </section>
      <section>
        <h2 className="sec">Trabajando <span className="count">{s.working.length}</span></h2>
        {s.working.length === 0 ? <p className="muted">Nada en marcha.</p> : (
          <ul className="cards">
            <TaskTree nodes={taskTree(s.working, tasks)} section="working" stats={stats} now={now} onAnswered={markQueued} />
          </ul>
        )}
      </section>
      <details className="done-today">
        <summary className="sec">Terminadas hoy <span className="count">{s.doneToday.length}</span></summary>
        {s.doneToday.length === 0 ? <p className="muted">Ninguna todavía.</p> : (
          <ul className="cards">
            <TaskTree nodes={taskTree(s.doneToday, tasks)} section="done" now={now} onAnswered={markQueued} />
          </ul>
        )}
        <p><a href="#/historial">Ver todas</a></p>
      </details>
    </div>
  );
}
