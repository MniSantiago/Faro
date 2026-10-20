import { describe, expect, it } from 'vitest';
import { extractFaroResult } from '../src/server/runner/result';

const block = (json: string) => `texto previo\n\n\`\`\`faro-result\n${json}\n\`\`\``;

describe('extractFaroResult', () => {
  it('lee un bloque válido y aplica valores por defecto', () => {
    expect(extractFaroResult(block('{"status":"done","summary":"ok"}'))).toEqual({
      status: 'done', summary: 'ok', question: null, questions: [], artifacts: [], subtasks: [],
    });
  });

  it('usa el último bloque si hay varios', () => {
    const text = `${block('{"status":"blocked","question":"a"}')}\n${block('{"status":"done","summary":"b"}')}`;
    expect(extractFaroResult(text)?.status).toBe('done');
  });

  it('devuelve null sin bloque, con JSON inválido o con estado desconocido', () => {
    expect(extractFaroResult('sin bloque')).toBeNull();
    expect(extractFaroResult(block('{status: done}'))).toBeNull();
    expect(extractFaroResult(block('{"status":"terminado"}'))).toBeNull();
  });

  it('lee subtareas del coordinador', () => {
    const r = extractFaroResult(block('{"status":"done","subtasks":[{"title":"A","profileId":"ios","level":2}]}'));
    expect(r?.subtasks).toEqual([{ title: 'A', description: '', profileId: 'ios', level: 2 }]);
  });
});

const qblock = (o: unknown) => '```faro-result\n' + JSON.stringify(o) + '\n```';

describe('faro-result · preguntas', () => {
  it('questions estructuradas', () => {
    const r = extractFaroResult(qblock({ status: 'blocked', questions: [{ id: 'color', text: '¿Color?', options: ['Rojo', 'Azul'] }, { id: 'idiomas', text: '¿Idiomas?', options: ['es', 'en', 'fr'], multiple: true }] }));
    expect(r?.questions).toEqual([
      { id: 'color', text: '¿Color?', options: ['Rojo', 'Azul'] },
      { id: 'idiomas', text: '¿Idiomas?', options: ['es', 'en', 'fr'], multiple: true },
    ]);
  });

  it('question antigua → una pregunta abierta q1', () => {
    expect(extractFaroResult(qblock({ status: 'blocked', question: '¿Qué color?' }))?.questions).toEqual([{ id: 'q1', text: '¿Qué color?' }]);
  });

  it('si vienen ambas, manda questions', () => {
    expect(extractFaroResult(qblock({ status: 'blocked', question: 'x', questions: [{ id: 'a', text: 'A' }] }))?.questions).toEqual([{ id: 'a', text: 'A' }]);
  });

  it('rechaza ids repetidos, más de 4 preguntas u opciones fuera de 2–6', () => {
    expect(extractFaroResult(qblock({ status: 'blocked', questions: [{ id: 'a', text: 'A' }, { id: 'a', text: 'B' }] }))).toBeNull();
    expect(extractFaroResult(qblock({ status: 'blocked', questions: [1, 2, 3, 4, 5].map((i) => ({ id: `q${i}`, text: 'x' })) }))).toBeNull();
    expect(extractFaroResult(qblock({ status: 'blocked', questions: [{ id: 'a', text: 'A', options: ['solo'] }] }))).toBeNull();
  });

  it('sin preguntas → array vacío', () => {
    expect(extractFaroResult(qblock({ status: 'done', summary: 'ok' }))?.questions).toEqual([]);
  });
});
