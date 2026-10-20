import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync, crc32 as zcrc } from 'node:zlib';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { drawFaro, encodePng } from '../scripts/icons';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PUBLIC = join(__dirname, '..', 'src', 'web', 'public');

function chunks(png: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let pos = 8;
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString('ascii');
    out.set(type, Buffer.concat([out.get(type) ?? Buffer.alloc(0), png.subarray(pos + 8, pos + 8 + len)]));
    pos += 12 + len;
  }
  return out;
}

describe('encodePng', () => {
  it('produce firma, IHDR con las dimensiones e IDAT del tamaño esperado', () => {
    const w = 7;
    const h = 5;
    const png = encodePng(w, h, new Uint8Array(w * h * 4).fill(200));
    expect(png.subarray(0, 8).equals(SIGNATURE)).toBe(true);
    const c = chunks(png);
    const ihdr = c.get('IHDR')!;
    expect(ihdr.readUInt32BE(0)).toBe(w);
    expect(ihdr.readUInt32BE(4)).toBe(h);
    expect(inflateSync(c.get('IDAT')!).length).toBe(h * (1 + w * 4));
    expect(c.has('IEND')).toBe(true);
  });
});

describe('drawFaro', () => {
  it('devuelve RGBA del tamaño pedido, con esquinas transparentes y centro opaco', () => {
    const size = 64;
    const px = drawFaro(size);
    expect(px.length).toBe(size * size * 4);
    expect(px[3]).toBe(0);
    const mid = ((size >> 1) * size + (size >> 1)) * 4;
    expect(px[mid + 3]).toBe(255);
  });
});

describe('PNG versionados', () => {
  for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-192.png', 192], ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180]] as const) {
    it(`${name} mide ${size}x${size}`, () => {
      const png = readFileSync(join(PUBLIC, name));
      expect(png.subarray(0, 8).equals(SIGNATURE)).toBe(true);
      const ihdr = chunks(png).get('IHDR')!;
      expect(ihdr.readUInt32BE(0)).toBe(size);
      expect(ihdr.readUInt32BE(4)).toBe(size);
    });
  }
});

describe('manifest', () => {
  it('es JSON válido con los campos de la marca', () => {
    const m = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
    expect(m).toMatchObject({
      name: 'Faro', short_name: 'Faro', start_url: '/', scope: '/', display: 'standalone',
      background_color: '#1b2236', theme_color: '#1b2236',
    });
    expect(m.icons).toEqual([
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
  });
});

describe('favicon.svg', () => {
  it('existe y usa el ámbar de la marca', () => {
    expect(readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8')).toContain('#f2a93b');
  });
});

describe('fullBleed y CRC', () => {
  it('fullBleed rellena las esquinas; el modo normal las deja transparentes', () => {
    expect(drawFaro(64, { fullBleed: true })[3]).toBe(255);
    expect(drawFaro(64, { fullBleed: true, scale: 0.7 })[3]).toBe(255);
    expect(drawFaro(64)[3]).toBe(0);
    for (const name of ['apple-touch-icon.png', 'icon-maskable-192.png']) {
      const png = readFileSync(join(PUBLIC, name));
      const { width } = { width: chunks(png).get('IHDR')!.readUInt32BE(0) };
      const raw = inflateSync(chunks(png).get('IDAT')!);
      expect(raw[1 + 3]).toBe(255);
      expect(raw[(width - 1) * 4 + 1 + 3]).toBe(255);
    }
  });

  it('cada chunk de un PNG generado tiene CRC correcto', () => {
    const png = encodePng(16, 16, drawFaro(16));
    let pos = 8;
    let count = 0;
    while (pos < png.length) {
      const len = png.readUInt32BE(pos);
      const body = png.subarray(pos + 4, pos + 8 + len);
      expect(png.readUInt32BE(pos + 8 + len)).toBe(zcrc(body));
      pos += 12 + len;
      count++;
    }
    expect(count).toBe(3);
  });
});

describe('sw.js safeUrl', () => {
  const origin = 'https://faro.tail1234.ts.net';
  const ctx: Record<string, unknown> = { URL, self: { location: { origin }, addEventListener() {} } };
  vm.createContext(ctx);
  const safeUrl = vm.runInContext(`${readFileSync(join(PUBLIC, 'sw.js'), 'utf8')}\n;safeUrl`, ctx) as (u: unknown) => string;

  it('acepta rutas del mismo origen', () => {
    expect(safeUrl('/#/tarea/X')).toBe('/#/tarea/X');
    expect(safeUrl(`${origin}/a?b=1#c`)).toBe('/a?b=1#c');
  });
  it('rechaza otros orígenes, javascript: y valores ausentes', () => {
    expect(safeUrl('https://evil.example/x')).toBe('/');
    expect(safeUrl('//evil.example/x')).toBe('/');
    expect(safeUrl('javascript:alert(1)')).toBe('/');
    expect(safeUrl(undefined)).toBe('/');
  });
});
