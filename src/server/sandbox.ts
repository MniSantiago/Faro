import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Los agentes de nivel ≥ 2 tienen Bash: sin esto podrían llamar al API de Faro (127.0.0.1:<port>)
 * y aprobar o integrar su propio trabajo, escribir en la base de datos de Faro, o plantar hooks en
 * `.git/hooks` que luego ejecutaría el commit/merge del propio Faro. En macOS se lanzan dentro de un
 * perfil de Seatbelt (`sandbox-exec`) que lo permite todo salvo eso. Las comprobaciones corren el
 * código que escribió el agente, así que van bajo el mismo perfil.
 */

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Carpeta del propio Faro (este checkout). */
export const FARO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface SandboxPaths {
  faroDir: string;
  dataDir: string;
  repoPath: string;
  /** Donde viven los worktrees del proyecto: siempre escribible, aunque esté dentro del repo. */
  worktreesDir: string;
  home: string;
  ports: number[];
}

/** Ruta real si existe (Seatbelt ve /private/tmp, no /tmp); si no, la ruta absoluta tal cual. */
function real(p: string): string {
  const abs = path.resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Literal de cadena del lenguaje de perfiles (comillas y barras escapadas). */
function str(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Variantes de `base/…children`: con `base` resuelta a su ruta real y tal cual, si difieren
 * (p. ej. /tmp y /private/tmp). Se resuelve la base, no el hijo, porque el hijo puede no existir aún.
 */
function variants(base: string, ...children: string[]): string[] {
  return [...new Set([real(base), path.resolve(base)].map((b) => path.join(b, ...children)))];
}

/** Todos los directorios por encima de `p`, hasta `/` incluido. */
function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let d = path.dirname(p); ; d = path.dirname(d)) {
    out.push(d);
    if (d === path.dirname(d)) return out;
  }
}

const any = (kind: 'subpath' | 'literal' | 'regex', xs: string[]) => xs.map((x) => `(${kind} ${str(x)})`).join(' ');

export function sandboxProfile(o: SandboxPaths): string {
  const repoGit = (...c: string[]) => variants(o.repoPath, '.git', ...c);
  // Rutas protegidas: ni escribir dentro ni (vía sus antepasados) renombrarlas para esquivar la regla.
  const subpaths = [
    ...variants(o.faroDir),
    ...variants(o.dataDir, 'artifacts'),
    ...variants(o.home, 'Library', 'LaunchAgents'),
    ...variants(o.home, '.config', 'git'),
    ...repoGit('hooks'),
  ];
  // vapid.json también: si se pudiera mover fuera de dataDir, se leería la clave privada sin tocar la regla de lectura.
  const literals = [...repoGit('config'), ...variants(o.home, '.gitconfig'), ...variants(o.dataDir, 'vapid.json')];
  const dbFiles = variants(o.dataDir, 'faro.db');
  const dbs = dbFiles.map((f) => `^${regexEscape(f)}`);
  // Leer la base (y su WAL/SHM/diario) o las claves VAPID daría a un agente las sesiones y los avisos push.
  const dbReads = dbFiles.map((f) => `^${regexEscape(f)}(-wal|-shm|-journal)?$`);
  const expo = variants(o.home, '.expo');
  const repo = variants(o.repoPath);
  const guarded = [...subpaths, ...literals, ...dbFiles, ...expo, ...repo];
  const parents = [...new Set(guarded.flatMap(ancestors))].filter((d) => !guarded.includes(d));

  const lines = ['(version 1)', '(allow default)'];
  for (const port of o.ports.filter((p) => Number.isInteger(p) && p > 0)) {
    lines.push(`(deny network-outbound (remote tcp ${str(`*:${port}`)}))`);
  }
  // El checkout principal es de solo lectura (refs, árbol de trabajo, node_modules que luego ejecuta EAS)
  // salvo lo que necesita git dentro de un worktree: objetos y metadatos de los worktrees.
  // Seatbelt aplica la última regla que coincide: cada «allow» va después de su «deny».
  lines.push(`(deny file-write* ${any('subpath', repo)})`);
  lines.push(`(allow file-write* ${any('subpath', [...repoGit('objects'), ...repoGit('worktrees'), ...variants(o.worktreesDir)])})`);
  lines.push(`(deny file-write* ${any('subpath', subpaths)} ${any('literal', [...literals, ...parents])} ${any('regex', dbs)})`);
  lines.push(`(deny file-read* ${any('regex', dbReads)} ${any('literal', variants(o.dataDir, 'vapid.json'))})`);
  lines.push(`(deny file-read* file-write* ${any('subpath', expo)})`);
  // No se bloquea /usr/bin/security: Claude Code lee su propia sesión del llavero con ese comando
  // (sin él, «Not logged in»). Por eso los agentes pueden leer el llavero; la página Métricas lo advierte.
  return lines.join('\n');
}

/** ¿Se puede usar `sandbox-exec` aquí? */
export function sandboxAvailable(): boolean {
  return process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
}

/** Envuelve `cmd args` en `sandbox-exec -p <perfil>` si hay perfil y sandbox disponible. */
export function wrapSandbox(cmd: string, args: string[], profile: string | null | undefined): [string, string[]] {
  if (!profile || !sandboxAvailable()) return [cmd, args];
  return [SANDBOX_EXEC, ['-p', profile, cmd, ...args]];
}
