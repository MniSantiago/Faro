import type { PushState } from './api';

const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;

/** Qué falta por subir: con varios repos, cada uno con su rama base y su remoto. */
export function pushSummary(state: PushState): string {
  if (state.ahead > 0) {
    if (!state.multiRepo) return `${state.baseBranch} va ${commits(state.ahead)} por delante de ${state.remote}`;
    return state.repos.map((r) => `${r.name}: ${r.baseBranch} va ${commits(r.ahead)} por delante de ${r.remote}`).join(' · ');
  }
  const tasks = state.pending.length;
  return `${tasks} ${tasks === 1 ? 'tarea' : 'tareas'} con el push pendiente`;
}
