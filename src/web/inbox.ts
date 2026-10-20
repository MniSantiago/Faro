import type { Question, Task } from '../server/types';

// Las secciones de la bandeja y el tiempo transcurrido se comparten con el servidor (home).
export { elapsed, inboxSections, type InboxSections } from '../shared/inbox';

/** La pregunta que se puede responder desde la tarjeta: bloqueada, una sola pregunta, con opciones y no múltiple. */
export function inlineQuestion(task: Task): Question | null {
  if (task.state !== 'blocked' || !task.questions || task.questions.length !== 1) return null;
  const q = task.questions[0];
  return q.options && q.options.length > 0 && !q.multiple ? q : null;
}

/** Nodo del árbol de una sección: `ghost` es un padre que está en otra sección y solo sirve de cabecera. */
export interface TaskNode { task: Task; ghost: boolean; children: TaskNode[] }

/**
 * Árbol padre → hijas de una sección. Una hija cuelga de su padre si está en la misma sección; si el padre
 * está en otra (o ya hecho), sus hijas se agrupan bajo una cabecera con él. Cada grupo ocupa el sitio de su
 * miembro más reciente y las hijas conservan el orden de la sección.
 */
export function taskTree(section: Task[], all: Task[]): TaskNode[] {
  const inSection = new Map(section.map((t) => [t.id, t]));
  const known = new Map(all.map((t) => [t.id, t]));
  const nodes = new Map(section.map((t) => [t.id, { task: t, ghost: false, children: [] } as TaskNode]));
  const ghosts = new Map<string, TaskNode>();
  const roots: TaskNode[] = [];
  const placed = new Set<TaskNode>();

  /** El antepasado más alto que sigue en la sección (con tope por si hubiera un ciclo). */
  const top = (t: Task): Task => {
    let cur = t;
    for (let i = 0; i < section.length && cur.parentId && inSection.has(cur.parentId); i++) cur = inSection.get(cur.parentId)!;
    return cur;
  };

  /** Cabecera del padre que está fuera de la sección, o null si no se conoce. */
  const ghostFor = (parentId: string | null): TaskNode | null => {
    if (!parentId || inSection.has(parentId) || !known.has(parentId)) return null;
    let ghost = ghosts.get(parentId);
    if (!ghost) ghosts.set(parentId, (ghost = { task: known.get(parentId)!, ghost: true, children: [] }));
    return ghost;
  };

  for (const t of section) {
    const node = nodes.get(t.id)!;
    const parent = t.parentId ? inSection.get(t.parentId) : undefined;
    if (parent && parent.id !== t.id && top(parent) !== t) nodes.get(parent.id)!.children.push(node);
    else ghostFor(t.parentId)?.children.push(node);
    // El grupo entra en la lista en cuanto aparece su primer miembro.
    const head = top(t);
    const root = ghostFor(head.parentId) ?? nodes.get(head.id)!;
    if (!placed.has(root)) { placed.add(root); roots.push(root); }
  }
  return roots;
}
