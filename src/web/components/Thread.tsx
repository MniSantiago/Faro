import type { Task } from '../../server/types';
import { isPending, type ThreadItem } from '../thread';
import { LogView } from './LogView';
import { Markdown } from './Markdown';

const WHO = { user: 'Tú', agent: 'Coordinador', faro: 'Faro' } as const;

/** Hilo de los chats con el Coordinador (las tareas usan `Conversation`). */
export function Thread({ items, task }: { items: ThreadItem[]; task: Task }) {
  if (items.length === 0) return <p className="muted">Todavía no hay mensajes.</p>;
  return (
    <ol className="thread">
      {items.map((it) => it.type === 'comment' ? (
        <li key={it.key} className={`bubble ${it.comment.author}`}>
          <strong>{WHO[it.comment.author]}</strong>
          <div className="body md"><Markdown text={it.comment.body} /></div>
          {isPending(it.comment, task) && <span className="pending">pendiente de entregar</span>}
        </li>
      ) : (
        <li key={it.key} className="activity">
          <details>
            <summary>{it.actions > 0 ? `trabajó: ${it.actions} ${it.actions === 1 ? 'acción' : 'acciones'}` : 'actividad'}</summary>
            <LogView events={it.events} />
          </details>
        </li>
      ))}
    </ol>
  );
}
