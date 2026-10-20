import type { Comment, EventRow, Run } from '../server/types';

const FARO_RESULT = /```faro-result[^\n]*\n[\s\S]*?```/g;

export type ConvItem =
  | { type: 'faro-prompt'; key: string; text: string }
  | { type: 'user'; key: string; comment: Comment }
  | { type: 'agent'; key: string; text: string }
  | { type: 'steps'; key: string; events: EventRow[]; summary: string }
  | { type: 'turn'; key: string; n: number; costUsd: number | null; contextTokens: number | null }
  | { type: 'note'; key: string; comment: Comment }; // comentarios de Faro

const isCall = (e: EventRow) => e.kind === 'tool' && typeof (e.payload as { name?: unknown }).name === 'string';
const text = (e: EventRow) => String((e.payload as { text?: unknown }).text ?? '');

const CATEGORIES: { names: string[] | null; one: string; many: string }[] = [
  { names: ['Bash'], one: 'comando', many: 'comandos' },
  { names: ['Read'], one: 'lectura', many: 'lecturas' },
  { names: ['Write'], one: 'archivo escrito', many: 'archivos escritos' },
  { names: ['Edit'], one: 'archivo editado', many: 'archivos editados' },
  { names: ['Grep', 'Glob'], one: 'búsqueda', many: 'búsquedas' },
  { names: null, one: 'paso', many: 'pasos' },
];

/** Resumen sin IA de un bloque de pasos: «6 comandos, 2 lecturas, 1 archivo escrito». */
export function summarizeSteps(events: EventRow[]): string {
  const counts = CATEGORIES.map(() => 0);
  for (const e of events) {
    if (!isCall(e)) continue;
    const name = (e.payload as { name: string }).name;
    const i = CATEGORIES.findIndex((c) => c.names === null || c.names.includes(name));
    counts[i]++;
  }
  const parts = CATEGORIES.flatMap((c, i) => (counts[i] ? [`${counts[i]} ${counts[i] === 1 ? c.one : c.many}`] : []));
  return parts.length ? parts.join(', ') : 'actividad';
}

/**
 * Conversación cronológica de una tarea, como un chat: lo que Faro pide al agente, tus mensajes,
 * los textos del agente y, entre ellos, sus herramientas plegadas en bloques. Los comentarios del
 * agente (resúmenes) no salen: van al panel «Resultado». Un separador marca cada ejecución salvo la primera.
 */
export function buildConversation(comments: Comment[], events: EventRow[], runs: Run[]): ConvItem[] {
  const all = [
    ...events.map((ev) => ({ at: ev.createdAt, order: 0, id: ev.id, ev })),
    ...comments.filter((c) => c.author !== 'agent').map((c) => ({ at: c.createdAt, order: 1, id: c.id, c })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.id - b.id));

  const runIndex = new Map([...runs].sort((a, b) => a.id - b.id).map((r, i) => [r.id, { n: i + 1, run: r }]));
  const seenRuns = new Set<number>();
  const items: ConvItem[] = [];
  // system/result/error que aún no sabemos si caen entre herramientas.
  let pending: EventRow[] = [];

  const flush = () => {
    const last = items.at(-1);
    if (last?.type === 'steps') {
      last.events.push(...pending);
    } else if (pending.some((e) => e.kind === 'error')) {
      items.push({ type: 'steps', key: `s${pending[0].id}`, events: pending, summary: '' });
    }
    pending = [];
  };

  for (const x of all) {
    if ('c' in x) {
      flush();
      items.push(x.c.author === 'user'
        ? { type: 'user', key: `c${x.c.id}`, comment: x.c }
        : { type: 'note', key: `c${x.c.id}`, comment: x.c });
      continue;
    }
    const e = x.ev;
    if (!seenRuns.has(e.runId)) {
      const known = runIndex.get(e.runId);
      const n = known?.n ?? seenRuns.size + 1;
      if (seenRuns.size > 0 && n > 1) {
        flush();
        items.push({ type: 'turn', key: `t${e.runId}`, n, costUsd: known?.run.costUsd ?? null, contextTokens: known?.run.contextTokens ?? null });
      }
      seenRuns.add(e.runId);
    }
    if (e.kind === 'prompt') {
      flush();
      items.push({ type: 'faro-prompt', key: `e${e.id}`, text: text(e) });
    } else if (e.kind === 'message') {
      // El bloque faro-result es para Faro, no para leerlo: se quita, y el mensaje si se queda vacío.
      const body = text(e).replace(FARO_RESULT, '').trim();
      if (!body) continue;
      flush();
      items.push({ type: 'agent', key: `e${e.id}`, text: body });
    } else if (e.kind === 'tool') {
      const last = items.at(-1);
      if (last?.type === 'steps') last.events.push(...pending, e);
      else items.push({ type: 'steps', key: `s${(pending[0] ?? e).id}`, events: [...pending, e], summary: '' });
      pending = [];
    } else {
      pending.push(e);
    }
  }
  flush();
  for (const it of items) if (it.type === 'steps') it.summary = summarizeSteps(it.events);
  return items;
}
