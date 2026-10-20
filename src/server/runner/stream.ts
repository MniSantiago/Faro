import type { RunOutcome } from '../types';
import { extractFaroResult, type FaroResult } from './result';

export type ResultLine = {
  kind: 'result';
  isError: boolean;
  subtype: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  apiErrorStatus: number | null;
  permissionDenials: unknown[];
  costUsd: number | null;
  contextWindow: number | null;
};

export type ParsedLine =
  | { kind: 'init'; sessionId: string; model: string | null }
  | { kind: 'usage'; contextTokens: number }
  | { kind: 'message'; text: string }
  | { kind: 'tool'; name: string; input: unknown }
  | { kind: 'tool_result'; isError: boolean; text: string }
  | { kind: 'rate_limit'; status: string; resetsAt: number | null }
  | ResultLine;

type Block = { type?: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean };

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 2000);
  if (Array.isArray(content)) {
    return content.map((c: Block) => (c?.type === 'text' ? c.text ?? '' : '')).join('').slice(0, 2000);
  }
  return '';
}

/** Bloques de contenido válidos de un mensaje; ignora entradas que no son objetos. */
function blocksOf(o: any): Block[] {
  const content = o.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Block => b !== null && typeof b === 'object');
}

/** Ventana de contexto: la del modelo del init si coincide; si no, la mayor. */
function contextWindowOf(modelUsage: unknown, initModel?: string): number | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  const entries = Object.entries(modelUsage as Record<string, any>)
    .map(([name, u]) => [name, u?.contextWindow] as const)
    .filter((e): e is readonly [string, number] => typeof e[1] === 'number');
  if (entries.length === 0) return null;
  const own = initModel ? entries.find(([name]) => name === initModel) : undefined;
  return own ? own[1] : Math.max(...entries.map((e) => e[1]));
}

export function parseLine(line: string, initModel?: string): ParsedLine[] {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  switch (o?.type) {
    case 'system':
      return o.subtype === 'init' && typeof o.session_id === 'string'
        ? [{ kind: 'init', sessionId: o.session_id, model: typeof o.model === 'string' ? o.model : null }]
        : [];
    case 'assistant': {
      const out: ParsedLine[] = [];
      const u = o.message?.usage;
      // Los mensajes de subagentes (parent_tool_use_id) no cuentan para el contexto de la tarea.
      if (u && typeof u === 'object' && (o.parent_tool_use_id ?? null) === null) {
        out.push({
          kind: 'usage',
          contextTokens: Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0),
        });
      }
      for (const b of blocksOf(o)) {
        if (b.type === 'text' && b.text) out.push({ kind: 'message', text: b.text });
        if (b.type === 'tool_use' && b.name) out.push({ kind: 'tool', name: b.name, input: b.input ?? null });
      }
      return out;
    }
    case 'user': {
      const out: ParsedLine[] = [];
      for (const b of blocksOf(o)) {
        if (b.type === 'tool_result') out.push({ kind: 'tool_result', isError: b.is_error === true, text: toolResultText(b.content) });
      }
      return out;
    }
    case 'rate_limit_event':
      return [{
        kind: 'rate_limit',
        status: String(o.rate_limit_info?.status ?? 'unknown'),
        resetsAt: typeof o.rate_limit_info?.resetsAt === 'number' ? o.rate_limit_info.resetsAt : null,
      }];
    case 'result':
      return [{
        kind: 'result',
        isError: o.is_error === true,
        subtype: String(o.subtype ?? ''),
        text: typeof o.result === 'string' ? o.result : '',
        inputTokens: Number(o.usage?.input_tokens ?? 0),
        outputTokens: Number(o.usage?.output_tokens ?? 0),
        apiErrorStatus: typeof o.api_error_status === 'number' ? o.api_error_status : null,
        permissionDenials: Array.isArray(o.permission_denials) ? o.permission_denials : [],
        costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : null,
        contextWindow: contextWindowOf(o.modelUsage, initModel),
      }];
    default:
      return [];
  }
}

export interface StreamSummary {
  result: ResultLine | null;
  rateLimitRejected: boolean;
  resetsAt: number | null;
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

const AUTH_RE = /please run \/login|invalid api key|not logged in|oauth token (has )?(expired|invalid|revoked)/i;
const LIMIT_RE = /usage limit|rate limit|limit reached/i;

export function classify(s: StreamSummary): { outcome: RunOutcome; faroResult: FaroResult | null; error: string | null } {
  if (s.cancelled) return { outcome: 'interrupted', faroResult: null, error: null };
  if (s.timedOut) return { outcome: 'timeout', faroResult: null, error: 'Tiempo máximo superado' };
  const r = s.result;
  const failed = !r || r.isError;
  const errText = r?.isError ? r.text : s.stderr;
  if (failed && (s.rateLimitRejected || r?.apiErrorStatus === 429 || LIMIT_RE.test(errText))) {
    return { outcome: 'rate_limited', faroResult: null, error: 'Límite de uso de Claude alcanzado' };
  }
  if (failed && (r?.apiErrorStatus === 401 || AUTH_RE.test(errText))) {
    return { outcome: 'auth', faroResult: null, error: 'La sesión de Claude no es válida: ejecuta `claude login` en el Mac' };
  }
  if (failed || (s.exitCode ?? 0) !== 0) {
    return { outcome: 'error', faroResult: null, error: (errText || `claude salió con código ${s.exitCode}`).slice(0, 500) };
  }
  const fr = extractFaroResult(r!.text);
  if (!fr) return { outcome: 'blocked', faroResult: null, error: 'El agente terminó sin un bloque faro-result válido' };
  return { outcome: fr.status, faroResult: fr, error: null };
}
