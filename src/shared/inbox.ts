import type { Task, TaskState } from '../server/types';

export interface InboxSections { need: Task[]; working: Task[]; doneToday: Task[] }

const NEED: TaskState[] = ['blocked', 'review', 'draft'];
const WORKING: TaskState[] = ['working', 'queued', 'pr'];

const sameLocalDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Bandeja: solo tareas (no chats), repartidas en «Te necesita», «Trabajando» y «Terminadas hoy» (hora local); más recientes primero. */
export function inboxSections(tasks: Task[], now: Date): InboxSections {
  const list = tasks.filter((t) => t.kind === 'task').sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return {
    need: list.filter((t) => NEED.includes(t.state)),
    working: list.filter((t) => WORKING.includes(t.state)),
    doneToday: list.filter((t) => t.state === 'done' && sameLocalDay(new Date(t.updatedAt), now)),
  };
}

/** Tiempo transcurrido desde `iso` en texto corto: «ahora», «6 min», «2 h», «3 d». */
export function elapsed(iso: string, now: Date): string {
  const min = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);
  if (!(min >= 1)) return 'ahora';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
}
