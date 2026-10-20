import { describe, expect, it } from 'vitest';
import { chatList, markSeen, navSection, parseSeen, seedSeen, unreadChats } from '../src/web/chats';
import { makeTask } from './helpers';

const chat = (id: string, over: Parameters<typeof makeTask>[0] = {}) =>
  makeTask({ id, kind: 'chat', state: 'idle', summary: 'Respuesta', updatedAt: '2026-10-18T10:00:00.000Z', ...over });

describe('unreadChats', () => {
  it('marca un chat idle actualizado después de visto', () => {
    expect(unreadChats([chat('C1')], { C1: '2026-10-18T09:00:00.000Z' })).toEqual(['C1']);
  });

  it('no marca uno visto después (o en el mismo instante)', () => {
    expect(unreadChats([chat('C1')], { C1: '2026-10-18T11:00:00.000Z' })).toEqual([]);
    expect(unreadChats([chat('C1')], { C1: '2026-10-18T10:00:00.000Z' })).toEqual([]);
  });

  it('un chat que nunca se abrió cuenta como no leído', () => {
    expect(unreadChats([chat('C1')], {})).toEqual(['C1']);
  });

  it('un chat bloqueado (espera tu respuesta) actualizado después de visto cuenta como no leído', () => {
    expect(unreadChats([chat('C1', { state: 'blocked' })], { C1: '2026-10-18T09:00:00.000Z' })).toEqual(['C1']);
    expect(unreadChats([chat('C2', { state: 'blocked', summary: null })], {})).toEqual(['C2']);
    expect(unreadChats([chat('C1', { state: 'blocked' })], { C1: '2026-10-18T10:00:00.000Z' })).toEqual([]);
  });

  it('no marca tareas bloqueadas, solo chats', () => {
    expect(unreadChats([makeTask({ id: 'T1', kind: 'task', state: 'blocked', updatedAt: '2026-10-18T10:00:00.000Z' })], {})).toEqual([]);
  });

  it('ignora chats sin respuesta, que no esperan tu mensaje y tareas', () => {
    const list = [
      chat('C1', { summary: null }),
      chat('C2', { state: 'working' }),
      chat('C3', { state: 'discarded' }),
      makeTask({ id: 'T1', kind: 'task', state: 'idle', summary: 'x', updatedAt: '2026-10-18T10:00:00.000Z' }),
    ];
    expect(unreadChats(list, {})).toEqual([]);
  });
});

describe('markSeen', () => {
  it('guarda su updatedAt sin mutar el original', () => {
    const seen = { C0: '2026-10-01T00:00:00.000Z' };
    const next = markSeen(seen, chat('C1'));
    expect(next).toEqual({ C0: '2026-10-01T00:00:00.000Z', C1: '2026-10-18T10:00:00.000Z' });
    expect(seen).toEqual({ C0: '2026-10-01T00:00:00.000Z' });
    expect(unreadChats([chat('C1')], next)).toEqual([]);
  });

  it('no retrocede si ya se vio una versión más nueva', () => {
    const seen = { C1: '2026-10-18T12:00:00.000Z' };
    expect(markSeen(seen, chat('C1'))).toBe(seen);
  });
});

describe('parseSeen', () => {
  it('lee un objeto de cadenas y descarta lo demás', () => {
    expect(parseSeen('{"C1":"2026-10-18T10:00:00.000Z","C2":3}')).toEqual({ C1: '2026-10-18T10:00:00.000Z' });
    expect(parseSeen(null)).toEqual({});
    expect(parseSeen('no json')).toEqual({});
    expect(parseSeen('[1,2]')).toEqual({});
  });
});

describe('seedSeen', () => {
  it('sin clave guardada (primera carga en el dispositivo): todos los chats actuales cuentan como vistos', () => {
    const list = [chat('C1'), chat('C2', { state: 'blocked', updatedAt: '2026-10-18T11:00:00.000Z' }), makeTask({ id: 'T1' })];
    const seed = seedSeen(null, list);
    expect(seed).toEqual({ C1: '2026-10-18T10:00:00.000Z', C2: '2026-10-18T11:00:00.000Z' });
    expect(unreadChats(list, seed!)).toEqual([]);
  });

  it('sin chats deja un objeto vacío, para que los chats nuevos sí cuenten', () => {
    expect(seedSeen(null, [])).toEqual({});
  });

  it('si la clave ya existe (aunque esté vacía o rota) no siembra nada', () => {
    expect(seedSeen('{}', [chat('C1')])).toBeNull();
    expect(seedSeen('', [chat('C1')])).toBeNull();
    expect(seedSeen('no json', [chat('C1')])).toBeNull();
  });
});

describe('chatList', () => {
  it('solo chats no archivados, más recientes primero', () => {
    const list = [
      chat('C1', { updatedAt: '2026-10-18T08:00:00.000Z' }),
      chat('C2', { updatedAt: '2026-10-18T09:00:00.000Z' }),
      chat('C3', { state: 'discarded' }),
      makeTask({ id: 'T1' }),
    ];
    expect(chatList(list).map((t) => t.id)).toEqual(['C2', 'C1']);
  });
});

describe('navSection', () => {
  const tasks = [chat('C1'), makeTask({ id: 'T1' })];
  it('asigna cada ruta a su entrada', () => {
    expect(navSection('/', tasks)).toBe('inicio');
    expect(navSection('/bandeja', tasks)).toBe('bandeja');
    expect(navSection('/inicio/gasto', tasks)).toBe('inicio');
    expect(navSection('/config', tasks)).toBe('config');
    expect(navSection('/config/rutinas/x', tasks)).toBe('config');
    expect(navSection('/historial', tasks)).toBe('bandeja');
    expect(navSection('/chats', tasks)).toBe('chats');
    expect(navSection('/chat/nuevo', tasks)).toBe('chats');
    expect(navSection('/tarea/C1', tasks)).toBe('chats');
    expect(navSection('/tarea/T1', tasks)).toBe('bandeja');
    expect(navSection('/rutinas', tasks)).toBe('rutinas');
    expect(navSection('/metricas', tasks)).toBe('metricas');
    expect(navSection('/dispositivos', tasks)).toBe('dispositivos');
    expect(navSection('/nueva?routine=x', tasks)).toBe(null);
  });
});
