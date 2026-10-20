// Genera los iconos de la PWA (faro sobre el color de marca). Uso: npx tsx scripts/icons.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** PNG RGBA de 8 bits, filtro 0 en todas las filas. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profundidad
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

type RGB = [number, number, number];
const BRAND: RGB = [0xb4, 0x53, 0x09];
const WHITE: RGB = [0xff, 0xff, 0xff];
const LIGHT: RGB = [0xfd, 0xe6, 0x8a];

/** Coordenadas normalizadas 0..1 (y hacia abajo). */
const trapezoid = (x: number, y: number, y0: number, y1: number, hw0: number, hw1: number): boolean =>
  y >= y0 && y <= y1 && Math.abs(x - 0.5) <= hw0 + ((hw1 - hw0) * (y - y0)) / (y1 - y0);
const rect = (x: number, y: number, y0: number, y1: number, hw: number): boolean =>
  y >= y0 && y <= y1 && Math.abs(x - 0.5) <= hw;

function roundedBackground(x: number, y: number): boolean {
  const r = 0.18;
  const dx = Math.max(r - x, x - (1 - r), 0);
  const dy = Math.max(r - y, y - (1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/** Capas del dibujo de abajo arriba: color y alfa en un punto, o null si no pinta. */
interface Opts { fullBleed?: boolean; scale?: number }

function sample(px0: number, py0: number, opts: Opts): { c: RGB; a: number } | null {
  if (!opts.fullBleed && !roundedBackground(px0, py0)) return null;
  // El dibujo se reduce alrededor del centro (zona segura de los iconos maskable).
  const k = opts.scale ?? 1;
  const x = 0.5 + (px0 - 0.5) / k;
  const y = 0.5 + (py0 - 0.5) / k;
  let out: { c: RGB; a: number } = { c: BRAND, a: 1 };
  const paint = (c: RGB, a = 1) => {
    out = { c: out.c.map((v, i) => Math.round(v * (1 - a) + c[i]! * a)) as RGB, a: 1 };
  };
  // Haces de luz: abanicos desde la linterna hacia los lados.
  const ly = 0.29;
  for (const dir of [-1, 1]) {
    const t = (x - 0.5) * dir; // distancia horizontal desde el eje
    if (t > 0.07 && t < 0.44 && Math.abs(y - ly) <= 0.015 + (t - 0.07) * 0.2) paint(LIGHT, 0.55);
  }
  // Base, torre, banda de color, galería, linterna, tejado.
  if (rect(x, y, 0.84, 0.89, 0.2)) paint(WHITE);
  if (trapezoid(x, y, 0.38, 0.84, 0.085, 0.145)) paint(WHITE);
  if (trapezoid(x, y, 0.52, 0.6, 0.1, 0.113)) paint(BRAND);
  if (trapezoid(x, y, 0.68, 0.76, 0.123, 0.135)) paint(BRAND);
  if (rect(x, y, 0.34, 0.385, 0.125)) paint(WHITE);
  if (rect(x, y, 0.235, 0.34, 0.06)) paint(LIGHT);
  if (rect(x, y, 0.235, 0.34, 0.018)) paint(WHITE);
  if (trapezoid(x, y, 0.15, 0.235, 0.0, 0.085)) paint(WHITE);
  return out;
}

/**
 * Icono cuadrado RGBA con antialiasing 4x4. Por defecto, esquinas redondeadas transparentes;
 * `fullBleed` rellena todo el cuadrado y `scale` reduce el faro (maskable: 0.7).
 */
export function drawFaro(size: number, opts: Opts = {}): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const n = 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, cover = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const s = sample((i + (sx + 0.5) / n) / size, (j + (sy + 0.5) / n) / size, opts);
          if (!s) continue;
          r += s.c[0]; g += s.c[1]; b += s.c[2]; cover++;
        }
      }
      const o = (j * size + i) * 4;
      if (cover > 0) {
        px[o] = Math.round(r / cover);
        px[o + 1] = Math.round(g / cover);
        px[o + 2] = Math.round(b / cover);
        px[o + 3] = Math.round((cover / (n * n)) * 255);
      }
    }
  }
  return px;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'public');
  mkdirSync(dir, { recursive: true });
  const outputs: [string, number, Opts][] = [
    ['icon-192.png', 192, {}],
    ['icon-512.png', 512, {}],
    ['icon-maskable-192.png', 192, { fullBleed: true, scale: 0.7 }],
    ['icon-maskable-512.png', 512, { fullBleed: true, scale: 0.7 }],
    ['apple-touch-icon.png', 180, { fullBleed: true }],
  ];
  for (const [name, size, o] of outputs) {
    writeFileSync(join(dir, name), encodePng(size, size, drawFaro(size, o)));
    console.log(`${name} (${size}x${size})`);
  }
}
