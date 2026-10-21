import { describe, expect, it } from 'vitest';
import { defaultDeviceName, urlBase64ToUint8Array } from '../src/web/push';
import { pushSummary } from '../src/web/push-state';
import type { PushState } from '../src/web/api';

describe('urlBase64ToUint8Array', () => {
  it('decodifica base64url con - y _ y sin relleno', () => {
    // bytes 0xfb 0xff 0xfe -> base64 "+//+" -> base64url "-__-"
    expect([...urlBase64ToUint8Array('-__-')]).toEqual([0xfb, 0xff, 0xfe]);
    // 1 byte (0xff) -> "/w==" -> "_w" sin relleno
    expect([...urlBase64ToUint8Array('_w')]).toEqual([0xff]);
    // "hola" -> "aG9sYQ"
    expect([...urlBase64ToUint8Array('aG9sYQ')]).toEqual([104, 111, 108, 97]);
  });
});

describe('defaultDeviceName', () => {
  it('según el user agent', () => {
    expect(defaultDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('iPhone');
    expect(defaultDeviceName('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('iPad');
    expect(defaultDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Mac');
    expect(defaultDeviceName('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Navegador');
  });
});

describe('pushSummary', () => {
  const base: PushState = { id: 'p', name: 'P', remote: 'origin', baseBranch: 'main', multiRepo: false, ahead: 0, repos: [], pending: [] };
  it('un repo: su rama base y su remoto', () => {
    expect(pushSummary({ ...base, ahead: 1, repos: [{ id: 'main', name: 'main', remote: 'origin', baseBranch: 'main', ahead: 1 }] }))
      .toBe('main va 1 commit por delante de origin');
  });
  it('varios repos: cada uno con su rama base, solo los que van por delante', () => {
    const repos = [
      { id: 'mobile', name: 'App', remote: 'origin', baseBranch: 'main', ahead: 2 },
      { id: 'web', name: 'Web', remote: 'up', baseBranch: 'develop', ahead: 1 },
    ];
    expect(pushSummary({ ...base, multiRepo: true, ahead: 3, repos }))
      .toBe('App: main va 2 commits por delante de origin · Web: develop va 1 commit por delante de up');
  });
  it('sin commits por delante: las tareas con el push pendiente', () => {
    expect(pushSummary({ ...base, pending: ['A-1', 'A-2'] })).toBe('2 tareas con el push pendiente');
    expect(pushSummary({ ...base, pending: ['A-1'] })).toBe('1 tarea con el push pendiente');
  });
});
