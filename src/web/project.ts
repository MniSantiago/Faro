import { useSyncExternalStore } from 'react';
import { api, subscribe, type ConfigView } from './api';

/** Proyecto actual de la web: uno por dispositivo (localStorage), con `?p=` en el hash por encima. */

const KEY = 'faro.proyecto';
/** Clave anterior (el proyecto de la home): se lee si todavía no hay la nueva. */
const OLD_KEY = 'faro:home-project';

/** Query del hash (`#/nueva?titulo=x&p=acme` → `titulo=x&p=acme`). */
const queryOf = (hash: string) => { const i = hash.indexOf('?'); return i < 0 ? '' : hash.slice(i + 1); };

export function hashParam(hash: string, name: string): string | null {
  return new URLSearchParams(queryOf(hash)).get(name);
}

/** El hash con `name` cambiado (o quitado con null), conservando el resto de la query. */
export function withHashParam(hash: string, name: string, value: string | null): string {
  const i = hash.indexOf('?');
  const path = i < 0 ? hash : hash.slice(0, i);
  const q = new URLSearchParams(i < 0 ? '' : hash.slice(i + 1));
  if (value === null) q.delete(name); else q.set(name, value);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** Proyecto elegido: `?p=` del hash si es válido; si no, el guardado (localStorage `faro.proyecto`, con try/catch); si no, el primero. */
export function pickProject(ids: string[], hashQuery: string, saved: string | null): string | null {
  const p = new URLSearchParams(hashQuery).get('p');
  if (p && ids.includes(p)) return p;
  if (saved && ids.includes(saved)) return saved;
  return ids[0] ?? null;
}

/** Proyecto de una tarea por su prefijo (`ACM-3` → el de prefijo `ACM`); null si ninguno encaja. */
export function projectOfTask(prefixes: { id: string; prefix: string }[], taskId: string): string | null {
  const m = /^(.+)-\d+$/.exec(taskId);
  return m ? prefixes.find((p) => p.prefix === m[1])?.id ?? null : null;
}

/**
 * Si una página de tarea (o Nueva tarea `?desde=`) debe llevar el proyecto actual al de `target`: solo la primera vez para
 * cada `key` (id de la tarea o del original) y si es de otro proyecto. Después manda el selector.
 */
export function shouldSyncProject(lastKey: string | null, key: string, target: string | null, current: string | null): boolean {
  return key !== lastKey && target !== null && target !== current;
}

/** Páginas atadas a una tarea concreta: al elegir otro proyecto en el selector se va a Inicio en vez de quedarse en ellas. */
export function leavesOnProjectChange(hash: string): boolean {
  const path = hash.replace(/^#/, '').split('?')[0];
  return path.startsWith('/tarea/') || (path === '/nueva' && hashParam(hash, 'desde') !== null);
}

function loadSaved(): string | null {
  try { return localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY); } catch { return null; }
}
function save(id: string): void {
  try { localStorage.setItem(KEY, id); } catch { /* sin almacenamiento: no se recuerda */ }
}

interface State { config: ConfigView | null; projectId: string | null; error: string | null }
let state: State = { config: null, projectId: null, error: null };
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;
let seq = 0;

function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const l of [...listeners]) l();
}

/** Recalcula el proyecto con el hash y lo guardado; el elegido por `?p=` queda guardado en este dispositivo. */
function resolve() {
  if (!state.config) return;
  const id = pickProject(state.config.projects.map((p) => p.id), queryOf(location.hash), loadSaved());
  if (id) save(id);
  if (id !== state.projectId) set({ projectId: id });
}

function load() {
  const mine = ++seq;
  api.config().then((c) => {
    // Una respuesta vieja que llega después de otra más nueva se descarta.
    if (mine !== seq) return;
    document.title = c.title;
    state = { ...state, config: c, error: null };
    resolve();
    set({});
  }).catch((e: Error) => { if (mine === seq && !state.config) set({ error: e.message }); });
}

/** Con el primer componente que lo usa: carga la config, la recarga al guardar el panel (`config`) y sigue el `?p=` del hash. */
function listen(l: () => void): () => void {
  listeners.add(l);
  if (!stop) {
    // También al (re)conectar el SSE, como hacía la navegación.
    const off = subscribe((m) => { if (m.type === 'config') load(); }, load);
    addEventListener('hashchange', resolve);
    stop = () => { off(); removeEventListener('hashchange', resolve); };
    load();
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && stop) { stop(); stop = null; }
  };
}

/** Cambia el proyecto actual (y el `?p=` del hash, si lo lleva, sin añadir una entrada al historial). */
export function setProject(id: string): void {
  if (!state.config?.projects.some((p) => p.id === id)) return;
  save(id);
  if (hashParam(location.hash, 'p') !== null && hashParam(location.hash, 'p') !== id) {
    history.replaceState(history.state, '', withHashParam(location.hash, 'p', id));
  }
  if (id !== state.projectId) set({ projectId: id });
}

/** Vuelve a pedir la config (el botón Reintentar cuando falló la primera carga). */
export function retryConfig(): void {
  set({ error: null });
  load();
}

const snapshot = () => state;

/** El proyecto actual ahora mismo (fuera de React, p. ej. en una promesa). */
export const currentProjectId = () => state.projectId;

/** Config de la web (null hasta que llega), su error y el proyecto actual. */
export function useProjectState(): State {
  return useSyncExternalStore(listen, snapshot);
}

export function useProject(): { projectId: string | null; setProject(id: string): void; projects: ConfigView['projects'] } {
  const s = useProjectState();
  return { projectId: s.projectId, setProject, projects: s.config?.projects ?? [] };
}

/** El proyecto actual entero (o null). */
export function useCurrentProject(): ConfigView['projects'][number] | null {
  const s = useProjectState();
  return s.config?.projects.find((p) => p.id === s.projectId) ?? null;
}
