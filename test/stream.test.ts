import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify, parseLine, type ResultLine, type StreamSummary } from '../src/server/runner/stream';
import { fixture } from './helpers';

const lines = (name: string) => readFileSync(fixture(name), 'utf8').trim().split('\n').flatMap((l) => parseLine(l));

function summarize(name: string, over: Partial<StreamSummary> = {}): StreamSummary {
  const s: StreamSummary = { result: null, rateLimitRejected: false, resetsAt: null, exitCode: 0, stderr: '', timedOut: false, cancelled: false };
  for (const p of lines(name)) {
    if (p.kind === 'result') s.result = p;
    if (p.kind === 'rate_limit' && p.status === 'rejected') { s.rateLimitRejected = true; s.resetsAt = p.resetsAt; }
  }
  return { ...s, ...over };
}

describe('parseLine', () => {
  it('traduce un stream completo e ignora hooks y thinking', () => {
    const kinds = lines('stream-done.jsonl').map((p) => p.kind);
    expect(kinds).toEqual(['init', 'message', 'tool', 'tool_result', 'rate_limit', 'result']);
  });

  it('extrae los datos útiles', () => {
    const ps = lines('stream-done.jsonl');
    expect(ps[0]).toEqual({ kind: 'init', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', model: 'claude-opus-5-5' });
    expect(ps[2]).toEqual({ kind: 'tool', name: 'Write', input: { file_path: 'hola.txt', content: 'hola\n' } });
    expect(ps[3]).toEqual({ kind: 'tool_result', isError: false, text: 'File created successfully' });
    const r = ps[5] as ResultLine;
    expect(r).toMatchObject({ isError: false, inputTokens: 12, outputTokens: 34, apiErrorStatus: null });
  });

  it('ignora líneas que no son JSON', () => {
    expect(parseLine('no json')).toEqual([]);
    expect(parseLine('')).toEqual([]);
  });

  it('ignora entradas de contenido que no son objetos ni arrays', () => {
    expect(parseLine('{"type":"assistant","message":{"content":[null,{"type":"text","text":"hola"}]}}')).toEqual([{ kind: 'message', text: 'hola' }]);
    expect(parseLine('{"type":"user","message":{"content":{"a":1}}}')).toEqual([]);
  });

  it('emite el uso de contexto antes de los bloques del mensaje', () => {
    const l = JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 2, cache_read_input_tokens: 56088, cache_creation_input_tokens: 698 }, content: [{ type: 'text', text: 'hola' }] } });
    expect(parseLine(l)).toEqual([{ kind: 'usage', contextTokens: 56788 }, { kind: 'message', text: 'hola' }]);
  });

  it('ignora el uso de subagentes', () => {
    const l = JSON.stringify({ type: 'assistant', parent_tool_use_id: 'x', message: { usage: { input_tokens: 2 }, content: [] } });
    expect(parseLine(l).some((p) => p.kind === 'usage')).toBe(false);
  });

  it('init lleva el modelo o null', () => {
    const base = { type: 'system', subtype: 'init', session_id: 's1' };
    expect(parseLine(JSON.stringify({ ...base, model: 'claude-opus-5-5' }))).toEqual([{ kind: 'init', sessionId: 's1', model: 'claude-opus-5-5' }]);
    expect(parseLine(JSON.stringify(base))).toEqual([{ kind: 'init', sessionId: 's1', model: null }]);
  });

  it('result lleva coste y ventana de contexto', () => {
    const r = JSON.stringify({ type: 'result', total_cost_usd: 1.5155844, modelUsage: { 'claude-sonnet-5-5': { contextWindow: 1000000 } } });
    expect(parseLine(r)[0]).toMatchObject({ costUsd: 1.5155844, contextWindow: 1000000 });
    expect(parseLine('{"type":"result"}')[0]).toMatchObject({ costUsd: null, contextWindow: null });
  });

  it('la ventana prefiere el modelo del init y si no el mayor', () => {
    const r = JSON.stringify({ type: 'result', modelUsage: { a: { contextWindow: 200000 }, b: { contextWindow: 1000000 } } });
    expect(parseLine(r, 'a')[0]).toMatchObject({ contextWindow: 200000 });
    expect(parseLine(r)[0]).toMatchObject({ contextWindow: 1000000 });
  });

  it('expone las denegaciones de permisos', () => {
    const r = lines('stream-denied.jsonl').find((p) => p.kind === 'result') as ResultLine;
    expect(r.permissionDenials).toHaveLength(1);
  });
});

describe('classify', () => {
  it('done', () => {
    const c = classify(summarize('stream-done.jsonl'));
    expect(c.outcome).toBe('done');
    expect(c.faroResult?.summary).toBe('He creado hola.txt');
  });

  it('blocked con pregunta', () => {
    const c = classify(summarize('stream-blocked.jsonl'));
    expect(c.outcome).toBe('blocked');
    expect(c.faroResult?.question).toBe('¿Qué color uso?');
  });

  it('sin bloque faro-result → blocked con motivo', () => {
    const c = classify(summarize('stream-no-result.jsonl'));
    expect(c).toMatchObject({ outcome: 'blocked', faroResult: null });
    expect(c.error).toMatch(/faro-result/);
  });

  it('error de API', () => {
    expect(classify(summarize('stream-error.jsonl', { exitCode: 1 })).outcome).toBe('error');
  });

  it('límite de uso', () => {
    const s = summarize('stream-rate-limited.jsonl', { exitCode: 1 });
    expect(classify(s).outcome).toBe('rate_limited');
    expect(s.resetsAt).toBe(1792062600);
  });

  it('sesión caducada', () => {
    expect(classify(summarize('stream-auth.jsonl', { exitCode: 1 })).outcome).toBe('auth');
  });

  it('sin línea result y stderr de login → auth', () => {
    expect(classify({ result: null, rateLimitRejected: false, resetsAt: null, exitCode: 1, stderr: 'Not logged in · Please run /login', timedOut: false, cancelled: false }).outcome).toBe('auth');
  });

  it('sin línea result → error', () => {
    expect(classify({ result: null, rateLimitRejected: false, resetsAt: null, exitCode: 2, stderr: 'boom', timedOut: false, cancelled: false }).outcome).toBe('error');
  });

  it('un evento rejected no anula una ejecución completada', () => {
    const c = classify(summarize('stream-done.jsonl', { rateLimitRejected: true, resetsAt: 1792062600 }));
    expect(c.outcome).toBe('done');
  });

  it('429 en un resultado fallido es límite de uso aunque no haya evento rejected', () => {
    const result: ResultLine = {
      kind: 'result', isError: true, subtype: 'error_during_execution', text: 'Request rejected',
      inputTokens: 0, outputTokens: 0, apiErrorStatus: 429, permissionDenials: [], costUsd: null, contextWindow: null,
    };
    expect(classify({ result, rateLimitRejected: false, resetsAt: null, exitCode: 1, stderr: '', timedOut: false, cancelled: false }).outcome).toBe('rate_limited');
  });

  it('stderr que menciona /login-page no es sesión caducada', () => {
    const c = classify({ result: null, rateLimitRejected: false, resetsAt: null, exitCode: 1, stderr: 'hook: Authentication failed for /login-page', timedOut: false, cancelled: false });
    expect(c.outcome).toBe('error');
  });

  it('timeout y cancelación tienen prioridad', () => {
    expect(classify(summarize('stream-done.jsonl', { timedOut: true })).outcome).toBe('timeout');
    expect(classify(summarize('stream-done.jsonl', { cancelled: true })).outcome).toBe('interrupted');
  });
});
