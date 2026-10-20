import type { Bus } from './bus';
import { getProject } from './config';
import type { FaroResult } from './runner/result';
import type { Store } from './store';
import type { FaroConfig, Level, Task } from './types';

export const MAX_SUBTASKS = 8;
export const MAX_SUBTASK_LEVEL = 3;

/** Crea como borradores las subtareas que propone un agente, con las reglas de la fase 2. */
export function createSubtasks(d: { store: Store; config: FaroConfig; bus: Bus }, parent: Task, proposed: FaroResult['subtasks']): Task[] {
  const { store, config, bus } = d;
  if (proposed.length === 0) return [];
  if (parent.parentId) {
    store.addComment(parent.id, 'faro', 'No se han creado subtareas: una subtarea no puede proponer otras.', { pending: true });
    bus.emitTask(store.getTask(parent.id));
    return [];
  }
  const project = getProject(config, parent.projectId);
  const created: Task[] = [];
  const problems: string[] = [];
  for (const [i, s] of proposed.entries()) {
    if (i >= MAX_SUBTASKS) {
      problems.push(`${proposed.length - MAX_SUBTASKS} descartadas por superar el máximo de ${MAX_SUBTASKS} por turno.`);
      break;
    }
    const title = s.title.trim().slice(0, 200);
    if (!title) {
      problems.push('Una propuesta sin título se ha descartado.');
      continue;
    }
    if (!config.profiles.some((p) => p.id === s.profileId)) {
      problems.push(`«${title}»: el perfil «${s.profileId}» no existe.`);
      continue;
    }
    const t = store.createTask(project, {
      title, description: s.description, profileId: s.profileId,
      level: Math.min(s.level, MAX_SUBTASK_LEVEL) as Level, parentId: parent.id,
    });
    bus.emitTask(t);
    created.push(t);
  }
  const lines = [
    created.length ? `Propuestas ${created.length} subtareas como borrador: ${created.map((t) => t.id).join(', ')}.` : '',
    ...problems,
  ].filter(Boolean);
  store.addComment(parent.id, 'faro', lines.join('\n'), { pending: true });
  bus.emitTask(store.getTask(parent.id));
  return created;
}

/** Avisa al padre (como contexto para su próximo turno) de que una subtarea está lista para revisar. */
export function notifyParent(d: { store: Store; bus: Bus }, child: Task): void {
  if (!child.parentId) return;
  const parent = d.store.findTask(child.parentId);
  if (!parent || parent.state === 'done' || parent.state === 'discarded') return;
  // Esperando a su PR: avisará al padre cuando se fusione.
  if (child.state === 'pr') return;
  const status = child.state === 'done' ? 'ha terminado' : 'está en revisión';
  const body = `${child.id} «${child.title}» ${status}${child.summary ? `: ${child.summary}` : ''}`;
  d.store.addComment(parent.id, 'faro', body, { pending: true });
  d.bus.emitTask(d.store.getTask(parent.id));
}
