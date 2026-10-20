import { describe, expect, it } from 'vitest';
import { defaultDeviceName, urlBase64ToUint8Array } from '../src/web/push';

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
