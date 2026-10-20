import { describe, expect, it } from 'vitest';
import type { Comment, EventKind, EventRow, Run } from '../src/server/types';
import { buildConversation, summarizeSteps, type ConvItem } from '../src/web/conversation';

let seq = 0;
const at = (m: number) => `2026-10-17T10:${String(m).padStart(2, '0')}:00Z`;
const ev = (runId: number, m: number, kind: EventKind, payload: unknown): EventRow =>
  ({ id: ++seq, runId, taskId: 'DEM-1', kind, payload, createdAt: at(m) });
const tool = (runId: number, m: number, name: string) => ev(runId, m, 'tool', { name, input: {} });
const com = (id: number, m: number, author: Comment['author']): Comment =>
  ({ id, taskId: 'DEM-1', author, body: `c${id}`, createdAt: at(m), deliveredAt: at(m) });
const run = (id: number, costUsd: number | null, contextTokens: number | null): Run => ({
  id, taskId: 'DEM-1', sessionId: 's', startedAt: at(0), endedAt: null, outcome: null, inputTokens: 0, outputTokens: 0,
  costUsd, sessionTotalUsd: null, contextTokens, contextWindow: null, model: null,
});

describe('buildConversation', () => {
  it('prompt, pasos, agente, tú, turno; sin comentarios del agente', () => {
    const events = [
      ev(1, 1, 'prompt', { text: 'Haz la tarea' }),
      tool(1, 2, 'Bash'), ev(1, 2, 'tool', { result: 'ok', isError: false }), tool(1, 3, 'Read'), tool(1, 3, 'Bash'),
      ev(1, 4, 'message', { text: 'Hecho' }),
      ev(2, 10, 'prompt', { text: 'Continúa' }),
      ev(2, 11, 'message', { text: 'Sigo' }),
    ];
    const comments = [com(1, 5, 'agent'), com(2, 6, 'user'), com(3, 7, 'faro')];
    const items = buildConversation(comments, events, [run(1, 1.1, 40000), run(2, 0.4, 49000)]);
    expect(items.map((i) => i.type)).toEqual(['faro-prompt', 'steps', 'agent', 'user', 'note', 'turn', 'faro-prompt', 'agent']);
    expect(items.some((i) => (i.type === 'user' || i.type === 'note') && i.comment.author === 'agent')).toBe(false);
    const steps = items[1] as Extract<ConvItem, { type: 'steps' }>;
    expect(steps.events).toHaveLength(4);
    expect(steps.summary).toBe('2 comandos, 1 lectura');
    expect(items[5]).toMatchObject({ type: 'turn', n: 2, costUsd: 0.4, contextTokens: 49000 });
    expect(items[0]).toMatchObject({ type: 'faro-prompt', text: 'Haz la tarea' });
    expect(items[2]).toMatchObject({ type: 'agent', text: 'Hecho' });
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });

  it('system/result/error entre herramientas van al mismo bloque; sueltos sin error se omiten', () => {
    const events = [
      ev(1, 1, 'system', { sessionId: 'x' }), tool(1, 2, 'Grep'), ev(1, 2, 'error', { message: 'uy' }), tool(1, 3, 'Glob'),
      ev(1, 4, 'message', { text: 'fin' }), ev(1, 4, 'result', { text: 'fin' }),
    ];
    const items = buildConversation([], events, [run(1, 1, 1)]);
    expect(items.map((i) => i.type)).toEqual(['steps', 'agent']);
    expect((items[0] as Extract<ConvItem, { type: 'steps' }>).events.map((e) => e.kind)).toEqual(['system', 'tool', 'error', 'tool']);
  });

  it('quita el bloque faro-result de los mensajes del agente y omite los que quedan vacíos', () => {
    const events = [
      ev(1, 1, 'message', { text: 'Hecho.\n\n```faro-result\n{"status": "done", "summary": "x"}\n```' }),
      ev(1, 2, 'message', { text: '```faro-result\n{"status": "done"}\n```' }),
    ];
    const items = buildConversation([], events, [run(1, null, null)]);
    expect(items.map((i) => (i.type === 'agent' ? i.text : i.type))).toEqual(['Hecho.']);
  });

  it('un error suelto no se pierde', () => {
    const items = buildConversation([], [ev(1, 1, 'message', { text: 'a' }), ev(1, 2, 'error', { message: 'cayó' })], []);
    expect(items.map((i) => i.type)).toEqual(['agent', 'steps']);
  });

  it('tareas antiguas sin prompt empiezan por pasos o agente', () => {
    expect(buildConversation([], [tool(1, 1, 'Read'), ev(1, 2, 'message', { text: 'x' })], [run(1, null, null)])[0].type).toBe('steps');
    expect(buildConversation([], [ev(1, 1, 'message', { text: 'x' })], [])[0].type).toBe('agent');
    expect(buildConversation([], [], [])).toEqual([]);
  });

  it('ejecución desconocida en runs: turno sin datos', () => {
    const items = buildConversation([], [ev(1, 1, 'message', { text: 'a' }), ev(7, 2, 'message', { text: 'b' })], []);
    expect(items.map((i) => i.type)).toEqual(['agent', 'turn', 'agent']);
    expect(items[1]).toMatchObject({ n: 2, costUsd: null, contextTokens: null });
  });
});

describe('summarizeSteps', () => {
  it('cuenta por herramienta', () => {
    const events = [...Array(6)].map((_, i) => tool(1, i, 'Bash'))
      .concat([tool(1, 7, 'Read'), tool(1, 8, 'Read'), tool(1, 9, 'Write')]);
    expect(summarizeSteps(events)).toBe('6 comandos, 2 lecturas, 1 archivo escrito');
  });
  it('singular, ediciones, búsquedas y otras', () => {
    expect(summarizeSteps([tool(1, 1, 'Bash'), tool(1, 1, 'Edit'), tool(1, 1, 'Edit'), tool(1, 1, 'Grep'), tool(1, 1, 'WebFetch')]))
      .toBe('1 comando, 2 archivos editados, 1 búsqueda, 1 paso');
  });
  it('sin herramientas: actividad', () => {
    expect(summarizeSteps([ev(1, 1, 'system', {}), ev(1, 1, 'tool', { result: 'x' })])).toBe('actividad');
  });
});
