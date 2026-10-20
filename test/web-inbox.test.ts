import { describe, expect, it } from 'vitest';
import { elapsed, inboxSections, inlineQuestion, taskTree, type TaskNode } from '../src/web/inbox';
import { makeTask } from './helpers';

const now = new Date(2026, 9, 18, 15, 0, 0); // 18-10-2026 15:00 hora local
const at = (d: number, h: number) => new Date(2026, 9, d, h, 0, 0).toISOString();

describe('inboxSections', () => {
  it('reparte por secciones, solo tareas, más recientes primero', () => {
    const tasks = [
      makeTask({ id: 'B1', state: 'blocked', updatedAt: at(18, 9) }),
      makeTask({ id: 'R1', state: 'review', updatedAt: at(18, 11) }),
      makeTask({ id: 'D1', state: 'draft', updatedAt: at(17, 8) }),
      makeTask({ id: 'W1', state: 'working', updatedAt: at(18, 10) }),
      makeTask({ id: 'Q1', state: 'queued', updatedAt: at(18, 12) }),
      makeTask({ id: 'H1', state: 'done', updatedAt: at(18, 1) }),
      makeTask({ id: 'H2', state: 'done', updatedAt: at(18, 14) }),
      makeTask({ id: 'AY', state: 'done', updatedAt: at(17, 23) }),
      makeTask({ id: 'X1', state: 'discarded', updatedAt: at(18, 9) }),
      makeTask({ id: 'C1', kind: 'chat', state: 'blocked', updatedAt: at(18, 13) }),
      makeTask({ id: 'C2', kind: 'chat', state: 'working', updatedAt: at(18, 13) }),
      makeTask({ id: 'C3', kind: 'chat', state: 'done', updatedAt: at(18, 13) }),
    ];
    const s = inboxSections(tasks, now);
    expect(s.need.map((t) => t.id)).toEqual(['R1', 'B1', 'D1']);
    expect(s.working.map((t) => t.id)).toEqual(['Q1', 'W1']);
    expect(s.doneToday.map((t) => t.id)).toEqual(['H2', 'H1']);
  });

  it('vacía sin tareas', () => {
    expect(inboxSections([], now)).toEqual({ need: [], working: [], doneToday: [] });
  });
});

describe('inlineQuestion', () => {
  const simple = { id: 'q1', text: '¿Dónde?', options: ['Aquí', 'Allí'] };

  it('devuelve la pregunta en el caso simple', () => {
    expect(inlineQuestion(makeTask({ state: 'blocked', questions: [simple] }))).toEqual(simple);
  });

  it('null con dos preguntas, con multiple, sin opciones o si no está bloqueada', () => {
    expect(inlineQuestion(makeTask({ state: 'blocked', questions: [simple, { ...simple, id: 'q2' }] }))).toBeNull();
    expect(inlineQuestion(makeTask({ state: 'blocked', questions: [{ ...simple, multiple: true }] }))).toBeNull();
    expect(inlineQuestion(makeTask({ state: 'blocked', questions: [{ id: 'q1', text: '¿?' }] }))).toBeNull();
    expect(inlineQuestion(makeTask({ state: 'blocked', questions: [{ id: 'q1', text: '¿?', options: [] }] }))).toBeNull();
    expect(inlineQuestion(makeTask({ state: 'blocked', questions: null }))).toBeNull();
    expect(inlineQuestion(makeTask({ state: 'review', questions: [simple] }))).toBeNull();
  });
});

describe('elapsed', () => {
  it('texto corto desde updatedAt', () => {
    const base = new Date('2026-10-18T12:00:00Z');
    expect(elapsed('2026-10-18T11:59:40Z', base)).toBe('ahora');
    expect(elapsed('2026-10-18T11:54:00Z', base)).toBe('6 min');
    expect(elapsed('2026-10-18T09:30:00Z', base)).toBe('2 h');
    expect(elapsed('2026-10-15T09:00:00Z', base)).toBe('3 d');
    expect(elapsed('', base)).toBe('ahora');
  });
});

describe('taskTree', () => {
  const ids = (nodes: TaskNode[]): unknown => nodes.map((n) => (n.children.length ? { [n.ghost ? `(${n.task.id})` : n.task.id]: ids(n.children) } : n.task.id));

  it('anida cada hija bajo su padre si está en la misma sección, conservando el orden', () => {
    const p = makeTask({ id: 'P', state: 'review' });
    const section = [makeTask({ id: 'A', state: 'review', parentId: 'P' }), p, makeTask({ id: 'S' }), makeTask({ id: 'B', state: 'draft', parentId: 'P' })];
    expect(ids(taskTree(section, section))).toEqual([{ P: ['A', 'B'] }, 'S']);
  });

  it('si el padre está en otra sección, agrupa a sus hijas bajo una cabecera del padre', () => {
    const p = makeTask({ id: 'P', state: 'working' });
    const section = [makeTask({ id: 'A', parentId: 'P' }), makeTask({ id: 'S' }), makeTask({ id: 'B', parentId: 'P' })];
    const tree = taskTree(section, [...section, p]);
    expect(ids(tree)).toEqual([{ '(P)': ['A', 'B'] }, 'S']);
    expect(tree[0].task).toBe(p);
  });

  it('nietas anidadas y padre desconocido como tarea suelta', () => {
    const section = [
      makeTask({ id: 'N', parentId: 'H' }), makeTask({ id: 'H', parentId: 'P' }), makeTask({ id: 'P' }), makeTask({ id: 'Z', parentId: 'NO' }),
    ];
    expect(ids(taskTree(section, section))).toEqual([{ P: [{ H: ['N'] }] }, 'Z']);
  });

  it('una nieta que aparece antes que su madre, con la abuela en otra sección, no duplica a la madre', () => {
    const section = [makeTask({ id: 'N', parentId: 'H' }), makeTask({ id: 'H', parentId: 'P' })];
    expect(ids(taskTree(section, [...section, makeTask({ id: 'P', state: 'done' })]))).toEqual([{ '(P)': [{ H: ['N'] }] }]);
  });
});
