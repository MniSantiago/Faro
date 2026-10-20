import type { Task } from '../../server/types';
import type { ConvItem } from '../conversation';
import { formatTokens, formatUsd } from '../format';
import { isPending } from '../thread';
import { LogView } from './LogView';
import { Markdown } from './Markdown';

function turnLine(it: Extract<ConvItem, { type: 'turn' }>): string {
  const parts = [`turno ${it.n}`];
  if (it.costUsd !== null) parts.push(formatUsd(it.costUsd).replace('≈ ', '+'));
  if (it.contextTokens !== null) parts.push(`contexto ${formatTokens(it.contextTokens)}`);
  return `— ${parts.join(' · ')} —`;
}

function stepsLine(it: Extract<ConvItem, { type: 'steps' }>): string {
  const n = it.events.filter((e) => e.kind === 'tool' && typeof (e.payload as { name?: unknown }).name === 'string').length;
  return n > 0 ? `▸ ${n} ${n === 1 ? 'paso' : 'pasos'} · ${it.summary}` : `▸ ${it.summary}`;
}

/** La sesión real de la tarea, como un chat (opción A del rediseño). */
export function Conversation({ items, task }: { items: ConvItem[]; task: Task }) {
  if (items.length === 0) return <p className="muted">Todavía no hay mensajes.</p>;
  return (
    <ol className="conv">
      {items.map((it) => {
        switch (it.type) {
          case 'faro-prompt':
            return (
              <li key={it.key} className="msg">
                <div className="who">Faro → agente</div>
                <div className="bubble faro"><div className="body">{it.text}</div></div>
              </li>
            );
          case 'user':
            return (
              <li key={it.key} className="msg">
                <div className="who">Tú</div>
                <div className="bubble user">
                  <div className="body md"><Markdown text={it.comment.body} /></div>
                  {isPending(it.comment, task) && <span className="pending">pendiente de entregar</span>}
                </div>
              </li>
            );
          case 'agent':
            return (
              <li key={it.key} className="msg">
                <div className="who">Agente</div>
                <div className="bubble"><div className="body md"><Markdown text={it.text} /></div></div>
              </li>
            );
          case 'steps':
            return (
              <li key={it.key} className="steps">
                <details>
                  <summary>{stepsLine(it)}</summary>
                  <LogView events={it.events} />
                </details>
              </li>
            );
          case 'turn':
            return <li key={it.key} className="turn" role="separator">{turnLine(it)}</li>;
          case 'note':
            return <li key={it.key} className="sysnote">Faro: {it.comment.body}</li>;
        }
      })}
    </ol>
  );
}
