import { describe, expect, it } from 'vitest';
import { Bus } from '../src/server/bus';
import { getProject } from '../src/server/config';
import { Store } from '../src/server/store';
import { createSubtasks, notifyParent } from '../src/server/subtasks';
import { makeConfig, makeMultiConfig, makeRepo } from './helpers';

function env() {
  const config = makeConfig(makeRepo());
  const store = new Store(':memory:');
  const d = { store, config, bus: new Bus() };
  const parent = store.createTask(getProject(config, 'demo'), { title: 'Padre', description: '', profileId: 'dev', level: 2 });
  return { d, store, parent };
}
const sub = (over = {}) => ({ title: 'Hija', description: 'hacer algo', profileId: 'dev', level: 2, ...over });

describe('createSubtasks', () => {
  it('crea borradores con parentId y deja un aviso en el padre', () => {
    const { d, store, parent } = env();
    const out = createSubtasks(d, parent, [sub(), sub({ title: 'Otra' })]);
    expect(out.map((t) => [t.state, t.parentId])).toEqual([['draft', parent.id], ['draft', parent.id]]);
    expect(store.listUndelivered(parent.id).at(-1)?.body).toContain(`${out[0].id}, ${out[1].id}`);
  });

  it('nivel máximo 3', () => {
    const { d, parent } = env();
    expect(createSubtasks(d, parent, [sub({ level: 4 })])[0].level).toBe(3);
  });

  it('máximo 8 por turno; el resto se avisa', () => {
    const { d, store, parent } = env();
    const out = createSubtasks(d, parent, Array.from({ length: 10 }, (_, i) => sub({ title: `S${i}` })));
    expect(out).toHaveLength(8);
    expect(store.listUndelivered(parent.id).at(-1)?.body).toContain('2 descartadas');
  });

  it('perfil inexistente → no se crea, con aviso', () => {
    const { d, store, parent } = env();
    expect(createSubtasks(d, parent, [sub({ profileId: 'nadie' })])).toEqual([]);
    expect(store.listUndelivered(parent.id).at(-1)?.body).toContain('el perfil «nadie» no existe');
  });

  it('una subtarea no puede proponer más', () => {
    const { d, store, parent } = env();
    const [child] = createSubtasks(d, parent, [sub()]);
    expect(createSubtasks(d, store.getTask(child.id), [sub()])).toEqual([]);
    expect(store.listUndelivered(child.id).at(-1)?.body).toContain('una subtarea no puede proponer otras');
  });

  it('sin propuestas no hace nada', () => {
    const { d, store, parent } = env();
    expect(createSubtasks(d, parent, [])).toEqual([]);
    expect(store.listComments(parent.id)).toEqual([]);
  });
});

describe('títulos', () => {
  it('recorta el título y descarta los vacíos con aviso', () => {
    const { d, store, parent } = env();
    const out = createSubtasks(d, parent, [sub({ title: '  Hola  ' }), sub({ title: '   ' })]);
    expect(out.map((t) => t.title)).toEqual(['Hola']);
    expect(store.listUndelivered(parent.id).at(-1)?.body).toContain('sin título');
  });
});

describe('notifyParent', () => {
  it('deja un aviso pendiente de Faro en el padre; no en uno cerrado', () => {
    const { d, store, parent } = env();
    const [child] = createSubtasks(d, parent, [sub()]);
    store.updateTask(child.id, { summary: 'Listo el botón' });
    notifyParent(d, store.getTask(child.id));
    const last = store.listUndelivered(parent.id).at(-1)!;
    expect(last).toMatchObject({ author: 'faro' });
    expect(last.body).toBe(`${child.id} «Hija» está en revisión: Listo el botón`);
    store.setState(parent.id, 'discarded');
    const before = store.listComments(parent.id).length;
    notifyParent(d, store.getTask(child.id));
    expect(store.listComments(parent.id)).toHaveLength(before);
  });
});

describe('createSubtasks · repos', () => {
  function multiEnv(parentRepos?: string[]) {
    const config = makeMultiConfig();
    const store = new Store(':memory:');
    const d = { store, config, bus: new Bus() };
    const parent = store.createTask(getProject(config, 'multi'), { title: 'Padre', description: '', profileId: 'dev', level: 2, repos: parentRepos });
    return { d, store, parent };
  }

  it('una subtarea hereda los repos del padre', () => {
    const { d, parent } = multiEnv(['a', 'b']);
    expect(createSubtasks(d, parent, [sub()])[0]!.repos).toEqual(['a', 'b']);
    const m2 = multiEnv();
    expect(createSubtasks(m2.d, m2.parent, [sub()])[0]!.repos).toBeNull();
  });

  it('una subtarea puede proponer un subconjunto de los repos del padre', () => {
    const { d, parent } = multiEnv();
    expect(createSubtasks(d, parent, [sub({ repos: ['b'] })])[0]!.repos).toEqual(['b']);
  });

  it('una subtarea no puede añadir un repo que el padre no tiene', () => {
    const { d, store, parent } = multiEnv(['a']);
    const out = createSubtasks(d, parent, [sub({ repos: ['a', 'b'] }), sub({ title: 'Solo b', repos: ['b'] })]);
    expect(out.map((t) => t.repos)).toEqual([['a'], ['a']]);
    expect(store.listUndelivered(parent.id).at(-1)?.body).toContain('repos descartados porque MUL-1 no los tiene: b');
  });
});
