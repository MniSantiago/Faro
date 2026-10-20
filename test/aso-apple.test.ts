import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPLE_TIMEOUT_MS, AppleError, hints, lookup, search, subtitle } from '../src/server/aso/apple';

const fx = (name: string) => readFileSync(join(__dirname, 'fixtures/aso', name), 'utf8');

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(body: string, status = 200) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('hints', () => {
  it('saca los términos del plist y envía la tienda', async () => {
    const { f, calls } = fakeFetch(fx('hints.plist'));
    const out = await hints(f, 'bloquear', '143454-8,29');
    expect(out.slice(0, 2)).toEqual(['bloquear aplicaciones', 'bloquear movil estudio']);
    expect(out).toHaveLength(10);
    expect(calls[0].url).toBe(
      'https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=bloquear',
    );
    expect(calls[0].headers['X-Apple-Store-Front']).toBe('143454-8,29');
  });
  it('codifica el término', async () => {
    const { f, calls } = fakeFetch(fx('hints.plist'));
    await hints(f, 'bloquear apps', '143454-8,29');
    expect(calls[0].url).toContain('term=bloquear%20apps');
  });
});

describe('hints · cuerpos raros', () => {
  it('HTML en vez de plist → AppleError con status null', async () => {
    const { f } = fakeFetch('<html><body>mantenimiento</body></html>');
    const err = await hints(f, 'a', '143454-8,29').catch((e) => e);
    expect(err).toBeInstanceOf(AppleError);
    expect(err.status).toBeNull();
  });
  it('plist válido sin sugerencias → []', async () => {
    const { f } = fakeFetch('<?xml version="1.0"?><plist version="1.0"><dict><key>hints</key><array></array></dict></plist>');
    expect(await hints(f, 'a', '143454-8,29')).toEqual([]);
  });
});

describe('search', () => {
  it('devuelve trackId, nombre y valoraciones', async () => {
    const { f, calls } = fakeFetch(fx('search.json'));
    const out = await search(f, 'bloquear apps', 'es');
    expect(out[0]).toMatchObject({ trackId: 1497465230, name: 'Opal: Tiempo de Pantalla Focus', ratingCount: 3213 });
    expect(out[0].rating).toBeCloseTo(4.689, 2);
    expect(calls[0].url).toBe(
      'https://itunes.apple.com/search?term=bloquear%20apps&country=es&entity=software&limit=200',
    );
  });
  it('0 si faltan las valoraciones', async () => {
    const { f } = fakeFetch(JSON.stringify({ results: [{ trackId: 1, trackName: 'X' }] }));
    expect(await search(f, 'x', 'es')).toEqual([{ trackId: 1, name: 'X', ratingCount: 0, rating: 0 }]);
  });
});

describe('lookup', () => {
  it('devuelve un Map por id', async () => {
    const { f, calls } = fakeFetch(fx('lookup.json'));
    const out = await lookup(f, ['1497465230', '1234567890'], 'es');
    expect(out.size).toBe(2);
    expect(out.get('1497465230')).toEqual({ name: 'Opal: Tiempo de Pantalla Focus', version: '4.20' });
    expect(out.get('1234567890')?.name).toBe('Demo: notas rápidas');
    expect(calls[0].url).toBe('https://itunes.apple.com/lookup?id=1497465230,1234567890&country=es');
  });
});

describe('subtitle', () => {
  it('lee el subtítulo de la cabecera, no el de las apps parecidas', async () => {
    const { f, calls } = fakeFetch(fx('app-page.html'));
    expect(await subtitle(f, '1497465230', 'es')).toBe('Productividad y Concentración');
    expect(calls[0].url).toBe('https://apps.apple.com/es/app/id1497465230');
  });
  it('null si la página no tiene subtítulo', async () => {
    const { f } = fakeFetch('<html><body><h1>Algo</h1><p>Sin subtítulo</p></body></html>');
    expect(await subtitle(f, '1', 'es')).toBeNull();
  });
  it('null si el subtítulo está vacío', async () => {
    const { f } = fakeFetch('<h1>X</h1> <p class="subtitle svelte-x">  </p>');
    expect(await subtitle(f, '1', 'es')).toBeNull();
  });
  it('una entidad numérica fuera de Unicode no lanza', async () => {
    const { f } = fakeFetch('<h1>X</h1> <p class="subtitle svelte-x">Hola &#x110000; &#99999999; ok</p>');
    expect(await subtitle(f, '1', 'es')).toBe('Hola &#x110000; &#99999999; ok');
  });
  it('decodifica entidades', async () => {
    const { f } = fakeFetch('<h1>X</h1> <p class="subtitle svelte-x">Foco &amp; calma</p>');
    expect(await subtitle(f, '1', 'es')).toBe('Foco & calma');
  });
});

describe('errores', () => {
  it('429 → AppleError con status', async () => {
    const { f } = fakeFetch('slow down', 429);
    for (const call of [
      () => hints(f, 'a', '143454-8,29'),
      () => search(f, 'a', 'es'),
      () => lookup(f, ['1'], 'es'),
      () => subtitle(f, '1', 'es'),
    ]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(AppleError);
      expect(err.status).toBe(429);
    }
  });
  it('HTML donde se esperaba JSON → AppleError con status null', async () => {
    const { f } = fakeFetch('<html>mantenimiento</html>');
    for (const call of [() => search(f, 'a', 'es'), () => lookup(f, ['1'], 'es')]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(AppleError);
      expect(err.status).toBeNull();
    }
  });
  it('fallo de red → AppleError con status null', async () => {
    const f = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const err = await search(f, 'a', 'es').catch((e) => e);
    expect(err).toBeInstanceOf(AppleError);
    expect(err.status).toBeNull();
  });
  it('cada petición lleva un AbortSignal y agotar el tiempo es AppleError con status null', async () => {
    expect(APPLE_TIMEOUT_MS).toBe(15_000);
    const signals: (AbortSignal | undefined)[] = [];
    const f = (async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    for (const call of [() => hints(f, 'a', 'x'), () => search(f, 'a', 'es'), () => lookup(f, ['1'], 'es'), () => subtitle(f, '1', 'es')]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(AppleError);
      expect(err.status).toBeNull();
      expect(err.message).toBe('Apple no respondió a tiempo');
    }
    expect(signals).toHaveLength(4);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });
  it('codifica appId y país en las URL', async () => {
    const { f, calls } = fakeFetch('{"results":[]}');
    await lookup(f, ['1&x=2'], 'e s');
    expect(calls[0].url).toBe('https://itunes.apple.com/lookup?id=1%26x%3D2&country=e%20s');
    const page = fakeFetch('<html></html>');
    await subtitle(page.f, '1/../2', 'es');
    expect(page.calls[0].url).toBe('https://apps.apple.com/es/app/id1%2F..%2F2');
  });
});
