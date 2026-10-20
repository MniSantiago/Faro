// Genera los iconos de la PWA (faro «haz de luz» sobre azul noche). Uso: npx tsx scripts/icons.ts
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
const NAVY: RGB = [0x1b, 0x22, 0x36];
const CREAM: RGB = [0xf4, 0xed, 0xe1];
const AMBER: RGB = [0xf2, 0xa9, 0x3b];

/** Punto dentro de un polígono convexo (vértices en cualquier sentido). */
function inPoly(x: number, y: number, pts: [number, number][]): boolean {
  let pos = false, neg = false;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[(i + 1) % pts.length]!;
    const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cr > 0) pos = true; else if (cr < 0) neg = true;
  }
  return !(pos && neg);
}

/** Rectángulo con esquinas de radio r. */
function inRoundRect(x: number, y: number, x0: number, y0: number, w: number, h: number, r: number): boolean {
  const dx = Math.max(x0 + r - x, x - (x0 + w - r), 0);
  const dy = Math.max(y0 + r - y, y - (y0 + h - r), 0);
  return x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h && dx * dx + dy * dy <= r * r;
}

/** Cápsula (trazo redondeado) de (x0,y) a (x1,y) con grosor w. */
function inCapsule(x: number, y: number, x0: number, x1: number, y0: number, w: number): boolean {
  const cx = Math.min(Math.max(x, x0), x1);
  return (x - cx) ** 2 + (y - y0) ** 2 <= (w / 2) ** 2;
}

function roundedBackground(x: number, y: number): boolean {
  const r = 0.18;
  const dx = Math.max(r - x, x - (1 - r), 0);
  const dy = Math.max(r - y, y - (1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/** Capas del dibujo de abajo arriba: color y alfa en un punto, o null si no pinta. */
interface Opts { fullBleed?: boolean; scale?: number }

// Logo «haz de luz» (viewBox 48×48 de Logo.tsx). `FILL` es la fracción del icono que ocupa ese cuadro.
const FILL = 0.8;
const CENTER: [number, number] = [27, 23.75]; // centro del dibujo dentro del cuadro 48×48

function sample(px0: number, py0: number, opts: Opts): { c: RGB; a: number } | null {
  if (!opts.fullBleed && !roundedBackground(px0, py0)) return null;
  // El dibujo se reduce alrededor del centro (zona segura de los iconos maskable).
  const k = (opts.scale ?? 1) * FILL;
  const x = CENTER[0] + ((px0 - 0.5) / k) * 48;
  const y = CENTER[1] + ((py0 - 0.5) / k) * 48;
  let out: { c: RGB; a: number } = { c: NAVY, a: 1 };
  const paint = (c: RGB, a = 1) => {
    out = { c: out.c.map((v, i) => Math.round(v * (1 - a) + c[i]! * a)) as RGB, a: 1 };
  };
  if (inPoly(x, y, [[22, 14], [46, 6], [46, 22]])) paint(AMBER, 0.55); // haz
  if (inPoly(x, y, [[17, 18], [23, 18], [25, 40], [15, 40]])) paint(CREAM); // torre
  if (inCapsule(x, y, 8, 32, 40, 3)) paint(CREAM); // base
  if (inRoundRect(x, y, 16, 11, 8, 6, 1.5)) paint(AMBER); // linterna
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
