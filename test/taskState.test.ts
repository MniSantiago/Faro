import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, InvalidTransitionError } from '../src/server/taskState';

describe('máquina de estados', () => {
  it.each([
    ['draft', 'queued'], ['draft', 'discarded'],
    ['queued', 'working'], ['queued', 'blocked'], ['queued', 'discarded'],
    ['working', 'blocked'], ['working', 'review'], ['working', 'queued'],
    ['blocked', 'queued'], ['blocked', 'discarded'],
    ['review', 'queued'], ['review', 'done'], ['review', 'discarded'], ['review', 'blocked'],
  ] as const)('permite %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ['draft', 'working'], ['working', 'done'], ['working', 'discarded'],
    ['done', 'queued'], ['discarded', 'queued'], ['review', 'working'],
  ] as const)('no permite %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it('el error explica la transición', () => {
    expect(() => assertTransition('done', 'queued')).toThrow('Transición no permitida: done → queued');
  });
});

describe('transiciones con idle', () => {
  it('un chat pasa de working a idle, y de idle a queued o discarded', () => {
    expect(canTransition('working', 'idle')).toBe(true);
    expect(canTransition('idle', 'queued')).toBe(true);
    expect(canTransition('idle', 'discarded')).toBe(true);
    expect(canTransition('idle', 'review')).toBe(false);
    expect(canTransition('queued', 'idle')).toBe(false);
  });
});
