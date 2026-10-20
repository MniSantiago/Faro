import type { Comment, EventRow, Task } from '../server/types';

export type ThreadItem =
  | { type: 'comment'; key: string; comment: Comment }
  | { type: 'activity'; key: string; events: EventRow[]; actions: number };

/** Hilo cronológico: comentarios sueltos y, entre ellos, la actividad del agente agrupada. */
export function buildThread(comments: Comment[], events: EventRow[]): ThreadItem[] {
  const all = [
    ...events.map((ev) => ({ at: ev.createdAt, order: 0, id: ev.id, ev })),
    ...comments.map((c) => ({ at: c.createdAt, order: 1, id: c.id, c })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.id - b.id));
  const items: ThreadItem[] = [];
  for (const x of all) {
    if ('c' in x) {
      items.push({ type: 'comment', key: `c${x.c.id}`, comment: x.c });
      continue;
    }
    const last = items.at(-1);
    const isAction = x.ev.kind === 'tool' && typeof (x.ev.payload as { name?: unknown }).name === 'string';
    if (last?.type === 'activity') {
      last.events.push(x.ev);
      if (isAction) last.actions++;
    } else {
      items.push({ type: 'activity', key: `e${x.ev.id}`, events: [x.ev], actions: isAction ? 1 : 0 });
    }
  }
  return items;
}

export interface ComposerMode { enabled: boolean; canInterrupt: boolean; placeholder: string; send: string }

export function composerMode(task: Task): ComposerMode {
  switch (task.state) {
    case 'working': return { enabled: true, canInterrupt: true, placeholder: 'Se le entregará al terminar este paso', send: 'Enviar' };
    case 'queued': return { enabled: true, canInterrupt: false, placeholder: 'Se le entregará al empezar', send: 'Enviar' };
    case 'blocked': return task.questions?.length
      ? { enabled: false, canInterrupt: false, placeholder: '', send: 'Enviar' }
      : { enabled: true, canInterrupt: false, placeholder: 'Tu respuesta', send: 'Responder y continuar' };
    case 'review': return { enabled: true, canInterrupt: false, placeholder: 'Qué quieres que cambie', send: 'Pedir cambios' };
    case 'idle': return { enabled: true, canInterrupt: false, placeholder: 'Escribe al Coordinador', send: 'Enviar' };
    default: return { enabled: false, canInterrupt: false, placeholder: '', send: 'Enviar' };
  }
}

export function isPending(c: Comment, _task: Task): boolean {
  return c.author === 'user' && c.deliveredAt === null;
}
