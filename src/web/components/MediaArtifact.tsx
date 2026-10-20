import type { Artifact } from '../../server/types';
import { artifactUrl } from '../api';

/** Artefacto multimedia del panel «Resultado»: imagen en miniatura que se amplía en otra pestaña, vídeo con reproductor u otro archivo como enlace. */
export function MediaArtifact({ artifact: a }: { artifact: Artifact }) {
  const url = artifactUrl(a.id);
  if (a.kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="thumb-link" title={`${a.label} · ampliar`}>
        <img className="thumb" src={url} alt={a.label} loading="lazy" />
      </a>
    );
  }
  if (a.kind === 'video') return <video src={url} controls />;
  return <a href={url} target="_blank" rel="noreferrer">{a.label}</a>;
}
