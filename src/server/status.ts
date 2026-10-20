import type { PlanState } from './plan';
import type { Store } from './store';
import type { Task, TaskState } from './types';

/** Cuántos días atrás cuenta lo terminado. */
const DONE_DAYS = 14;
const MAX_PER_GROUP = 25;

const OPEN_GROUPS: { label: string; states: TaskState[] }[] = [
  { label: 'En marcha (trabajando o en cola)', states: ['working', 'queued'] },
  { label: 'Bloqueadas', states: ['blocked'] },
  { label: 'Esperando tu revisión', states: ['review'] },
  { label: 'Esperando CI (PR abierto)', states: ['pr'] },
  { label: 'Chats esperando tu mensaje', states: ['idle'] },
  { label: 'Borradores sin lanzar', states: ['draft'] },
];

const firstLine = (s: string | null, max = 160) => {
  const line = (s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const day = (iso: string) => iso.slice(0, 10);

function list<T>(items: T[], fmt: (x: T) => string, empty = '(nada)'): string {
  if (!items.length) return `- ${empty}`;
  const shown = items.slice(0, MAX_PER_GROUP).map((x) => `- ${fmt(x)}`);
  if (items.length > MAX_PER_GROUP) shown.push(`- … y ${items.length - MAX_PER_GROUP} más`);
  return shown.join('\n');
}

const taskLine = (t: Task) => {
  const extra = t.state === 'blocked' ? firstLine(t.blockedReason) : firstLine(t.summary);
  return `${t.id} · ${t.title} (${t.profileId}, actualizada ${day(t.updatedAt)})${extra ? ` — ${extra}` : ''}`;
};

/** Foto del proyecto según Faro (tareas, pendientes, builds, CI y PR) para la rutina de estado. */
export function statusContext(store: Store, projectId: string, plan: PlanState | null, planError: string | null, now: Date): string {
  const tasks = store.listTasks().filter((t) => t.projectId === projectId);
  const out: string[] = [];

  out.push('## Tareas abiertas en Faro');
  for (const g of OPEN_GROUPS) {
    const items = tasks.filter((t) => g.states.includes(t.state));
    if (items.length) out.push(`### ${g.label}\n${list(items, taskLine)}`);
  }
  if (!tasks.some((t) => OPEN_GROUPS.some((g) => g.states.includes(t.state)))) out.push('- (ninguna)');

  const since = now.getTime() - DONE_DAYS * 86_400_000;
  const done = tasks.filter((t) => t.state === 'done' && new Date(t.updatedAt).getTime() >= since).reverse();
  out.push(`## Terminadas en los últimos ${DONE_DAYS} días\n${list(done, taskLine)}`);

  if (!plan) {
    out.push(`## Plan\n- (no se pudo leer: ${planError ?? 'sin datos'})`);
    return out.join('\n\n');
  }

  out.push(plan.backlog === null ? '## Pendientes del backlog\n- (el proyecto no tiene backlog)'
    : `## Pendientes del backlog\n${list(plan.backlog.filter((b) => !b.isDone), (b) => `#${b.id} ${b.text}`, plan.backlogError ? `(error: ${plan.backlogError})` : '(ninguno)')}`);

  const b = plan.build;
  out.push(`## Último build de producción (EAS)\n- ${b ? `${b.version} (${b.buildNumber}) del ${day(b.createdAt)}, commit ${b.commit.slice(0, 7)}` : '(desconocido)'}${plan.buildError ? `\n- Aviso: ${plan.buildError}` : ''}`);

  out.push(`## Integrado desde ese build (sin enviar a la tienda)\n${list(plan.unshipped, (u) =>
    `${u.taskId ?? 'commit suelto'} · ${u.title} (${u.commits} commit${u.commits === 1 ? '' : 's'}, ${day(u.lastAt)})` +
    (u.touchesApp ? (u.tested ? ' — probado en el iPhone' : ' — falta probar en el iPhone') : ''),
  plan.unshippedError ? `(error: ${plan.unshippedError})` : '(nada)')}`);

  if (plan.github) {
    const ci = plan.github.ci;
    out.push(`## GitHub\n- CI de la rama base: ${ci ? `${ci.state} en ${ci.sha.slice(0, 7)} (${ci.workflows.join(', ')})` : '(sin ejecuciones)'}` +
      `\n- PR abiertos: ${plan.github.prs.length ? plan.github.prs.map((p) => `#${p.number} ${p.title}${p.isDraft ? ' (borrador)' : ''}`).join('; ') : 'ninguno'}` +
      (plan.github.error ? `\n- Aviso: ${plan.github.error}` : ''));
  }
  return out.join('\n\n');
}
