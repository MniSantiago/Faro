import { describe, expect, it } from 'vitest';
import { hashParam, leavesOnProjectChange, pickProject, projectOfTask, shouldSyncProject, withHashParam } from '../src/web/project';

describe('pickProject', () => {
  const ids = ['demo', 'acme'];
  it('pickProject usa ?p= si existe', () => {
    expect(pickProject(ids, 'p=acme', 'demo')).toBe('acme');
    expect(pickProject(ids, 'titulo=x&p=acme', null)).toBe('acme');
  });
  it('cae al guardado y luego al primero', () => {
    expect(pickProject(ids, '', 'acme')).toBe('acme');
    expect(pickProject(ids, 'p=nada', 'acme')).toBe('acme');
    expect(pickProject(ids, '', null)).toBe('demo');
    expect(pickProject([], '', 'acme')).toBeNull();
    // Con un solo proyecto, los avisos llevan `?p=` igual: se acepta.
    expect(pickProject(['demo'], 'p=demo', null)).toBe('demo');
    expect(pickProject(['demo'], 'p=demo', 'demo')).toBe('demo');
  });
  it('un guardado que ya no existe cae al primero', () => {
    expect(pickProject(ids, '', 'viejo')).toBe('demo');
  });
});

describe('projectOfTask', () => {
  const prefixes = [{ id: 'demo', prefix: 'DEM' }, { id: 'acme', prefix: 'ACM' }, { id: 'acme2', prefix: 'ACMO' }];
  it('projectOfTask por prefijo (ACM-3 → acme)', () => {
    expect(projectOfTask(prefixes, 'ACM-3')).toBe('acme');
    expect(projectOfTask(prefixes, 'DEM-120')).toBe('demo');
    expect(projectOfTask(prefixes, 'ACMO-1')).toBe('acme2');
    expect(projectOfTask(prefixes, 'XYZ-1')).toBeNull();
    expect(projectOfTask(prefixes, 'ACM')).toBeNull();
  });
});

describe('parámetros del hash', () => {
  it('lee y cambia ?p= sin tocar el resto de la query', () => {
    expect(hashParam('#/bandeja?p=acme', 'p')).toBe('acme');
    expect(hashParam('#/bandeja', 'p')).toBeNull();
    expect(withHashParam('#/nueva?titulo=Hola%20mundo&p=demo', 'p', 'acme')).toBe('#/nueva?titulo=Hola+mundo&p=acme');
    expect(withHashParam('#/bandeja?p=demo', 'p', null)).toBe('#/bandeja');
    expect(withHashParam('#/bandeja', 'p', 'acme')).toBe('#/bandeja?p=acme');
  });
});

describe('sincronizar con la tarea', () => {
  it('solo cuando cambia la tarea (o el desde), y si es de otro proyecto', () => {
    expect(shouldSyncProject(null, 'ACM-1', 'acme', 'demo')).toBe(true);
    // Ya sincronizada esa tarea: el usuario eligió otro proyecto y no se le lleva de vuelta.
    expect(shouldSyncProject('ACM-1', 'ACM-1', 'acme', 'demo')).toBe(false);
    expect(shouldSyncProject('ACM-1', 'DEM-2', 'demo', 'acme')).toBe(true);
    expect(shouldSyncProject(null, 'ACM-1', 'acme', 'acme')).toBe(false);
    expect(shouldSyncProject(null, 'X-1', null, 'demo')).toBe(false);
  });
  it('cambiar de proyecto en una tarea o en Nueva tarea ?desde= lleva a Inicio', () => {
    expect(leavesOnProjectChange('#/tarea/ACM-1')).toBe(true);
    expect(leavesOnProjectChange('#/nueva?desde=ACM-1')).toBe(true);
    expect(leavesOnProjectChange('#/nueva?titulo=x')).toBe(false);
    expect(leavesOnProjectChange('#/bandeja?p=acme')).toBe(false);
    expect(leavesOnProjectChange('')).toBe(false);
  });
});
