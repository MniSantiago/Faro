import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Artifact } from '../src/server/types';
import { MediaArtifact } from '../src/web/components/MediaArtifact';

const art = (over: Partial<Artifact>): Artifact =>
  ({ id: 7, taskId: 'DEM-1', kind: 'image', path: 'shot.png', label: 'Captura', ...over });
const html = (a: Artifact) => renderToStaticMarkup(createElement(MediaArtifact, { artifact: a }));

describe('MediaArtifact', () => {
  it('una imagen es una miniatura enlazada al archivo completo en otra pestaña', () => {
    const out = html(art({}));
    expect(out).toMatch(/^<a [^>]*href="\/api\/artifacts\/7\/file"[^>]*target="_blank"[^>]*><img [^>]*class="thumb"/);
    expect(out).toContain('rel="noreferrer"');
    expect(out).toContain('alt="Captura"');
  });

  it('un vídeo conserva el reproductor', () => {
    expect(html(art({ kind: 'video' }))).toMatch(/^<video [^>]*src="\/api\/artifacts\/7\/file"[^>]*controls/);
  });

  it('otro archivo es un enlace con su nombre', () => {
    expect(html(art({ kind: 'file', label: 'informe.zip' }))).toMatch(/^<a [^>]*href="\/api\/artifacts\/7\/file"[^>]*>informe\.zip<\/a>$/);
  });
});
