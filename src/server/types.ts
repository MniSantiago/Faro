import type { AsoConfig } from './aso/types';
import type { MetricsConfig } from './metrics/types';
export type TaskState = 'draft' | 'queued' | 'working' | 'blocked' | 'review' | 'pr' | 'done' | 'discarded' | 'idle';
export type TaskKind = 'task' | 'chat';
export type Release = 'none' | 'build' | 'build_submit';
export interface Question { id: string; text: string; options?: string[]; multiple?: boolean }
export type JobKind = 'build' | 'submit';
export type JobState = 'running' | 'ok' | 'failed' | 'interrupted';
export interface Job {
  id: number; taskId: string; kind: JobKind; state: JobState; startedAt: string; endedAt: string | null;
  outputPath: string | null; meta: { buildId?: string; url?: string };
}
export interface RoutineConfig {
  id: string; name: string; cron?: string; profileId: string; level: Level;
  title: string; prompt: string; draft?: boolean; release?: Release;
  /** `metrics`: añade a la descripción las últimas fotos de métricas del proyecto.
   *  `estado`: añade las tareas de Faro, los pendientes, el último build, lo integrado sin enviar, el CI y los PR. */
  context?: 'metrics' | 'estado' | 'aso';
  /** Tope de gasto por ejecución (`--max-budget-usd`); manda sobre el del perfil. */
  maxBudgetUsd?: number;
}
export interface ReleaseConfig { cwd: string; build: string; submit: string; timeoutMinutes?: number }
export interface RoutineRow {
  id: string; projectId: string; cron: string | null; enabled: boolean;
  lastRunAt: string | null; nextRunAt: string | null; lastSkipReason: string | null;
}
export type Level = 1 | 2 | 3 | 4;
export type FinalAction = 'merge' | 'push' | 'eas' | 'publish';
export type RunOutcome = 'done' | 'blocked' | 'error' | 'timeout' | 'rate_limited' | 'auth' | 'interrupted' | 'budget';
/** Niveles de `--effort` de la CLI. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORTS[number];
export type EventKind = 'system' | 'prompt' | 'message' | 'tool' | 'result' | 'error';
export type ArtifactKind = 'diff' | 'check' | 'image' | 'video' | 'file';
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'auto';
export type CommentAuthor = 'user' | 'agent' | 'faro';

export interface CheckConfig {
  name: string;
  command: string;
  /** Solo se ejecuta si algún archivo cambiado empieza por este prefijo. */
  whenChanged?: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  prefix: string;
  repoPath: string;
  baseBranch: string;
  remote: string;
  worktreesDir: string;
  /** Número de la primera tarea (por defecto 1). */
  startNumber?: number;
  /** Comandos que se ejecutan en cada worktree nuevo antes de lanzar al agente. */
  prepare?: string[];
  /** Patrones que Faro añade a `.git/info/exclude` (además de `.faro/`), p. ej. enlaces creados por `prepare`. */
  exclude?: string[];
  /** Comprobaciones que tiene que pasar una tarea antes de revisión. */
  checks?: CheckConfig[];
  /** Rutinas programadas del proyecto (fase 2). */
  routines?: RoutineConfig[];
  /** Comandos de build y envío que ejecuta Faro tras integrar (fase 2). */
  release?: ReleaseConfig;
  /** GitHub con `gh`: `ci` vigila el CI de la rama base; `prs` integra cada tarea por PR (squash al pasar el CI). */
  /** `ciProfile`: perfil de las tareas que arreglan el CI (si falta, se elige uno con nivel ≥ 2). */
  github?: { ci?: boolean; prs?: boolean; ciProfile?: string };
  /** Archivo del plugin `pendientes` de Claude Code con el backlog del proyecto (página «Plan»). */
  backlogFile?: string;
  /** Identificadores no secretos de las fuentes de métricas (fase 4); los secretos van en el llavero. */
  metrics?: MetricsConfig;
  /** Vigilancia ASO (ranking, competidores y ficha) del proyecto en el App Store. */
  aso?: AsoConfig;
  /** Ventana de contexto por defecto de las tareas del proyecto si la ejecución no la informa (200000 si falta). */
  contextWindow?: number;
}

export interface ProfileConfig {
  id: string;
  name: string;
  instructions: string;
  model?: string;
  /** Esfuerzo de razonamiento (`--effort`); si falta, el de la CLI. */
  effort?: Effort;
  /** Tope de gasto por ejecución (`--max-budget-usd`); al alcanzarlo, la tarea se bloquea con ese motivo. */
  maxBudgetUsd?: number;
  defaultLevel: Level;
  timeoutMinutes: number;
  mcpConfig?: string;
}

/**
 * Modo de reintento desatendido de la CLI (`CLAUDE_CODE_RETRY_WATCHDOG`): reintenta 429/529 con un tope de espera
 * en vez de fallar enseguida, y corta si el límite de uso se reinicia más tarde de lo admitido (Faro pausa la cola).
 */
export interface RetryWatchdogConfig {
  /** Por defecto, activado. */
  enabled?: boolean;
  /** Espera total máxima reintentando sobrecargas y límites (por defecto 5 min). */
  maxWaitMs?: number;
  /** Espera máxima a que se reinicie un límite de uso (por defecto 5 min). */
  maxUsageLimitWaitMs?: number;
}

export interface FaroConfig {
  host: string;
  port: number;
  /** Valores extra de la cabecera Host aceptados por el API (p. ej. el nombre de Tailscale), además de 127.0.0.1/localhost:<port>. */
  allowedHosts?: string[];
  /** Contacto VAPID de los avisos push (por defecto `mailto:faro@localhost`). */
  pushContact?: string;
  dataDir: string;
  claudeBin: string;
  /** CLI de GitHub (por defecto `gh`). */
  ghBin?: string;
  maxConcurrentRuns: number;
  /** Lanza agentes y comprobaciones dentro de `sandbox-exec` en macOS (por defecto, sí). */
  sandbox?: boolean;
  /** Nombre del panel en la web (por defecto «Faro»). */
  title?: string;
  /** Perfil de las conversaciones y de dividir objetivos en subtareas (por defecto `coordinador`). */
  coordinatorProfile?: string;
  /** Esperas de la CLI ante límites de uso y sobrecarga (ver RetryWatchdogConfig). */
  retryWatchdog?: RetryWatchdogConfig;
  projects: ProjectConfig[];
  profiles: ProfileConfig[];
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  profileId: string;
  state: TaskState;
  level: Level;
  parentId: string | null;
  routineId: string | null;
  branch: string | null;
  worktreePath: string | null;
  sessionId: string | null;
  /** true si alguna ejecución de esta tarea llegó a crear la sesión de Claude (emitió `init`): solo entonces se retoma. */
  sessionStarted: boolean;
  kind: TaskKind;
  /** Preguntas del agente en la pausa actual (solo en `blocked`). */
  questions: Question[] | null;
  /** Qué lanza Faro al integrar. Lo fija el usuario o la rutina, nunca el agente. */
  release: Release;
  nextPrompt: string | null;
  blockedReason: string | null;
  summary: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: number;
  taskId: string;
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: RunOutcome | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  /** total_cost_usd acumulado de la sesión al terminar esta ejecución (null si no hubo resultado). */
  sessionTotalUsd: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  model: string | null;
}

/** Coste y contexto agregados de una tarea (todas sus ejecuciones). */
export interface TaskStats {
  costUsd: number | null; // suma de cost_usd conocidos; null si ninguna ejecución tiene coste
  costPartial: boolean; // alguna ejecución terminada sin cost_usd
  contextTokens: number | null; // de la ejecución más reciente con dato
  contextWindow: number; // ventana de la ejecución más reciente con dato; si no, la del proyecto o 200000
  turns: number; // nº de ejecuciones
  model: string | null;
  lastMessage: string | null; // primera línea del último evento 'message', máx. 140 caracteres
}

export interface Spend { today: number; week: number }

export interface EventRow {
  id: number;
  runId: number;
  taskId: string;
  kind: EventKind;
  payload: unknown;
  createdAt: string;
}

export interface Artifact {
  id: number;
  taskId: string;
  kind: ArtifactKind;
  path: string;
  label: string;
}

export interface Approval {
  id: number;
  taskId: string;
  action: FinalAction;
  state: ApprovalState;
  decidedAt: string | null;
}

export interface Comment {
  id: number;
  taskId: string;
  author: CommentAuthor;
  body: string;
  createdAt: string;
  /** null = pendiente de entregar al agente en su próxima ejecución. */
  deliveredAt: string | null;
}

export interface QueueState {
  paused: boolean;
  reason: 'rate_limit' | 'auth' | 'manual' | null;
  /** Segundos epoch en que se espera poder reanudar. */
  until: number | null;
  running: string[];
}

export type BusMessage =
  | { type: 'task'; task: Task }
  | { type: 'event'; taskId: string; event: EventRow }
  | { type: 'queue'; queue: QueueState }
  | { type: 'stats'; taskId: string; stats: TaskStats }
  /** La config cambió desde el panel: la web la vuelve a pedir. */
  | { type: 'config' };

/** Dispositivo emparejado para el acceso remoto (fase 3). */
export interface Device { id: string; name: string; createdAt: string; lastSeenAt: string | null }
