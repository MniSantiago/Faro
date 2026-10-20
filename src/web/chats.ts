import type { Task } from '../server/types';

/** Clave de localStorage con el `updatedAt` de la última versión vista de cada chat (por dispositivo). */
export const SEEN_KEY = 'faro.chatsVistos';
/** Se emite en `window` cuando cambian los chats vistos, para que la navegación quite el punto. */
export const SEEN_EVENT = 'faro:chats-vistos';

/**
 * Chats con novedades que no has abierto, actualizados después de lo visto: con una respuesta del Coordinador
 * (`idle` con resumen) o bloqueados esperando tu respuesta (`blocked`, que no aparecen en la bandeja).
 */
export function unreadChats(chats: Task[], seen: Record<string, string>): string[] {
  return chats
    .filter((t) => t.kind === 'chat'
      && ((t.state === 'idle' && t.summary !== null) || t.state === 'blocked')
      && !(seen[t.id] && seen[t.id] >= t.updatedAt))
    .map((t) => t.id);
}

/** Apunta como vista la versión actual del chat; no retrocede si ya se vio una más nueva. */
export function markSeen(seen: Record<string, string>, chat: Task): Record<string, string> {
  if (seen[chat.id] && seen[chat.id] >= chat.updatedAt) return seen;
  return { ...seen, [chat.id]: chat.updatedAt };
}

/** Lee el valor guardado; cualquier cosa rara se trata como «nada visto». */
export function parseSeen(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

export function loadSeen(): Record<string, string> {
  try { return parseSeen(localStorage.getItem(SEEN_KEY)); } catch { return {}; }
}

/**
 * Primera carga en este dispositivo (`raw === null`: la clave no existe): los chats que ya hay cuentan como vistos,
 * para no marcar como sin leer todo el historial. Con la clave ya presente devuelve null (no hay que sembrar).
 */
export function seedSeen(raw: string | null, tasks: Task[]): Record<string, string> | null {
  if (raw !== null) return null;
  return Object.fromEntries(tasks.filter((t) => t.kind === 'chat').map((t) => [t.id, t.updatedAt]));
}

/** Siembra los chats vistos con la lista completa de tareas si este dispositivo aún no tiene la clave. */
export function seedSeenIfMissing(tasks: Task[]): void {
  try {
    const seed = seedSeen(localStorage.getItem(SEEN_KEY), tasks);
    if (!seed) return;
    localStorage.setItem(SEEN_KEY, JSON.stringify(seed));
  } catch { return; }
  window.dispatchEvent(new Event(SEEN_EVENT));
}

/** Guarda el chat como visto en este dispositivo (sin efecto si localStorage no está disponible). */
export function saveSeen(chat: Task): void {
  try {
    const prev = loadSeen();
    const next = markSeen(prev, chat);
    if (next === prev) return;
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch { return; }
  window.dispatchEvent(new Event(SEEN_EVENT));
}

/** Chats para la página «Chats»: no archivados, más recientes primero. */
export function chatList(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.kind === 'chat' && t.state !== 'discarded')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

export type NavSection = 'bandeja' | 'chats' | 'rutinas' | 'metricas' | 'dispositivos' | 'plan' | 'aso';

/** Entrada de la navegación que corresponde a la ruta; una tarea abierta va a «Chats» si es un chat. */
export function navSection(route: string, tasks: Task[]): NavSection | null {
  const path = route.split('?')[0];
  if (path === '/' || path === '/historial') return 'bandeja';
  if (path === '/chats' || path === '/chat/nuevo') return 'chats';
  if (path === '/rutinas') return 'rutinas';
  if (path === '/plan') return 'plan';
  if (path === '/metricas') return 'metricas';
  if (path === '/aso') return 'aso';
  if (path === '/dispositivos') return 'dispositivos';
  if (path.startsWith('/tarea/')) {
    const id = path.slice('/tarea/'.length);
    return tasks.find((t) => t.id === id)?.kind === 'chat' ? 'chats' : 'bandeja';
  }
  return null;
}
