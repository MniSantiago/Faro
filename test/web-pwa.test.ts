import { describe, expect, it } from 'vitest';
import { mainScript } from '../src/web/pwa';

describe('mainScript', () => {
  it('saca el script principal del index.html que genera Vite', () => {
    expect(mainScript('<head><script type="module" crossorigin src="/assets/index-B9Vr8i1z.js"></script></head>')).toBe('/assets/index-B9Vr8i1z.js');
  });
  it('null si no hay build (desarrollo o error)', () => {
    expect(mainScript('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
    expect(mainScript('')).toBeNull();
  });
});
