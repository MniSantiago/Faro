import { describe, expect, it, vi } from 'vitest';
import { Bus } from '../src/server/bus';
import { noticeTitle, Notifier } from '../src/server/notifier';
import type { PushMessage } from '../src/server/push';
import { Store } from '../src/server/store';
import type { QueueState, Task, TaskState } from '../src/server/types';
import { makeConfig, makeRepo } from './helpers';

function setup() {
  const config = makeConfig(makeRepo());
  config.projects[0].routines = [{ id: 'informe', name: 'Informe semanal', profileId: 'dev', level: 2, title: 'I', prompt: 'p' }];
  const store = new Store(':memory:');
  const bus = new Bus();
  const send = vi.fn(async (_m: PushMessage) => ({ sent: 0, failed: 0 }));
  const project = config.projects[0];
  const make = (over: { kind?: 'task' | 'chat'; routineId?: string } = {}) =>
    store.createTask(project, { title: 'Arreglar', description: '', profileId: 'dev', level: 2, ...over });
  const go = (t: Task, ...states: TaskState[]) => { let cur = t; for (const s of states) cur = store.setState(cur.id, s); return cur; };
  const notifier = new Notifier({ store, bus, push: { send }, config });
  return { store, bus, send, make, go, notifier };
}
const queue = (over: Partial<QueueState>): QueueState => ({ paused: false, reason: null, until: null, running: [], ...over });

describe('Notifier', () => {
  it('avisa al pasar a revisión, una sola vez por estado', () => {
    const { bus, send, make, go, notifier } = setup();
    const t = go(make(), 'queued', 'working');
    notifier.start();
    const r = go(t, 'review');
    bus.emitTask(r);
    bus.emitTask(r);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ title: 'DEM-1 en revisión', body: 'Arreglar', url: '/#/tarea/DEM-1' }, { projectId: 'demo' });
  });

  it('avisa cuando una tarea termina sola, sin pasar por revisión', () => {
    const { store, bus, send, make, go, notifier } = setup();
    const t = go(make(), 'queued', 'working');
    notifier.start();
    bus.emitTask(t);
    // Pasa por «review» en la base de datos, pero Faro no lo emite si se cierra sola.
    store.setState(t.id, 'review', { summary: 'Reel montado' });
    bus.emitTask(store.setState(t.id, 'done'));
    expect(send).toHaveBeenCalledWith({ title: 'DEM-1 terminada', body: 'Reel montado', url: '/#/tarea/DEM-1' }, { projectId: 'demo' });
  });

  it('no avisa al terminar una tarea que aprobaste tú desde revisión', () => {
    const { store, bus, send, make, go, notifier } = setup();
    const r = go(make(), 'queued', 'working', 'review');
    notifier.start();
    bus.emitTask(r);
    bus.emitTask(store.setState(r.id, 'done'));
    expect(send).not.toHaveBeenCalled();
  });

  it('no avisa de lo que ya estaba en revisión al arrancar', () => {
    const { bus, send, make, go, notifier } = setup();
    const r = go(make(), 'queued', 'working', 'review');
    notifier.start();
    bus.emitTask(r);
    expect(send).not.toHaveBeenCalled();
  });

  it('blocked: cuerpo = primera pregunta; sin preguntas, el motivo', () => {
    const { store, bus, send, make, go, notifier } = setup();
    const a = go(make(), 'queued', 'working');
    const b = go(make(), 'queued', 'working');
    notifier.start();
    bus.emitTask(store.setState(a.id, 'blocked', { questions: [{ id: 'q1', text: '¿Qué rama?' }, { id: 'q2', text: 'Otra' }] }));
    bus.emitTask(store.setState(b.id, 'blocked', { blockedReason: 'Falta permiso' }));
    expect(send).toHaveBeenNthCalledWith(1, { title: 'DEM-1 necesita tu respuesta', body: '¿Qué rama?', url: '/#/tarea/DEM-1' }, { projectId: 'demo' });
    expect(send).toHaveBeenNthCalledWith(2, { title: 'DEM-2 necesita tu respuesta', body: 'Falta permiso', url: '/#/tarea/DEM-2' }, { projectId: 'demo' });
  });

  it('tarea de rutina bloqueada: título con el nombre de la rutina', () => {
    const { store, bus, send, make, go, notifier } = setup();
    const t = go(make({ routineId: 'informe' }), 'queued', 'working');
    notifier.start();
    bus.emitTask(store.setState(t.id, 'blocked', { blockedReason: 'Sin acceso' }));
    expect(send).toHaveBeenCalledWith({ title: 'La rutina Informe semanal necesita ayuda', body: 'Sin acceso', url: '/#/tarea/DEM-1' }, { projectId: 'demo' });
  });

  it('chat a idle: «El Coordinador ha respondido» con 100 letras del resumen', () => {
    const { store, bus, send, make, go, notifier } = setup();
    const t = go(make({ kind: 'chat' }), 'queued', 'working');
    notifier.start();
    bus.emitTask(store.setState(t.id, 'idle', { summary: 'x'.repeat(150) }));
    expect(send).toHaveBeenCalledWith({ title: 'El Coordinador ha respondido', body: 'x'.repeat(100), url: '/#/tarea/DEM-1' }, { projectId: 'demo' });
  });

  it('aprobación pendiente nueva: un aviso; las ya vistas al arrancar, ninguno', () => {
    const { store, bus, send, make, go, notifier } = setup();
    const old = go(make(), 'queued', 'working', 'review');
    store.addApproval(old.id, 'push', 'pending');
    const t = go(make(), 'queued', 'working', 'review');
    notifier.start();
    bus.emitTask(old);
    expect(send).not.toHaveBeenCalled();
    store.addApproval(t.id, 'publish', 'pending');
    bus.emitTask(t);
    bus.emitTask(t);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ title: 'Aprobación pendiente: publicar', url: '/#/tarea/DEM-2' });
  });

  it('cola pausada: un aviso por motivo, y otro si vuelve a pausarse tras reanudar', () => {
    const { bus, send, notifier } = setup();
    notifier.start();
    bus.emitQueue(queue({ paused: true, reason: 'rate_limit' }));
    bus.emitQueue(queue({ paused: true, reason: 'rate_limit' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cola en pausa: límite de uso', url: '/#/bandeja' }));
    bus.emitQueue(queue({ paused: false }));
    bus.emitQueue(queue({ paused: true, reason: 'auth' }));
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Cola en pausa: sesión de Claude caducada' }));
  });

  it('cola ya pausada al arrancar: no vuelve a avisar del mismo motivo', () => {
    const { store, bus, send, make } = setup();
    void make;
    const n = new Notifier({ store, bus, push: { send }, queueState: () => queue({ paused: true, reason: 'auth' }) });
    n.start();
    bus.emitQueue(queue({ paused: true, reason: 'auth' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('blocked sin pregunta ni motivo: «Necesita tu ayuda»', () => {
    const { store, bus, send, make, go, notifier } = setup();
    const t = go(make(), 'queued', 'working');
    notifier.start();
    bus.emitTask(store.setState(t.id, 'blocked'));
    expect(send.mock.calls[0][0].body).toBe('Necesita tu ayuda');
  });

  it('start() devuelve la función para dejar de escuchar', () => {
    const { bus, send, make, go, notifier } = setup();
    const t = go(make(), 'queued', 'working');
    const stop = notifier.start();
    stop();
    bus.emitTask(go(t, 'review'));
    expect(send).not.toHaveBeenCalled();
  });

  it('push pendiente: un solo aviso agrupado por proyecto hasta que se sube', () => {
    const { store, bus, send, make, go, notifier } = setup();
    const a = go(make(), 'queued', 'working', 'review');
    const b = go(make(), 'queued', 'working', 'review');
    notifier.start();
    store.addApproval(a.id, 'push', 'pending');
    bus.emitTask(a);
    store.addApproval(b.id, 'push', 'pending');
    bus.emitTask(b);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ title: 'Cambios sin subir en Demo', url: '/#/bandeja?p=demo' });
    for (const t of [a, b]) for (const ap of store.listApprovals(t.id)) store.decideApproval(ap.id, 'approved');
    bus.emitTask(a);
    store.addApproval(a.id, 'push', 'pending');
    bus.emitTask(a);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('tarea parada más de 24 h en revisión o bloqueada: un aviso, también tras reiniciar', () => {
    const { store, bus, send, make, go, notifier } = setup();
    const t = go(make(), 'queued', 'working', 'review');
    go(make(), 'queued', 'working');
    notifier.start();
    const later = new Date(Date.now() + 25 * 3600_000);
    notifier.checkStale(new Date(Date.now() + 3600_000));
    expect(send).not.toHaveBeenCalled();
    notifier.checkStale(later);
    notifier.checkStale(later);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ title: 'DEM-1 lleva 1 d en revisión', url: '/#/tarea/DEM-1' });
    const again = new Notifier({ store, bus, push: { send } });
    again.start();
    again.checkStale(later);
    expect(send).toHaveBeenCalledTimes(1);
    // Vuelve a moverse y a pararse: se avisa otra vez.
    go(t, 'queued', 'working', 'review');
    again.checkStale(new Date(Date.now() + 50 * 3600_000));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('con un solo proyecto el título no cambia y el aviso lleva el proyecto', () => {
    const { bus, send, make, go, notifier } = setup();
    const t = go(make(), 'queued', 'working');
    notifier.start();
    bus.emitTask(go(t, 'review'));
    expect(send).toHaveBeenCalledWith({ title: 'DEM-1 en revisión', body: 'Arreglar', url: '/#/tarea/DEM-1' }, { projectId: 'demo' });
  });

  it('con dos proyectos el título lleva el nombre; la pausa de cola (global) no lleva proyecto', () => {
    const config = makeConfig(makeRepo());
    const other = makeConfig(makeRepo()).projects[0];
    config.projects.push({ ...other, id: 'otro', name: 'Acme', prefix: 'ACM' });
    const store = new Store(':memory:');
    const bus = new Bus();
    const send = vi.fn(async (_m: PushMessage, _o?: { projectId?: string }) => ({ sent: 0, failed: 0 }));
    new Notifier({ store, bus, push: { send }, config }).start();
    const t = store.createTask(config.projects[1], { title: 'Arreglar', description: '', profileId: 'dev', level: 2 });
    store.setState(t.id, 'queued'); store.setState(t.id, 'working');
    bus.emitTask(store.setState(t.id, 'review'));
    expect(send).toHaveBeenLastCalledWith({ title: 'Acme · ACM-1 en revisión', body: 'Arreglar', url: '/#/tarea/ACM-1' }, { projectId: 'otro' });
    bus.emitQueue(queue({ paused: true, reason: 'auth' }));
    expect(send).toHaveBeenLastCalledWith({ title: 'Cola en pausa: sesión de Claude caducada', body: 'Las tareas esperan hasta que reanudes la cola.', url: '/#/bandeja' });
  });
});

describe('noticeTitle', () => {
  const two = [{ id: 'demo', name: 'Demo' }, { id: 'acme', name: 'Acme' }];
  it('con un solo proyecto no lleva nombre', () => {
    expect(noticeTitle([two[0]], 'DEM-1 en revisión', 'demo')).toBe('DEM-1 en revisión');
  });
  it('con varios, el nombre delante; sin proyecto o si ya lo nombra, tal cual', () => {
    expect(noticeTitle(two, 'ACM-1 en revisión', 'acme')).toBe('Acme · ACM-1 en revisión');
    expect(noticeTitle(two, 'Cola en pausa')).toBe('Cola en pausa');
    expect(noticeTitle(two, 'Cambios sin subir en Acme', 'acme')).toBe('Cambios sin subir en Acme');
    expect(noticeTitle(two, 'X', 'borrado')).toBe('X');
  });
});
