import { existsSync } from 'node:fs';
import { getProfile, getProject, isMultiRepo } from './config';
import { closeFinishedParent, integrate, prMetaKey, type IntegrateDeps, type IntegrateResult, type PrMeta } from './integrate';
import type { Orchestrator } from './orchestrator';
import type { Runner } from './runner/runner';
import type { Level, ProjectConfig, Release, Task, TaskState } from './types';

import { ActionError, BadRequestError } from './errors';
import { aheadTaskProject, pushFailureMessage, pushTaskProject } from './integrate-multi';
import { assertNotIntegrating, withProjectIntegrationLock } from './locks';
import { cleanupTask, commitTask, discardTask, saveTaskWork } from './task-workspace';
import { MAX_SUBTASK_LEVEL } from './subtasks';
import { formatAnswers, validateAnswers, type Answers } from './questions';

export { ActionError, BadRequestError } from './errors';

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description: string;
  profileId: string;
  level?: Level;
  draft?: boolean;
  routineId?: string | null;
  release?: Release;
  parentId?: string | null;
  repos?: string[];
}

/** Título del chat: su primer mensaje en una línea, cortado por palabra a 60 caracteres. */
export function chatTitle(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= 60) return one;
  const cut = one.slice(0, 60);
  const sp = cut.lastIndexOf(' ');
  return `${sp > 30 ? cut.slice(0, sp) : cut}…`;
}

type Deps = IntegrateDeps & { orchestrator: Pick<Orchestrator, 'enqueue' | 'cancelChecks' | 'interruptChecks'>; runner: Pick<Runner, 'cancel'> };

export class ReviewActions {
  constructor(private d: Deps) {}

  private expect(id: string, states: TaskState[]): Task {
    const t = this.d.store.getTask(id);
    if (!states.includes(t.state)) throw new ActionError(`${id} está en «${t.state}» y no admite esta acción`);
    return t;
  }

  /** Otras tareas sin terminar (ni hechas ni descartadas) que usan la misma rama/worktree que `t`. */
  private branchSharers(t: Task): Task[] {
    if (!t.branch) return [];
    return this.d.store.listTasks()
      .filter((o) => o.id !== t.id && o.branch === t.branch && o.state !== 'done' && o.state !== 'discarded');
  }

  /** Rechaza relanzar `t` si otra tarea con su misma rama está en cola o trabajando. */
  private assertBranchFree(t: Task): void {
    const busy = this.branchSharers(t).find((o) => o.state === 'queued' || o.state === 'working');
    if (busy) throw new ActionError(`${t.id} comparte la rama con ${busy.id}, que está en curso; espera a que termine`);
  }

  createTask(i: CreateTaskInput): Task {
    const project = getProject(this.d.config, i.projectId);
    const profile = getProfile(this.d.config, i.profileId);
    const t = this.d.store.createTask(project, {
      title: i.title.trim(), description: i.description, profileId: profile.id, level: i.level ?? profile.defaultLevel,
      parentId: i.parentId ?? null, routineId: i.routineId ?? null, release: i.release ?? 'none',
      repos: i.repos,
    });
    this.d.bus.emitTask(t);
    if (!i.draft) this.d.orchestrator.enqueue(t.id);
    return this.d.store.getTask(t.id);
  }

  createChat(i: { projectId: string; text: string }): Task {
    const project = getProject(this.d.config, i.projectId);
    const profile = getProfile(this.d.config, this.d.config.coordinatorProfile ?? 'coordinador');
    const text = i.text.trim();
    if (!text) throw new BadRequestError('El mensaje está vacío');
    const t = this.d.store.createTask(project, { title: chatTitle(text), description: '', profileId: profile.id, level: 1, kind: 'chat' });
    this.d.store.addComment(t.id, 'user', text, { pending: true });
    this.d.bus.emitTask(t);
    this.d.orchestrator.enqueue(t.id);
    return this.d.store.getTask(t.id);
  }

  approveDraft(id: string, level?: Level): Task {
    const t = this.expect(id, ['draft']);
    if (level !== undefined) {
      // Tope para subtareas propuestas por un agente; un borrador que Faro creó con un nivel mayor
      // (p. ej. el de un conflicto de una tarea de nivel 4) se puede aprobar sin cambiarlo.
      const max = Math.max(MAX_SUBTASK_LEVEL, t.level);
      if (t.parentId && level > max) throw new BadRequestError(`Una subtarea puede tener como mucho nivel ${max}`);
      this.d.store.updateTask(id, { level });
    }
    this.d.orchestrator.enqueue(id);
    return this.d.store.getTask(id);
  }

  private inFlight = new Set<string>();

  private async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.inFlight.has(id)) throw new ActionError(`${id} ya tiene una acción en curso`);
    this.inFlight.add(id);
    try {
      return await fn();
    } finally {
      this.inFlight.delete(id);
    }
  }

  approve(id: string): Promise<IntegrateResult> {
    return this.exclusive(id, async () => {
      assertNotIntegrating(id);
      this.expect(id, ['review']);
      return integrate({ ...this.d, enqueue: (t, p) => this.d.orchestrator.enqueue(t, p) }, id, { userApproved: true });
    });
  }

  message(id: string, text: string, opts: { interrupt?: boolean } = {}): Task {
    assertNotIntegrating(id);
    const t = this.d.store.getTask(id);
    const body = text.trim();
    if (!body) throw new BadRequestError('El mensaje está vacío');
    switch (t.state) {
      case 'blocked':
      case 'review':
      case 'pr':
      case 'idle':
        this.assertBranchFree(t);
        this.d.store.addComment(id, 'user', body, { pending: true });
        this.d.orchestrator.enqueue(id);
        break;
      case 'queued':
        this.d.store.addComment(id, 'user', body, { pending: true });
        break;
      case 'working':
        this.d.store.addComment(id, 'user', body, { pending: true });
        // La ejecución cortada vuelve a la cola (no a bloqueada) y se retoma con el mensaje.
        // Si el agente ya terminó y corren las comprobaciones, se cortan y la tarea vuelve a la cola.
        if (opts.interrupt) {
          this.d.runner.cancel(id);
          this.d.orchestrator.interruptChecks(id);
        }
        break;
      default:
        throw new ActionError('La tarea no admite mensajes');
    }
    const out = this.d.store.getTask(id);
    this.d.bus.emitTask(out);
    return out;
  }

  requestChanges(id: string, comment: string): Task {
    assertNotIntegrating(id);
    this.expect(id, ['review']);
    return this.message(id, comment);
  }

  answer(id: string, input: { answers?: Answers; text?: string }): Task {
    assertNotIntegrating(id);
    const t = this.expect(id, ['blocked']);
    const answers = input.answers ?? {};
    validateAnswers(t.questions, answers);
    const body = t.questions ? formatAnswers(t.questions, answers, input.text) : (input.text ?? '').trim();
    if (!body) throw new BadRequestError('Responde al menos una pregunta o escribe algo');
    return this.message(id, body);
  }

  discard(id: string): Promise<Task> {
    return this.exclusive(id, async () => {
      assertNotIntegrating(id);
      const t = this.expect(id, ['draft', 'queued', 'blocked', 'review', 'pr', 'idle']);
      const pr = this.d.store.getMeta<PrMeta>(prMetaKey(id));
      const out = this.d.store.setState(id, 'discarded');
      if (t.state === 'pr' && pr && this.d.github) {
        await this.d.github.closePr(getProject(this.d.config, t.projectId), pr.number, `Descartada en Faro (${id}).`).catch((e: Error) => {
          this.d.store.addComment(id, 'faro', `Descartada, pero no se pudo cerrar el PR #${pr.number}: ${e.message}`);
        });
      }
      this.d.bus.emitTask(out);
      if (t.branch) {
        const sharers = this.branchSharers(t);
        if (sharers.length) {
          this.d.store.addComment(id, 'faro',
            `Descartada sin tocar la rama ni el worktree: los sigue usando ${sharers.map((o) => o.id).join(', ')}.`);
          this.d.bus.emitTask(this.d.store.getTask(id));
        } else {
          const project = getProject(this.d.config, t.projectId);
          const message = `${id}: descartada (trabajo sin terminar)`;
          if (isMultiRepo(project)) {
            // Cada repo por su cuenta: si falta el worktree de uno, lo de los demás se guarda igual.
            const notes = t.worktreePath ? await saveTaskWork(this.d.workspaces, project, t, message) : [];
            if (notes.length) {
              this.d.store.addComment(id, 'faro', `Al descartar: ${notes.join('; ')}.`);
              this.d.bus.emitTask(this.d.store.getTask(id));
            }
          } else if (t.worktreePath && existsSync(t.worktreePath)) {
            // Guarda el trabajo sin commitear en la rama antes de archivarla.
            await commitTask(this.d.workspaces, project, t, message).catch(() => false);
          }
          try {
            await discardTask(this.d.workspaces, project, t);
          } catch (e) {
            this.d.store.addComment(id, 'faro', `Descartada, pero no se pudo limpiar el worktree: ${(e as Error).message}`);
            this.d.bus.emitTask(this.d.store.getTask(id));
          }
        }
      } else if (t.worktreePath) {
        // Chats: worktree separado sin rama (multi-repo: uno por repo dentro de la carpeta del chat).
        try {
          const project = getProject(this.d.config, t.projectId);
          if (isMultiRepo(project)) await cleanupTask(this.d.workspaces, project, t);
          else await this.d.workspaces.removeWorktree(project, t.worktreePath);
        } catch (e) {
          this.d.store.addComment(id, 'faro', `Archivado, pero no se pudo borrar el worktree: ${(e as Error).message}`);
          this.d.bus.emitTask(this.d.store.getTask(id));
        }
      }
      await closeFinishedParent(this.d, this.d.store.getTask(id)).catch((e: Error) => {
        console.error(`[faro] no se pudo cerrar el padre de ${id}:`, e);
      });
      return this.d.store.getTask(id);
    });
  }

  /** Para una ejecución en curso: la tarea queda bloqueada (antes de cancelar, para que no se reencole). */
  stop(id: string): Promise<Task> {
    return this.exclusive(id, async () => {
      assertNotIntegrating(id);
      this.expect(id, ['working']);
      const out = this.d.store.setState(id, 'blocked', { blockedReason: 'Parada por el usuario' });
      this.d.bus.emitTask(out);
      this.d.runner.cancel(id);
      this.d.orchestrator.cancelChecks(id);
      return out;
    });
  }

  /** Sube la rama base del proyecto (de cada repo) y da por aprobados todos sus push pendientes (un solo push para todo). */
  pushProject(projectId: string): Promise<void> {
    return this.exclusive(`push:${projectId}`, () => withProjectIntegrationLock(projectId, async () => {
      const project = getProject(this.d.config, projectId);
      const pending = this.d.store.listPendingApprovals(projectId, 'push');
      if (pending.length === 0 && (await aheadTaskProject(this.d.workspaces, project)) === 0) {
        throw new ActionError(`${project.name} no tiene cambios sin subir`);
      }
      await this.pushAll(project);
      for (const a of pending) this.d.store.decideApproval(a.id, 'approved');
      for (const taskId of new Set(pending.map((a) => a.taskId))) this.d.bus.emitTask(this.d.store.getTask(taskId));
    }));
  }

  approvePush(id: string): Promise<void> {
    return this.exclusive(id, () => withProjectIntegrationLock(this.d.store.getTask(id).projectId, async () => {
      const t = this.d.store.getTask(id);
      const pending = this.d.store.listApprovals(id).filter((a) => a.action === 'push' && a.state === 'pending');
      if (pending.length === 0) throw new ActionError(`${id} no tiene un push pendiente`);
      await this.pushAll(getProject(this.d.config, t.projectId));
      for (const a of pending) this.d.store.decideApproval(a.id, 'approved');
      this.d.bus.emitTask(this.d.store.getTask(id));
    }));
  }

  /** Push de la rama base (de cada repo, en multi-repo); si falta alguno, ActionError con lo subido y lo que falta. */
  private async pushAll(project: ProjectConfig): Promise<void> {
    if (isMultiRepo(project)) {
      const r = await pushTaskProject(this.d.workspaces, project);
      if (r.failed.length) throw new ActionError(pushFailureMessage(r));
      return;
    }
    try {
      await this.d.workspaces.push(project);
    } catch (e) {
      throw new ActionError(`El push falló: ${(e as Error).message}`);
    }
  }
}
