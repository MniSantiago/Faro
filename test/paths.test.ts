import { describe, expect, it } from 'vitest';
import { artifactKind, isInside } from '../src/server/paths';

describe('paths', () => {
  it('isInside', () => {
    expect(isInside('/a/b', '/a/b/c.png')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/bc/x')).toBe(false);
    expect(isInside('/a/b', '/a/b/../../etc/passwd')).toBe(false);
  });

  it('artifactKind', () => {
    expect(artifactKind('x/captura.PNG')).toBe('image');
    expect(artifactKind('reel.mp4')).toBe('video');
    expect(artifactKind('notas.md')).toBe('file');
  });
});
