import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rotateLogs } from '../src/server/logs';
import { tmpDir } from './helpers';

describe('rotateLogs', () => {
  it('copia y vacía los logs grandes, conservando 3', () => {
    const dir = tmpDir();
    const out = path.join(dir, 'out.log');
    for (const n of [1, 2, 3]) writeFileSync(`${out}.${n}`, `viejo${n}`);
    writeFileSync(out, 'x'.repeat(20));
    writeFileSync(path.join(dir, 'err.log'), 'poco');
    rotateLogs(dir, { maxBytes: 10, keep: 3 });
    expect(readFileSync(out, 'utf8')).toBe('');
    expect(readFileSync(`${out}.1`, 'utf8')).toBe('x'.repeat(20));
    expect(readFileSync(`${out}.2`, 'utf8')).toBe('viejo1');
    expect(readFileSync(`${out}.3`, 'utf8')).toBe('viejo2');
    expect(existsSync(`${out}.4`)).toBe(false);
    expect(readFileSync(path.join(dir, 'err.log'), 'utf8')).toBe('poco');
  });

  it('sin carpeta de logs no falla', () => {
    expect(() => rotateLogs(path.join(tmpDir(), 'no-existe'))).not.toThrow();
  });
});
