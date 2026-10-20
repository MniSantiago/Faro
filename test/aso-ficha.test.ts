import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fichaWords, inFicha, normalizeKeyword, parseFicha } from '../src/server/aso/ficha';

const fixture = readFileSync(new URL('./fixtures/aso/ficha-es-mx.md', import.meta.url), 'utf8');

describe('parseFicha', () => {
  it('lee nombre, subtítulo y palabras clave', () => {
    const f = parseFicha(fixture);
    expect(f.name).toBe('Demo: notas rápidas');
    expect(f.subtitle).toBe('Apunta ideas sin distraerte');
    expect(f.keywords).toMatch(/,/);
    expect(f.keywords).not.toMatch(/, /);
  });
  it('devuelve null si falta una sección', () => {
    const f = parseFicha('## Nombre\n\n```\nSolo nombre\n```\n');
    expect(f).toEqual({ name: 'Solo nombre', subtitle: null, keywords: null });
  });
});

describe('normalizeKeyword', () => {
  it('minúsculas, sin tildes, espacios colapsados', () => {
    expect(normalizeKeyword('  Bloquear  APPS ')).toBe('bloquear apps');
    expect(normalizeKeyword('Adicción')).toBe('adiccion');
  });
  it('conserva la ñ', () => {
    expect(normalizeKeyword('niño')).toBe('niño');
  });
});

describe('inFicha', () => {
  const words = fichaWords({ name: null, subtitle: null, keywords: 'bloquear,apps,foco' });
  it('todas las palabras presentes', () => {
    expect(inFicha('bloquear apps', words)).toBe(true);
  });
  it('los plurales son palabras distintas', () => {
    expect(inFicha('bloquear app', words)).toBe(false);
  });
  it('parte nombre y subtítulo por no letras', () => {
    const w = fichaWords({ name: 'Demo: menos pantalla', subtitle: 'Más luz', keywords: null });
    expect(inFicha('mas luz', w)).toBe(true);
    expect(inFicha('demo pantalla', w)).toBe(true);
  });
});
