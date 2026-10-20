import path from 'node:path';
import type { ArtifactKind } from './types';

export function isInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const VIDEO = new Set(['.mp4', '.mov', '.webm']);

export function artifactKind(file: string): ArtifactKind {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  return 'file';
}
