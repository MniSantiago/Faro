import { describe, expect, it } from 'vitest';
import { buildThread, composerMode, isPending } from '../src/web/thread';
import { makeTask } from './helpers';

const c = (id: number, at: string, author: 'user' | 'agent' | 'faro' = 'user', deliveredAt: string | null = at) =>
  ({ id, taskId: 'DEM-1', author, body: `c${id}`, createdAt: at, deliveredAt });
const e = (id: number, at: string, payload: unknown = { name: 'Read', input: {} }, kind: 'tool' | 'message' = 'tool') =>
  ({ id, runId: 1, taskId: 'DEM-1', kind, payload, createdAt: at });

describe('buildThread', () => {
  it('mezcla por fecha y agrupa los eventos seguidos', () => {
    const items = buildThread(
      [c(1, '2026-10-15T10:00:00Z'), c(2, '2026-10-15T10:05:00Z', 'agent')],
      [e(1, '2026-10-15T10:01:00Z'), e(2, '2026-10-15T10:02:00Z', { result: 'ok' }), e(3, '2026-10-15T10:03:00Z', { text: 'pienso' }, 'message')],
    );
    expect(items.map((i) => i.type)).toEqual(['comment', 'activity', 'comment']);
    const act = items[1] as Extract<typeof items[number], { type: 'activity' }>;
    expect(act.events.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(act.actions).toBe(1);
  });

  it('a igual hora, los eventos van antes que el comentario (el resumen cierra el turno)', () => {
    const items = buildThread([c(1, '2026-10-15T10:00:00Z', 'agent')], [e(1, '2026-10-15T10:00:00Z')]);
    expect(items.map((i) => i.type)).toEqual(['activity', 'comment']);
  });
});

describe('buildThread · mismo instante', () => {
  it('desempata por id dentro de cada tipo', () => {
    const at = '2026-10-15T10:00:00Z';
    const items = buildThread([c(2, at), c(1, at)], []);
    expect(items.map((i) => (i.type === 'comment' ? i.comment.id : 0))).toEqual([1, 2]);
    const act = buildThread([], [e(2, at), e(1, at)])[0] as Extract<ReturnType<typeof buildThread>[number], { type: 'activity' }>;
    expect(act.events.map((x) => x.id)).toEqual([1, 2]);
  });
});

describe('composerMode', () => {
  it('según el estado', () => {
    expect(composerMode(makeTask({ state: 'working' }))).toMatchObject({ enabled: true, canInterrupt: true });
    expect(composerMode(makeTask({ state: 'review' }))).toMatchObject({ enabled: true, canInterrupt: false, send: 'Pedir cambios' });
    expect(composerMode(makeTask({ state: 'blocked' }))).toMatchObject({ enabled: true, send: 'Responder y continuar' });
    expect(composerMode(makeTask({ state: 'idle', kind: 'chat' }))).toMatchObject({ enabled: true, send: 'Enviar' });
    expect(composerMode(makeTask({ state: 'queued' }))).toMatchObject({ enabled: true, canInterrupt: false, send: 'Enviar' });
    expect(composerMode(makeTask({ state: 'idle' }))).toMatchObject({ enabled: true, send: 'Enviar' });
    expect(composerMode(makeTask({ state: 'blocked', questions: [{ id: 'q', text: '¿?' }] })).enabled).toBe(false);
    expect(composerMode(makeTask({ state: 'done' })).enabled).toBe(false);
    expect(composerMode(makeTask({ state: 'draft' })).enabled).toBe(false);
  });
});

describe('isPending', () => {
  it('solo mensajes del usuario sin entregar', () => {
    expect(isPending(c(1, 'x', 'user', null), makeTask({ state: 'working' }))).toBe(true);
    expect(isPending(c(1, 'x', 'faro', null), makeTask({ state: 'working' }))).toBe(false);
    expect(isPending(c(1, 'x', 'user'), makeTask({ state: 'working' }))).toBe(false);
  });
});
