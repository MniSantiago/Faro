import { useState, type ReactNode } from 'react';
import type { Task, TaskStats } from '../../server/types';
import { api, STATE_LABEL } from '../api';
import { contextLevel, formatUsd } from '../format';
import { elapsed, inlineQuestion, type TaskNode } from '../inbox';

export type CardSection = 'need' | 'working' | 'done';

function pill(task: Task, section: CardSection, now: Date): { text: string; tone: 'a' | 'g' | 'r' | '' } {
  if (section === 'need') {
    // Bloqueada sin pregunta: algo falló y hay que mirarlo; en rojo para distinguirla de «Pregunta» y «Revisar».
    if (task.state === 'blocked' && !task.questions?.length) return { text: 'Bloqueada', tone: 'r' };
    const text = task.state === 'blocked' ? 'Pregunta' : task.state === 'review' ? 'Revisar' : STATE_LABEL[task.state];
    return { text, tone: 'a' };
  }
  if (section === 'working') {
    return task.state === 'working' ? { text: `● ${elapsed(task.updatedAt, now)}`, tone: 'g' } : { text: STATE_LABEL[task.state], tone: 'g' };
  }
  return { text: STATE_LABEL[task.state], tone: '' };
}

/** Tarjeta de la bandeja: id, título, estado, una línea de detalle y, si procede, opciones para responder ahí mismo. */
export function TaskCard({ task, section, stats, now, onAnswered, children }: {
  task: Task; section: CardSection; stats?: TaskStats; now: Date; onAnswered: (id: string) => void; children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = pill(task, section, now);
  const q = section === 'need' ? inlineQuestion(task) : null;
  const firstQuestion = task.state === 'blocked' ? task.questions?.[0] ?? null : null;
  const sub = section === 'need' ? (firstQuestion?.text ?? task.blockedReason)
    : section === 'working' ? stats?.lastMessage ?? null : null;

  const answer = (option: string) => {
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    api.answer(task.id, { answers: { [q.id]: option } })
      .then(() => onAnswered(task.id))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const showMini = section !== 'done' && stats && (stats.contextTokens !== null || stats.costUsd !== null);
  const level = stats ? contextLevel(stats.contextTokens, stats.contextWindow) : null;
  const pct = stats && stats.contextTokens !== null && stats.contextWindow > 0
    ? Math.min(100, Math.round((stats.contextTokens / stats.contextWindow) * 100)) : null;

  return (
    <li className="node">
      <div className={`card ${section}`}>
        <a className="row" href={`#/tarea/${task.id}`}>
          <span className="id">{task.id}</span>
          <span className="title">{task.title}</span>
          <span className={`pill ${p.tone}`}>{p.text}</span>
        </a>
        {sub && <p className={`sub${section === 'working' ? ' line' : ''}`}>{section === 'working' ? `«${sub}»` : sub}</p>}
        {q ? (
          <div className="opts" role="group" aria-label={q.text}>
            {q.options!.map((o) => (
              <button key={o} className="chip" disabled={busy} onClick={() => answer(o)}>{o}</button>
            ))}
          </div>
        ) : firstQuestion && (
          <div className="opts"><a className="chip" href={`#/tarea/${task.id}`}>Responder</a></div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {showMini && stats && (
          <p className="mini">
            {pct !== null && level && (
              <span>
                Contexto{' '}
                <span className={`meter small ${level}`} role="meter" aria-label="Contexto usado" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                  <i style={{ width: `${pct}%` }} />
                </span>{' '}
                {pct} %
              </span>
            )}
            {stats.costUsd !== null && <span>{formatUsd(stats.costUsd, stats.costPartial)}</span>}
          </p>
        )}
      </div>
      {children && <ul className="cards children">{children}</ul>}
    </li>
  );
}

/**
 * Tarjetas de una sección en árbol: cada hija dentro de su padre, con líneas como las de un árbol de carpetas.
 * Un padre de otra sección sale como cabecera tenue (`ghost`) con sus hijas debajo.
 */
export function TaskTree({ nodes, section, stats, now, onAnswered }: {
  nodes: TaskNode[]; section: CardSection; stats?: Record<string, TaskStats>; now: Date; onAnswered: (id: string) => void;
}) {
  return (
    <>
      {nodes.map((n) => {
        const kids = n.children.length > 0
          ? <TaskTree nodes={n.children} section={section} stats={stats} now={now} onAnswered={onAnswered} />
          : null;
        if (n.ghost) {
          return (
            <li key={`padre-${n.task.id}`} className="node">
              <a className="ghost" href={`#/tarea/${n.task.id}`} title="Tarea padre">
                <span className="id">{n.task.id}</span>
                <span className="title">{n.task.title}</span>
                <span className="state">{STATE_LABEL[n.task.state]}</span>
              </a>
              <ul className="cards children">{kids}</ul>
            </li>
          );
        }
        return (
          <TaskCard key={n.task.id} task={n.task} section={section} stats={stats?.[n.task.id]} now={now} onAnswered={onAnswered}>
            {kids}
          </TaskCard>
        );
      })}
    </>
  );
}
