import { describe, expect, it } from 'vitest';
import { extractAsoJson, importAsoResult } from '../src/server/aso/proposals';
import { Store } from '../src/server/store';
import type { ProjectConfig } from '../src/server/types';

const project = {
  id: 'demo', name: 'Demo',
  aso: { appId: '111', stores: [{ id: 'es', country: 'es', storefront: 'x', fichaFile: 'f.md' }] },
} as unknown as ProjectConfig;
const ficha = { name: 'Demo', subtitle: 'Foco sin distracciones', keywords: 'bloquear,apps,tiempo', why: 'mejor' };

describe('importAsoResult', () => {
  it('JSON válido: cuenta follow + unfollow + competidor + ficha', () => {
    const store = new Store(':memory:');
    store.aso.addKeyword('demo', 'es', 'viejo', 'user');
    const json = JSON.stringify({
      stores: { es: { follow: [{ keyword: 'detox', why: 'a' }], unfollow: [{ keyword: 'viejo', why: 'b' }], ficha } },
      competitors: [{ appId: '999', name: 'Forest', why: 'c' }],
    });
    expect(importAsoResult(store, project, 'DEM-1', json)).toEqual({ created: 4, errors: [] });
    const props = store.aso.listProposals('demo', 'pending');
    expect(props.map((p) => p.kind).sort()).toEqual(['competitor', 'ficha', 'follow', 'unfollow']);
    expect(props.every((p) => p.taskId === 'DEM-1')).toBe(true);
  });

  it('no repite propuestas ya hechas', () => {
    const store = new Store(':memory:');
    const json = JSON.stringify({ stores: { es: { follow: [{ keyword: 'detox', why: 'a' }] } } });
    importAsoResult(store, project, 'DEM-1', json);
    expect(importAsoResult(store, project, 'DEM-2', json)).toEqual({ created: 0, errors: [] });
  });

  it('nombre de 31 caracteres: no crea la ficha y lo apunta', () => {
    const store = new Store(':memory:');
    const r = importAsoResult(store, project, 'DEM-1', JSON.stringify({ stores: { es: { ficha: { ...ficha, name: 'x'.repeat(31) } } } }));
    expect(r.created).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('es');
    expect(store.aso.listProposals('demo')).toHaveLength(0);
  });

  it('keywords con espacios tras la coma o que repiten palabras del nombre o subtítulo se rechazan', () => {
    const store = new Store(':memory:');
    const a = importAsoResult(store, project, 'DEM-1', JSON.stringify({ stores: { es: { ficha: { ...ficha, keywords: 'bloquear, apps' } } } }));
    const b = importAsoResult(store, project, 'DEM-1', JSON.stringify({ stores: { es: { ficha: { ...ficha, keywords: 'foco,apps' } } } }));
    const c = importAsoResult(store, project, 'DEM-1', JSON.stringify({ stores: { es: { ficha: { ...ficha, keywords: 'x'.repeat(101) } } } }));
    for (const r of [a, b, c]) { expect(r.created).toBe(0); expect(r.errors).toHaveLength(1); }
  });

  it('no es JSON o no cumple el esquema: created 0 y un error', () => {
    const store = new Store(':memory:');
    expect(importAsoResult(store, project, 'DEM-1', 'no es json')).toMatchObject({ created: 0, errors: [expect.any(String)] });
    expect(importAsoResult(store, project, 'DEM-1', '{"stores":5}')).toMatchObject({ created: 0, errors: [expect.any(String)] });
    expect(store.aso.listProposals('demo')).toHaveLength(0);
  });

  it('ignora tiendas que no están en la config y omite keywords o appId vacíos', () => {
    const store = new Store(':memory:');
    const json = JSON.stringify({
      stores: { fr: { follow: [{ keyword: 'detox', why: 'a' }] }, es: { follow: [{ keyword: '  ', why: 'a' }] } },
      competitors: [{ appId: '', name: 'X', why: 'c' }],
    });
    const r = importAsoResult(store, project, 'DEM-1', json);
    expect(r.created).toBe(0);
    expect(r.errors).toHaveLength(2);
    expect(store.aso.listProposals('demo')).toHaveLength(0);
  });

  it('archivo vacío válido no crea nada', () => {
    const store = new Store(':memory:');
    expect(importAsoResult(store, project, 'DEM-1', '{"stores":{},"competitors":[]}')).toEqual({ created: 0, errors: [] });
  });

  it('la misma ficha pendiente no se vuelve a crear ni se rechaza; una distinta la sustituye', () => {
    const store = new Store(':memory:');
    const json = (f: object) => JSON.stringify({ stores: { es: { ficha: f } } });
    expect(importAsoResult(store, project, 'DEM-1', json(ficha)).created).toBe(1);
    expect(importAsoResult(store, project, 'DEM-1', json({ ...ficha, why: 'otro motivo' })).created).toBe(0);
    expect(store.aso.listProposals('demo', 'pending')).toHaveLength(1);
    expect(store.aso.listProposals('demo', 'rejected')).toHaveLength(0);
    expect(importAsoResult(store, project, 'DEM-2', json({ ...ficha, keywords: 'tiempo' })).created).toBe(1);
    expect(store.aso.listProposals('demo', 'pending')).toHaveLength(1);
    expect(store.aso.listProposals('demo', 'rejected')).toHaveLength(0);
    expect(store.aso.listProposals('demo', 'superseded')).toHaveLength(1);
  });

  it('una ficha rechazada por el usuario o ya aceptada no vuelve', () => {
    const store = new Store(':memory:');
    const json = (f: object) => JSON.stringify({ stores: { es: { ficha: f } } });
    importAsoResult(store, project, 'DEM-1', json(ficha));
    store.aso.decideProposal(store.aso.listProposals('demo', 'pending')[0]!.id, 'rejected');
    expect(importAsoResult(store, project, 'DEM-2', json(ficha)).created).toBe(0);
    const other = { ...ficha, keywords: 'tiempo' };
    importAsoResult(store, project, 'DEM-3', json(other));
    store.aso.decideProposal(store.aso.listProposals('demo', 'pending')[0]!.id, 'accepted');
    expect(importAsoResult(store, project, 'DEM-4', json(other)).created).toBe(0);
    expect(store.aso.listProposals('demo', 'pending')).toHaveLength(0);
  });

  it('una ficha sustituida sí puede volver', () => {
    const store = new Store(':memory:');
    const json = (f: object) => JSON.stringify({ stores: { es: { ficha: f } } });
    importAsoResult(store, project, 'DEM-1', json(ficha));
    importAsoResult(store, project, 'DEM-2', json({ ...ficha, keywords: 'tiempo' }));
    expect(importAsoResult(store, project, 'DEM-3', json(ficha)).created).toBe(1);
  });

  it('como mucho 10 follow por tienda; el resto se apunta', () => {
    const store = new Store(':memory:');
    const follow = Array.from({ length: 12 }, (_, i) => ({ keyword: `kw${i}`, why: 'a' }));
    const r = importAsoResult(store, project, 'DEM-1', JSON.stringify({ stores: { es: { follow } } }));
    expect(r.created).toBe(10);
    expect(r.errors).toEqual(['es: más de 10 follow, «kw10» omitida', 'es: más de 10 follow, «kw11» omitida']);
  });

  it('omite follow de keywords ya seguidas y unfollow de las que no se siguen', () => {
    const store = new Store(':memory:');
    store.aso.addKeyword('demo', 'es', 'Detox', 'user');
    const json = JSON.stringify({ stores: { es: { follow: [{ keyword: 'detox', why: 'a' }], unfollow: [{ keyword: 'nada', why: 'b' }] } } });
    const r = importAsoResult(store, project, 'DEM-1', json);
    expect(r.created).toBe(0);
    expect(r.errors).toEqual(['es: «detox» ya se sigue, omitida', 'es: «nada» no se sigue, no hay nada que dejar']);
  });

  it('rechaza competidores con appId no numérico', () => {
    const store = new Store(':memory:');
    const r = importAsoResult(store, project, 'DEM-1', JSON.stringify({ stores: {}, competitors: [{ appId: '12&x=1', name: 'X', why: 'c' }, { appId: ' 42 ', name: 'Y', why: 'c' }] }));
    expect(r.created).toBe(1);
    expect(r.errors).toEqual(['competidor con appId no numérico «12&x=1», omitido']);
    expect(store.aso.listProposals('demo', 'pending')[0]!.payload).toEqual({ appId: '42', name: 'Y' });
  });
});

describe('extractAsoJson', () => {
  it('devuelve el último bloque aso-json o null', () => {
    expect(extractAsoJson('nada')).toBeNull();
    const text = 'Uno:\n```aso-json\n{"stores":{"a":{}}}\n```\nCorrijo:\n```aso-json\n{"stores":{}}\n```\n\n```faro-result\n{}\n```';
    expect(extractAsoJson(text)).toBe('{"stores":{}}\n');
  });
});
