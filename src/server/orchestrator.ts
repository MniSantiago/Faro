import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractAsoJson, importAsoResult } from './aso/proposals';
import type { runChecks } from './checks';
import { getProfile, getProject } from './config';
import { integrate, isConflictTask, prMetaKey, type IntegrateDeps, type PrMeta } from './integrate';
import { artifactKind, isInside } from './paths';
import { agentEnv, decide } from './policy';
import { buildChatOpening, buildFollowUpPrompt, buildSystemPrompt, buildTaskPrompt, formatMessages } from './runner/prompts';
import type { FaroResult } from './runner/result';
import type { Runner, RunResult } from './runner/runner';
import { summarizeQuestions } from './questions';
import { FARO_DIR, sandboxProfile } from './sandbox';
import { createSubtasks, notifyParent } from './subtasks';
import type { ProjectConfig, Question, QueueState, Task } from './types';
import { slugify } from './workspaces';

export interface OrchestratorDeps extends IntegrateDeps {
  runner: Pick<Runner, 'run' | 'cancel'>;
  runChecks: typeof runChecks;
  setTimer?: (fn: () => void, ms: number) => void;
  /** Token de GitHub de solo lectura para los agentes (llavero `faro`/`github-lectura`); null = sin gh. */
  ghReadToken?: () => Promise<string | null>;
}

type SavedQueue = Omit<QueueState, 'running'>;
const RUNNING_FREE: SavedQueue = { paused: false, reason: null, until: null };

export class Orchestrator {
  private running = new Set<string>();
  private pending = new Set<Promise<void>>();
  private pauseGeneration = 0;
  private checkAborts = new Map<string, AbortController>();
  private closing = false;
  /** Tareas cuyas comprobaciones cortó un mensaje con interrupción: vuelven a la cola, no a revisión. */
  private requeueAfterChecks = new Set<string>();

  /** Corta las comprobaciones en curso de la tarea, si las hay. */
  cancelChecks(taskId: string): boolean {
    const c = this.checkAborts.get(taskId);
    if (!c) return false;
    c.abort();
    return true;
  }

  /** Como `cancelChecks`, pero la tarea vuelve a la cola con los mensajes pendientes en vez de ir a revisión. */
  interruptChecks(taskId: string): boolean {
    if (!this.checkAborts.has(taskId)) return false;
    this.requeueAfterChecks.add(taskId);
    return this.cancelChecks(taskId);
  }

  constructor(private d: OrchestratorDeps) {}

  /** Perfil de sandbox para agentes y comprobaciones del proyecto, o null si está desactivado. */
  private sandboxFor(project: ProjectConfig): string | null {
    if (this.d.config.sandbox === false) return null;
    return sandboxProfile({
      faroDir: FARO_DIR, dataDir: this.d.config.dataDir, repoPath: project.repoPath, worktreesDir: project.worktreesDir, home: os.homedir(), ports: [this.d.config.port],
    });
  }

  queueState(): QueueState {
    const saved = this.d.store.getMeta<SavedQueue>('queue') ?? RUNNING_FREE;
    return { ...saved, running: [...this.running] };
  }

  private saveQueue(q: SavedQueue): void {
    this.d.store.setMeta('queue', q);
    this.d.bus.emitQueue(this.queueState());
  }

  pause(reason: 'rate_limit' | 'auth' | 'manual', until: number | null): void {
    const gen = ++this.pauseGeneration;
    this.saveQueue({ paused: true, reason, until });
    if (until !== null) {
      const ms = Math.max(0, until * 1000 - Date.now()) + 60_000;
      (this.d.setTimer ?? setTimeout)(() => {
        if (gen === this.pauseGeneration && this.queueState().reason === 'rate_limit') this.resume();
      }, ms);
    }
  }

  resume(): void {
    this.pauseGeneration++;
    this.saveQueue(RUNNING_FREE);
    this.tick();
  }

  enqueue(taskId: string, nextPrompt?: string | null): void {
    const t = this.d.store.setState(taskId, 'queued', nextPrompt === undefined ? {} : { nextPrompt });
    this.d.bus.emitTask(t);
    this.tick();
  }

  recover(): void {
    const { store, bus } = this.d;
    for (const r of store.openRuns()) {
      store.finishRun(r.id, 'interrupted', { input: 0, output: 0 });
      // Faro se cortó a mitad de ejecución: si esa ejecución creó la sesión, se podrá retomar.
      if (store.runSawInit(r.id)) {
        if (store.findTask(r.taskId)?.sessionId === r.sessionId) store.updateTask(r.taskId, { sessionStarted: true });
      } else {
        // La sesión no llegó a crearse: el agente no vio los mensajes de ese turno; vuelven a estar pendientes.
        store.markUndeliveredSince(r.taskId, r.startedAt);
      }
    }
    for (const t of store.listTasks(['working'])) bus.emitTask(store.setState(t.id, 'queued'));
    const q = this.queueState();
    if (q.paused && q.reason && q.until !== null) this.pause(q.reason, q.until);
  }

  tick(): void {
    if (this.closing || this.queueState().paused) return;
    const free = this.d.config.maxConcurrentRuns - this.running.size;
    if (free <= 0) return;
    // Dos tareas que comparten rama (p. ej. el borrador de conflicto y su padre) nunca corren a la vez en el mismo worktree.
    const busyBranches = new Set<string>();
    for (const id of this.running) {
      const b = this.d.store.findTask(id)?.branch;
      if (b) busyBranches.add(b);
    }
    const next: Task[] = [];
    for (const t of this.d.store.listTasks(['queued'])) {
      if (next.length >= free) break;
      if (this.running.has(t.id) || (t.branch && busyBranches.has(t.branch))) continue;
      if (t.branch) busyBranches.add(t.branch);
      next.push(t);
    }
    for (const t of next) {
      this.running.add(t.id);
      const p: Promise<void> = this.execute(t.id).finally(() => {
        this.running.delete(t.id);
        this.pending.delete(p);
        this.d.bus.emitQueue(this.queueState());
        this.tick();
      });
      this.pending.add(p);
    }
    if (next.length) this.d.bus.emitQueue(this.queueState());
  }

  /** Cierre ordenado: no lanza nada más, espera `graceMs` y corta lo que siga (se retoma al arrancar). */
  async shutdown(graceMs = 10_000): Promise<void> {
    this.closing = true;
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), graceMs).unref());
    if ((await Promise.race([this.waitIdle().then(() => 'idle' as const), timeout])) === 'timeout') {
      for (const id of this.running) {
        this.d.runner.cancel(id);
        this.cancelChecks(id);
      }
      await Promise.race([this.waitIdle(), new Promise((r) => setTimeout(r, 3000).unref())]);
    }
  }

  async waitIdle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private emit(t: Task): void {
    this.d.bus.emitTask(t);
  }

  private async execute(taskId: string): Promise<void> {
    const { store, config } = this.d;
    try {
      let task = store.getTask(taskId);
      const project = getProject(config, task.projectId);
      const profile = getProfile(config, task.profileId);
      if (task.kind === 'chat') {
        if (!task.worktreePath || !existsSync(task.worktreePath)) {
          // Registro viejo de un worktree borrado a mano: se poda para que no bloquee el nombre.
          if (task.worktreePath) await this.d.workspaces.removeWorktree(project, task.worktreePath);
          const p = await this.d.workspaces.createDetached(project, `${task.id}-chat`);
          task = store.updateTask(taskId, { worktreePath: p });
        } else {
          await this.d.workspaces.refreshDetached(project, task.worktreePath);
        }
      } else if (!task.worktreePath || !task.branch) {
        const wt = await this.d.workspaces.create(project, task);
        const now = store.findTask(taskId);
        if (!now || (now.state !== 'queued' && now.state !== 'working')) {
          // Descartada mientras se preparaba el worktree: se archiva lo creado y no se lanza nada.
          await this.d.workspaces.discard(project, { ...task, worktreePath: wt.path, branch: wt.branch }).catch((e: Error) => {
            store.addComment(taskId, 'faro', `No se pudo limpiar el worktree creado: ${e.message}`);
          });
          return;
        }
        task = store.updateTask(taskId, { worktreePath: wt.path, branch: wt.branch });
      } else if (!existsSync(task.worktreePath)) {
        // Lo borró la integración de otra tarea que compartía la rama: se rehace sobre la misma rama.
        await this.d.workspaces.restore(project, task);
      }
      const conflictNote = task.kind !== 'chat' && isConflictTask(store, task) ? await this.prepareConflict(project, task) : null;
      // Solo se retoma una sesión que llegó a existir; si no, sesión nueva con el encargo completo.
      const resume = task.sessionId !== null && task.sessionStarted;
      const sessionId = resume ? task.sessionId! : randomUUID();
      const parent = task.parentId ? store.findTask(task.parentId) : null;
      const pending = store.listUndelivered(taskId);
      const opening = task.kind === 'chat' ? buildChatOpening() : buildTaskPrompt(task, parent);
      const base = [
        resume
          ? (task.nextPrompt ?? (pending.length || conflictNote ? null : buildFollowUpPrompt(null)))
          : [opening, task.nextPrompt].filter(Boolean).join('\n\n'),
        conflictNote,
      ].filter(Boolean).join('\n\n') || null;
      const prompt = [base, pending.length ? formatMessages(pending) : null].filter(Boolean).join('\n\n');
      // Lo que Faro le dice al agente (sin los mensajes del usuario, que ya están en el hilo) se guarda como evento `prompt`.
      task = store.setState(taskId, 'working', { sessionId, nextPrompt: null, blockedReason: null });
      this.emit(task);
      const sandbox = this.sandboxFor(project);
      const ghToken = project.github && this.d.ghReadToken ? await this.d.ghReadToken() : null;
      const running = this.d.runner.run({
        taskId, cwd: task.worktreePath!, sessionId, resume, prompt, displayPrompt: base,
        systemPrompt: buildSystemPrompt(profile, project, task.level, { chat: task.kind === 'chat', profiles: config.profiles, ghRead: !!ghToken }),
        level: task.level, profile, env: agentEnv(project.remote, ghToken), sandboxProfile: sandbox, ghRead: !!ghToken,
      });
      // Después de registrar la ejecución: así `recover` sabe qué mensajes iban en ella (delivered_at ≥ inicio).
      store.markDelivered(pending.map((c) => c.id));
      const r = await running;
      // Si la sesión no llegó a crearse, el agente no vio los mensajes: vuelven a estar pendientes.
      if (!r.sawInit && pending.length) store.markUndelivered(pending.map((c) => c.id));
      if (r.sawInit && !task.sessionStarted) task = store.updateTask(taskId, { sessionStarted: true });
      else if (resume && r.outcome === 'error' && /no conversation found/i.test(r.error ?? '')) {
        task = store.updateTask(taskId, { sessionStarted: false });
      }
      await this.handle(task, project, r);
    } catch (e) {
      this.block(taskId, `Error interno de Faro: ${(e as Error).message}`);
    }
  }

  /** Faro hace el merge de la rama base antes de lanzar al agente; devuelve la nota con lo que tiene que resolver. */
  private async prepareConflict(project: ProjectConfig, task: Task): Promise<string> {
    // Con PR, el merge se hace contra lo último de origin.
    if (this.d.github && project.github?.prs) await this.d.workspaces.syncBase(project).catch(() => {});
    const r = await this.d.workspaces.mergeBaseInto(project, task);
    if (r.status === 'clean') {
      return `Faro ha hecho merge de ${project.baseBranch} en esta rama y no ha quedado ningún conflicto. ` +
        'Comprueba que el resultado tiene sentido y termina; no hace falta tocar nada más.';
    }
    return [
      `Faro ha hecho merge de ${project.baseBranch} en esta rama y han quedado conflictos en:`,
      ...r.files.map((f) => `- ${f}`),
      '',
      'Edita esos archivos para resolverlos y quita todos los marcadores (<<<<<<<, =======, >>>>>>>). ' +
        'No ejecutes git merge, git add ni git commit: Faro cierra el merge al terminar.',
    ].join('\n');
  }

  private block(taskId: string, reason: string, questions: Question[] | null = null): void {
    const t = this.d.store.findTask(taskId);
    if (t && (t.state === 'working' || t.state === 'queued')) {
      this.emit(this.d.store.setState(taskId, 'blocked', { blockedReason: reason, attempts: 0, questions }));
    }
  }

  private async handle(task: Task, project: ProjectConfig, r: RunResult): Promise<void> {
    const { store } = this.d;
    const stillWorking = () => store.findTask(task.id)?.state === 'working';
    switch (r.outcome) {
      case 'done':
        return task.kind === 'chat' ? this.finishChat(task, r.result!) : this.finishDone(task, project, r.result!, r.finalText);
      case 'blocked':
        if (r.result?.summary) store.addComment(task.id, 'agent', r.result.summary);
        if (stillWorking() && r.result) createSubtasks(this.d, task, r.result.subtasks);
        if (stillWorking() && store.hasPendingUserMessages(task.id)) {
          this.emit(store.setState(task.id, 'queued', { attempts: 0 }));
          return;
        }
        const qs = r.result?.questions.length ? r.result.questions : null;
        this.block(task.id, qs ? summarizeQuestions(qs) : r.error ?? 'El agente necesita ayuda', qs);
        return;
      case 'error':
        if (!stillWorking()) return;
        if (task.attempts < 1) {
          this.emit(store.setState(task.id, 'queued', {
            attempts: task.attempts + 1,
            nextPrompt: 'La ejecución anterior falló por un error. Continúa la tarea donde la dejaste.',
          }));
        } else {
          this.block(task.id, `Falló dos veces: ${r.error}`);
        }
        return;
      case 'timeout':
        this.block(task.id, r.error ?? 'Tiempo máximo superado');
        return;
      case 'rate_limited':
        if (stillWorking()) this.emit(store.setState(task.id, 'queued'));
        this.pause('rate_limit', r.resetsAt ?? Math.floor(Date.now() / 1000) + 900);
        return;
      case 'auth':
        if (stillWorking()) this.emit(store.setState(task.id, 'queued'));
        this.pause('auth', null);
        return;
      case 'interrupted':
        // Si el usuario la paró (ya no está «working»), se respeta su estado.
        if (stillWorking()) this.emit(store.setState(task.id, 'queued'));
        return;
    }
  }

  private finishChat(task: Task, result: FaroResult): void {
    const { store } = this.d;
    // Si el usuario la paró mientras respondía, se respeta su estado.
    if (store.findTask(task.id)?.state !== 'working') return;
    createSubtasks(this.d, task, result.subtasks);
    store.addComment(task.id, 'agent', result.summary || '(sin respuesta)');
    const next = store.hasPendingUserMessages(task.id) ? 'queued' : 'idle';
    this.emit(store.setState(task.id, next, { summary: result.summary, attempts: 0 }));
  }

  /**
   * Rutinas con `context: 'aso'` (nivel 1, sin escribir archivos): el agente devuelve sus propuestas en un bloque
   * ```aso-json``` de su mensaje final y Faro las importa. Por compatibilidad, si no hay bloque se acepta un
   * artefacto `aso.json` copiado. Nunca cambia el cierre de la tarea.
   */
  private async importAso(task: Task, project: ProjectConfig, result: FaroResult, finalText: string, copies: Map<string, string>): Promise<void> {
    const routine = task.routineId ? project.routines?.find((r) => r.id === task.routineId) : undefined;
    if (routine?.context !== 'aso') return;
    const { store } = this.d;
    try {
      let json = extractAsoJson(finalText);
      if (json === null) {
        const rel = result.artifacts.find((a) => a.endsWith('aso.json'));
        const copy = rel ? copies.get(rel) : undefined;
        if (copy) json = await fs.readFile(copy, 'utf8');
      }
      if (json === null) {
        store.addComment(task.id, 'faro', 'La rutina ASO no devolvió el bloque aso-json');
        return;
      }
      const { created, errors } = importAsoResult(store, project, task.id, json);
      store.addComment(task.id, 'faro', [`${created} propuestas nuevas en ASO`, ...errors.map((e) => `- ${e}`)].join('\n'));
    } catch (e) {
      console.error(`[faro] importación ASO de ${task.id} falló:`, e);
    }
  }

  private async finishDone(task: Task, project: ProjectConfig, result: FaroResult, finalText = ''): Promise<void> {
    const { store, config, workspaces } = this.d;
    const wtPath = task.worktreePath!;
    // Con marcadores pendientes no se commitea: se cerraría el merge con el conflicto dentro.
    const left = await workspaces.unresolvedConflicts(wtPath);
    if (left.length) {
      if (result.summary) store.addComment(task.id, 'agent', result.summary);
      this.block(task.id, `Quedan marcadores de conflicto sin resolver en: ${left.join(', ')}`);
      return;
    }
    await workspaces.commitAll(wtPath, `${task.id}: ${task.title}`);
    const diff = await workspaces.diff(project, task);

    const dir = path.join(config.dataDir, 'artifacts', task.id);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    store.clearArtifacts(task.id);

    const diffPath = path.join(dir, 'diff.patch');
    await fs.writeFile(diffPath, diff.patch);
    store.addArtifact(task.id, 'diff', diffPath, `Diff (${diff.files.length} archivos)`);

    const ac = new AbortController();
    this.checkAborts.set(task.id, ac);
    let checks;
    let interrupted = false;
    try {
      checks = await this.d.runChecks(project, wtPath, diff.files, { signal: ac.signal, sandboxProfile: this.sandboxFor(project) });
    } finally {
      this.checkAborts.delete(task.id);
      interrupted = this.requeueAfterChecks.delete(task.id);
    }
    for (const [i, c] of checks.entries()) {
      const p = path.join(dir, `check-${i}-${slugify(c.name)}.txt`);
      await fs.writeFile(p, c.output);
      const verdict = c.aborted ? 'cancelada' : c.skipped ? 'omitida' : c.ok ? 'ok' : 'falla';
      store.addArtifact(task.id, 'check', p, `${c.name}: ${verdict}`);
    }

    const agentDir = path.join(dir, 'agente');
    const copies = new Map<string, string>();
    for (const [i, rel] of result.artifacts.entries()) {
      const src = path.resolve(wtPath, rel);
      if (!isInside(wtPath, src) || !existsSync(src)) continue;
      if (!(await fs.lstat(src)).isFile()) continue;
      await fs.mkdir(agentDir, { recursive: true });
      const dest = path.join(agentDir, `${i}-${path.basename(src)}`);
      await fs.copyFile(src, dest);
      store.addArtifact(task.id, artifactKind(dest), dest, rel);
      copies.set(rel, dest);
    }

    // Si el usuario la paró durante las comprobaciones ya está bloqueada: no se cambia su estado ni se integra.
    if (store.getTask(task.id).state !== 'working') return;
    // Cierre de Faro a mitad de las comprobaciones: vuelve a la cola para que `recover` no tenga que adivinar.
    if (this.closing && checks.some((c) => c.aborted)) {
      this.emit(store.setState(task.id, 'queued'));
      return;
    }

    createSubtasks(this.d, task, result.subtasks);

    await this.importAso(task, project, result, finalText, copies);
    store.addComment(task.id, 'agent', result.summary || 'Tarea terminada.');
    // Escribiste mientras trabajaba: sigue con tus mensajes en vez de pararse en revisión (y sin merge automático).
    if (interrupted || store.hasPendingUserMessages(task.id)) {
      this.emit(store.setState(task.id, 'queued', { summary: result.summary, attempts: 0 }));
      return;
    }
    const review = store.setState(task.id, 'review', { summary: result.summary, attempts: 0 });

    // Sin cambios de código no hay nada que aprobar: se cierra sola. Con cambios, solo se integra
    // sola si se ejecutó al menos una comprobación y todas pasaron. Con subtareas espera en revisión
    // para que el padre siga recibiendo sus avisos.
    const tested = checks.some((c) => !c.skipped) && checks.every((c) => c.ok || c.skipped);
    // Si ya aprobaste su PR (y el agente vuelve de arreglar el CI), se reintegra sola aunque sea de nivel 1.
    const approvedPr = !!store.getMeta<PrMeta>(prMetaKey(task.id))?.userApproved;
    const closeAlone = result.subtasks.length === 0
      && (diff.files.length === 0 || (tested && (decide(task.level, 'merge') === 'auto' || approvedPr)));
    if (!closeAlone) {
      this.emit(review);
    } else {
      // No se emite «review»: el aviso sería ruido si en un momento queda hecha.
      try {
        await integrate({ ...this.d, enqueue: (id, p) => this.enqueue(id, p) }, task.id, { userApproved: approvedPr });
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`[faro] integración automática de ${task.id} falló:`, e);
        store.addComment(task.id, 'faro', `No se pudo integrar automáticamente: ${msg}`);
        this.emit(store.getTask(task.id));
      }
    }
    notifyParent(this.d, store.getTask(task.id));
  }
}
