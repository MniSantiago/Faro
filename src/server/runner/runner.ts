import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import type { Bus } from '../bus';
import type { Store } from '../store';
import type { EventKind, Level, ProfileConfig, RunOutcome } from '../types';
import { wrapSandbox } from '../sandbox';
import { buildClaudeArgs } from './args';
import type { FaroResult } from './result';
import { classify, parseLine, type StreamSummary } from './stream';

export interface RunInput {
  taskId: string;
  cwd: string;
  sessionId: string;
  resume: boolean;
  prompt: string;
  /** Lo que Faro le dice al agente sin los mensajes del usuario; se guarda como evento `prompt`. null = no se registra. */
  displayPrompt: string | null;
  systemPrompt: string;
  level: Level;
  profile: ProfileConfig;
  env?: Record<string, string>;
  /** Perfil de Seatbelt con el que lanzar el agente (macOS); null = sin sandbox. */
  sandboxProfile?: string | null;
  /** Hay token de GitHub de solo lectura en `env`: se permite `gh` de lectura. */
  ghRead?: boolean;
  /** Tope de gasto de esta ejecución (el de la rutina); si falta, el del perfil. */
  maxBudgetUsd?: number;
}

export interface RunResult {
  runId: number;
  outcome: RunOutcome;
  result: FaroResult | null;
  finalText: string;
  resetsAt: number | null;
  error: string | null;
  /** El proceso llegó a emitir `init`: la sesión existe y se puede retomar con --resume. */
  sawInit: boolean;
}

export interface RunnerDeps {
  store: Store;
  bus: Bus;
  claudeBin: string;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  closeGraceMs?: number;
  /** Ventana de contexto si la ejecución no la informa (por defecto 200000). */
  defaultWindow?: (taskId: string) => number;
  /** Reloj en ms, inyectable en tests para el límite de `stats` por segundo. */
  now?: () => number;
}

/** Intervalo mínimo entre `stats` provocados por mensajes del agente. */
const STATS_INTERVAL_MS = 1000;

export class Runner {
  private procs = new Map<string, { child: ChildProcess; cancelled: boolean }>();

  constructor(private d: RunnerDeps) {}

  isRunning(taskId: string): boolean {
    return this.procs.has(taskId);
  }

  cancel(taskId: string): void {
    const p = this.procs.get(taskId);
    if (!p) return;
    p.cancelled = true;
    p.child.kill('SIGTERM');
  }

  run(input: RunInput): Promise<RunResult> {
    const { store, bus } = this.d;
    if (this.procs.has(input.taskId)) throw new Error(`La tarea ${input.taskId} ya tiene una ejecución en curso`);
    const run = store.startRun(input.taskId, input.sessionId);
    const record = (kind: EventKind, payload: unknown) => {
      let row;
      try {
        row = store.addEvent(run.id, input.taskId, kind, payload);
      } catch (err) {
        console.error('[faro] no se pudo guardar el evento', err);
        return;
      }
      try {
        bus.emitEvent(input.taskId, row);
      } catch (err) {
        console.error('[faro] un suscriptor del bus falló', err);
      }
    };
    const defaultWindow = this.d.defaultWindow ?? (() => 200000);
    const clock = this.d.now ?? Date.now;
    const emitStats = () => {
      try {
        const stats = store.taskStats([input.taskId], defaultWindow)[input.taskId];
        if (stats) bus.emitStats(input.taskId, stats);
      } catch (err) {
        console.error('[faro] no se pudieron emitir las estadísticas', err);
      }
    };
    let lastUsageStats: number | null = null;
    let initModel: string | undefined;
    if (input.displayPrompt !== null) record('prompt', { text: input.displayPrompt });
    let sawInit = false;
    const summary: StreamSummary = {
      result: null, rateLimitRejected: false, resetsAt: null, exitCode: null, stderr: '', timedOut: false, cancelled: false,
    };

    const args = buildClaudeArgs({
      sessionId: input.sessionId, resume: input.resume, level: input.level, profile: input.profile, systemPrompt: input.systemPrompt,
      ghRead: input.ghRead, maxBudgetUsd: input.maxBudgetUsd,
    });
    const [cmd, argv] = wrapSandbox(this.d.claudeBin, args, input.sandboxProfile);
    const child = spawn(cmd, argv, { cwd: input.cwd, env: { ...process.env, ...input.env, ...this.d.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const entry = { child, cancelled: false };
    this.procs.set(input.taskId, entry);

    child.stdin.on('error', () => {});
    child.stdin.end(input.prompt);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      try {
      for (const p of parseLine(line, initModel)) {
        switch (p.kind) {
          case 'init':
            sawInit = true;
            initModel = p.model ?? undefined;
            record('system', { sessionId: p.sessionId });
            store.setRunModel(run.id, p.model);
            emitStats();
            break;
          case 'usage': {
            store.setRunContext(run.id, p.contextTokens);
            // Como mucho un `stats` por segundo: el contexto se guarda siempre y el último llega al terminar.
            const t = clock();
            if (lastUsageStats === null || t - lastUsageStats >= STATS_INTERVAL_MS) {
              lastUsageStats = t;
              emitStats();
            }
            break;
          }
          case 'message': record('message', { text: p.text }); break;
          case 'tool': record('tool', { name: p.name, input: p.input }); break;
          case 'tool_result': record('tool', { result: p.text, isError: p.isError }); break;
          case 'rate_limit':
            if (p.status === 'rejected') {
              summary.rateLimitRejected = true;
              summary.resetsAt = p.resetsAt;
            }
            break;
          case 'result':
            summary.result = p;
            record('result', { text: p.text, isError: p.isError, permissionDenials: p.permissionDenials });
            break;
        }
      }
      } catch (err) {
        console.error('[faro] error procesando una línea del agente', err);
      }
    });
    child.stderr.on('data', (b: Buffer) => { summary.stderr = (summary.stderr + b.toString()).slice(-4000); });

    const timer = setTimeout(() => {
      summary.timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), this.d.killGraceMs ?? 5000).unref();
    }, input.profile.timeoutMinutes * 60_000);

    return new Promise((resolve) => {
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        this.procs.delete(input.taskId);
        let out: RunResult;
        // total_cost_usd es acumulado de la sesión (con --resume incluye los turnos anteriores):
        // se guarda solo la parte de esta ejecución para que las sumas por tarea no cuenten doble.
        // También se guarda el total bruto, para calcular la parte de la siguiente ejecución de la sesión.
        const sessionTotalUsd = summary.result?.costUsd ?? null;
        let costUsd: number | null = null;
        try {
          if (sessionTotalUsd !== null) costUsd = store.runCostDelta(run.id, sessionTotalUsd);
        } catch (err) {
          console.error('[faro] no se pudo calcular el coste de la ejecución', err);
        }
        try {
          summary.exitCode = code;
          summary.cancelled = entry.cancelled;
          const c = classify(summary);
          store.finishRun(run.id, c.outcome, {
            input: summary.result?.inputTokens ?? 0, output: summary.result?.outputTokens ?? 0,
            costUsd, sessionTotalUsd, contextWindow: summary.result?.contextWindow ?? null,
          });
          if (c.error) record('error', { message: c.error });
          out = {
            runId: run.id, outcome: c.outcome, result: c.faroResult, finalText: summary.result?.text ?? '',
            resetsAt: summary.resetsAt, error: c.error, sawInit,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[faro] fallo al cerrar la ejecución', err);
          try {
            store.finishRun(run.id, 'error', { input: 0, output: 0, costUsd, sessionTotalUsd });
          } catch (err2) {
            console.error('[faro] tampoco se pudo marcar la ejecución como error', err2);
          }
          out = { runId: run.id, outcome: 'error', result: null, finalText: summary.result?.text ?? '', resetsAt: summary.resetsAt, error: message, sawInit };
        }
        emitStats();
        resolve(out);
      };
      child.on('error', (err) => {
        summary.stderr += `\n${err.message}`;
        finish(127);
      });
      child.on('exit', (code) => {
        graceTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          rl.close();
          finish(code);
        }, this.d.closeGraceMs ?? 2000);
        graceTimer.unref();
      });
      child.on('close', (code) => {
        rl.close();
        finish(code);
      });
    });
  }
}
