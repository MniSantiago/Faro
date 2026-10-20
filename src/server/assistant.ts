import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cron } from 'croner';
import { AssistantError } from './errors';
import { agentEnv } from './policy';
import type { Store } from './store';
import type { FaroConfig, ProjectConfig } from './types';

export interface RoutineDraft {
  name: string; title: string; cron: string | null; profileId: string; level: 1 | 2;
  context: 'metrics' | 'estado' | 'aso' | null; maxBudgetUsd: number | null; prompt: string;
}

const TIMEOUT_MS = 120_000;
const MAX_BUDGET_USD = '0.5';

/** Forma de `RoutineDraft` para `--json-schema`. */
export const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Nombre corto de la rutina' },
    title: { type: 'string', description: 'Título de cada tarea que crea; admite {fecha} y {semana}' },
    cron: { type: ['string', 'null'], description: 'Cron de 5 campos, o null si solo se lanza a mano' },
    profileId: { type: 'string', description: 'Id de uno de los perfiles disponibles' },
    level: { type: 'integer', enum: [1, 2], description: '1 = solo lee, 2 = puede editar' },
    context: { type: ['string', 'null'], enum: ['metrics', 'estado', 'aso', null] },
    maxBudgetUsd: { type: ['number', 'null'], description: 'Tope de gasto por ejecución en dólares, o null' },
    prompt: { type: 'string', description: 'Instrucciones completas para el agente' },
  },
  required: ['name', 'title', 'cron', 'profileId', 'level', 'context', 'maxBudgetUsd', 'prompt'],
  additionalProperties: false,
} as const;

/**
 * Datos de la CLI (comprobados con una llamada real):
 *  - `claude -p --output-format json --json-schema '<esquema>' --tools "" --setting-sources "" --strict-mcp-config
 *    --disable-slash-commands --max-budget-usd 0.5 [--model <m>]`, con el prompt como último argumento y stdin cerrado.
 *  - Sin `--setting-sources "" --strict-mcp-config --disable-slash-commands` cada llamada carga plugins, skills, MCP y
 *    CLAUDE.md del usuario (~247k tokens de caché, ~0,25 $ hasta con Haiku); con ellos, ~4,5k tokens (~0,001 $).
 *  - `--bare` NO se usa: se salta el llavero y da «Not logged in».
 *  - El resultado es un objeto JSON con `structured_output` (el objeto del esquema), `total_cost_usd` (número),
 *    `is_error` (boolean), `subtype` ('success' | 'error_max_budget_usd' | …) y `result` (texto).
 */
export function assistantArgs(model: string | undefined, prompt: string): string[] {
  return [
    '-p', '--output-format', 'json', '--json-schema', JSON.stringify(DRAFT_SCHEMA),
    '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands',
    '--max-budget-usd', MAX_BUDGET_USD,
    ...(model ? ['--model', model] : []),
    prompt,
  ];
}

const contextsOf = (p: ProjectConfig): NonNullable<RoutineDraft['context']>[] => ['estado', ...(p.metrics ? ['metrics' as const] : []), ...(p.aso ? ['aso' as const] : [])];

function buildPrompt(config: FaroConfig, p: ProjectConfig, description: string): string {
  const profiles = config.profiles.map((x) => `- ${x.id} («${x.name}»): ${x.instructions}`).join('\n');
  const routines = (p.routines ?? []).map((r) => `- ${r.name}: ${r.prompt}`).join('\n') || '(ninguna)';
  return [
    'Redactas una rutina programada para Faro, un panel que lanza agentes de Claude Code sobre un proyecto. Responde solo con el objeto pedido por el esquema.',
    `Proyecto: ${p.name}.`,
    `Perfiles disponibles (profileId debe ser uno de estos ids):\n${profiles}`,
    `Contextos disponibles para este proyecto (context): ${contextsOf(p).join(', ')} o null. `
      + '«estado» añade las tareas de Faro, los pendientes, el último build y el CI; «metrics» las últimas métricas; «aso» la vigilancia de la ficha.',
    `Rutinas que ya existen (no las repitas):\n${routines}`,
    'Reglas: nivel 1 si la rutina solo lee e informa, 2 si debe editar archivos (nunca más). '
      + 'cron de 5 campos en hora local (por ejemplo «0 9 * * 1» = lunes a las 9) o null si no se menciona cuándo. '
      + 'title admite {fecha} y {semana}. maxBudgetUsd null salvo que se pida un tope. '
      + 'El prompt va en español, en segunda persona, con instrucciones concretas y completas para el agente.',
    `Descripción de la rutina: ${description}`,
  ].join('\n\n');
}

interface Output { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function run(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<Output> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const kill = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch { /* ya terminó */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 2000).unref();
    }, opts.timeoutMs);
    child.stdout.on('data', (b: Buffer) => { stdout = (stdout + b).slice(-2_000_000); });
    child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b).slice(-100_000); });
    child.on('error', (e) => { stderr += e.message; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

interface CliResult { structured_output?: unknown; total_cost_usd?: unknown; is_error?: unknown; subtype?: unknown; result?: unknown }

/** Una frase → borrador de rutina. No guarda nada; el coste de la llamada sí queda en `assistant_calls`. */
export async function draftRoutine(
  d: { config: FaroConfig; store: Store; claudeBin: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
  projectId: string,
  description: string,
): Promise<RoutineDraft> {
  const project = d.config.projects.find((p) => p.id === projectId);
  if (!project) throw new AssistantError('Proyecto desconocido');
  const coordinator = d.config.profiles.find((p) => p.id === (d.config.coordinatorProfile ?? 'coordinador'));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'faro-asistente-'));
  try {
    const out = await run(d.claudeBin, assistantArgs(coordinator?.model, buildPrompt(d.config, project, description)), {
      cwd: dir, env: { ...process.env, ...agentEnv(project.remote), ...d.env }, timeoutMs: d.timeoutMs ?? TIMEOUT_MS,
    });
    if (out.timedOut) throw new AssistantError('El asistente tardó demasiado');
    let res: CliResult;
    try { res = JSON.parse(out.stdout) as CliResult; } catch {
      throw new AssistantError(`El asistente falló${out.stderr.trim() ? `: ${out.stderr.trim().split('\n').pop()!.slice(0, 200)}` : ''}`);
    }
    const cost = typeof res.total_cost_usd === 'number' ? res.total_cost_usd : 0;
    const raw = res.structured_output as Partial<RoutineDraft> | undefined;
    if (res.is_error === true || !raw || typeof raw !== 'object') {
      d.store.recordAssistantCall(cost, false);
      const why = res.subtype === 'error_max_budget_usd' ? 'superó su tope de gasto' : String(res.result || res.subtype || 'no devolvió una rutina').slice(0, 200);
      throw new AssistantError(`El asistente falló: ${why}`);
    }
    d.store.recordAssistantCall(cost, true);
    return validate(d.config, project, raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function validate(config: FaroConfig, project: ProjectConfig, raw: Partial<RoutineDraft>): RoutineDraft {
  const str = (v: unknown, field: string): string => {
    if (typeof v !== 'string' || !v.trim()) throw new AssistantError(`El asistente no rellenó «${field}»`);
    return v.trim();
  };
  const profileId = str(raw.profileId, 'profileId');
  if (!config.profiles.some((p) => p.id === profileId)) throw new AssistantError(`El asistente propuso un perfil que no existe: ${profileId}`);
  const cron = typeof raw.cron === 'string' && raw.cron.trim() ? raw.cron.trim() : null;
  if (cron) {
    try { new Cron(cron, { paused: true }); } catch { throw new AssistantError(`El asistente propuso un cron inválido: ${cron}`); }
  }
  const level = (Number(raw.level) >= 2 ? 2 : 1) as 1 | 2;
  const context = raw.context && contextsOf(project).includes(raw.context) ? raw.context : null;
  const maxBudgetUsd = typeof raw.maxBudgetUsd === 'number' && raw.maxBudgetUsd > 0 ? raw.maxBudgetUsd : null;
  return { name: str(raw.name, 'name'), title: str(raw.title, 'title'), cron, profileId, level, context, maxBudgetUsd, prompt: str(raw.prompt, 'prompt') };
}
