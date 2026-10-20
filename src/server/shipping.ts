import { git, sh } from './exec';
import { isConflictTask } from './integrate';
import type { Store } from './store';
import type { ProjectConfig } from './types';

/** El último build de producción en la tienda (según EAS): de qué commit salió. */
export interface StoreBuild { version: string; buildNumber: string; commit: string; createdAt: string }

/** Una tarea (o un commit suelto) integrada en la rama base después del último build de la tienda. */
export interface Unshipped {
  taskId: string | null; title: string; commits: number; lastAt: string; touchesApp: boolean; state: string | null;
}

/** Último build de producción terminado según `eas build:list`, o null si no hay o EAS no responde. */
export async function fetchStoreBuild(project: ProjectConfig, timeoutMs = 90_000): Promise<StoreBuild | null> {
  if (!project.release) return null;
  const r = await sh('npx -y eas-cli build:list --platform ios --status finished --limit 10 --json --non-interactive', `${project.repoPath}/${project.release.cwd}`, timeoutMs);
  if (r.code !== 0) throw new Error(`EAS no respondió: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  const builds = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))) as {
    buildProfile?: string; appVersion?: string; appBuildVersion?: string; gitCommitHash?: string; createdAt?: string;
  }[];
  const b = builds.find((x) => x.buildProfile === 'production' && x.gitCommitHash);
  return b ? { version: b.appVersion ?? '?', buildNumber: b.appBuildVersion ?? '?', commit: b.gitCommitHash!, createdAt: b.createdAt ?? '' } : null;
}

/**
 * Lo integrado en la rama base desde `commit` (sin merges), agrupado por tarea según el prefijo del mensaje
 * («DEM-12: …»); los commits sin tarea salen sueltos. Más recientes primero.
 */
export async function unshipped(project: ProjectConfig, commit: string, store: Pick<Store, 'findTask'>): Promise<Unshipped[]> {
  const r = await git(project.repoPath, ['log', '--no-merges', '--format=%x1e%s%x1f%cI', '--name-only', `${commit}..${project.baseBranch}`]);
  if (r.code !== 0) throw new Error(`No se pudo leer git desde ${commit.slice(0, 9)}: ${r.stderr.trim()}`);
  const byKey = new Map<string, Unshipped>();
  const re = new RegExp(`^(${project.prefix}-\\d+):\\s*(.*)$`);
  // La app es la carpeta de release.cwd; con «.» (o sin release) todo el repo es la app.
  const cwd = project.release?.cwd.replace(/^\.\/?/, '').replace(/\/+$/, '') ?? '';
  const appDir = cwd ? `${cwd}/` : '';
  for (const rec of r.stdout.split('\x1e').slice(1)) {
    const [head, ...files] = rec.trim().split('\n');
    const [subject, at] = head.split('\x1f');
    const m = subject.match(re);
    // Una tarea de conflicto cuenta dentro de su tarea original.
    const found = m ? store.findTask(m[1]) : null;
    const task = found && isConflictTask(store, found) ? store.findTask(found.parentId!) : found;
    const key = task?.id ?? (m ? m[1] : `commit:${subject}:${at}`);
    const touchesApp = files.some((f) => f !== '' && f.startsWith(appDir));
    const cur = byKey.get(key);
    if (cur) {
      cur.commits += 1;
      cur.touchesApp ||= touchesApp;
      continue;
    }
    byKey.set(key, {
      taskId: task?.id ?? (m ? m[1] : null), title: task?.title ?? (m ? m[2] : subject), commits: 1, lastAt: at, touchesApp, state: task?.state ?? null,
    });
  }
  return [...byKey.values()];
}
