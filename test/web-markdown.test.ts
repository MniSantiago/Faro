import { describe, expect, it } from 'vitest';
import { safeUrl } from '../src/web/markdown';

describe('safeUrl', () => {
  it('deja pasar http(s) y quita el resto de esquemas', () => {
    expect(safeUrl('https://expo.dev/x')).toBe('https://expo.dev/x');
    expect(safeUrl('http://localhost:3200')).toBe('http://localhost:3200');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,hola')).toBeNull();
    expect(safeUrl('#/tarea/DEM-1')).toBeNull();
    expect(safeUrl('/api/tasks')).toBeNull();
  });
});
