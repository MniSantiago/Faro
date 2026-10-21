import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/server/config';
import type { FaroConfig, ProjectConfig, Task } from '../src/server/types';

export function tmpDir(prefix = 'faro-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Repo con rama main y un commit inicial (README.md = "hola\n"). */
export function makeRepo(): string {
  const dir = tmpDir('faro-repo-');
  gitSync(dir, 'init', '-q', '-b', 'main');
  gitSync(dir, 'config', 'user.name', 'Faro Test');
  gitSync(dir, 'config', 'user.email', 'faro@test.local');
  writeFileSync(path.join(dir, 'README.md'), 'hola\n');
  gitSync(dir, 'add', '.');
  gitSync(dir, 'commit', '-qm', 'inicio');
  return dir;
}

export const FAKE_CLAUDE = path.resolve('test/fake-claude.mjs');
export const fixture = (name: string): string => path.resolve('test/fixtures', name);

export function makeConfig(repo: string, over: Partial<FaroConfig> = {}): FaroConfig {
  const data = tmpDir('faro-data-');
  return normalizeConfig({
    host: '127.0.0.1',
    port: 0,
    dataDir: data,
    claudeBin: FAKE_CLAUDE,
    maxConcurrentRuns: 2,
    // Los tests que prueban el sandbox lo activan explícitamente.
    sandbox: false,
    projects: [{
      id: 'demo', name: 'Demo', prefix: 'DEM', repoPath: repo, baseBranch: 'main', remote: 'origin',
      worktreesDir: path.join(data, 'wt'), startNumber: 1, prepare: [], checks: [],
    }],
    profiles: [{ id: 'dev', name: 'Dev', instructions: 'Eres un agente de prueba.', defaultLevel: 2, timeoutMinutes: 1 }],
    ...over,
  });
}

/** Config con un proyecto de dos repos reales (`a` y `b`). */
export function makeMultiConfig(over: Partial<FaroConfig> = {}): FaroConfig {
  const data = tmpDir('faro-data-');
  return normalizeConfig({
    host: '127.0.0.1', port: 0, dataDir: data, claudeBin: FAKE_CLAUDE, maxConcurrentRuns: 2, sandbox: false,
    projects: [{
      id: 'multi', name: 'Multi', prefix: 'MUL', worktreesDir: path.join(data, 'wt'), startNumber: 1,
      repos: [
        { id: 'a', path: makeRepo(), baseBranch: 'main', remote: 'origin', checks: [{ name: 'ca', command: 'true' }] },
        { id: 'b', path: makeRepo(), baseBranch: 'main', remote: 'origin', checks: [{ name: 'cb', command: 'true' }] },
      ],
    }],
    profiles: [{ id: 'dev', name: 'Dev', instructions: 'Eres un agente de prueba.', defaultLevel: 2, timeoutMinutes: 1 }],
    ...over,
  });
}

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'DEM-1', projectId: 'demo', title: 'Tarea', description: '', profileId: 'dev', state: 'queued', level: 2,
    parentId: null, routineId: null, branch: null, worktreePath: null, sessionId: null, sessionStarted: false, kind: 'task', questions: null, release: 'none', repos: null, nextPrompt: null,
    blockedReason: null, summary: null, attempts: 0, createdAt: '', updatedAt: '', ...over,
  };
}

/** Espera a que `fn()` sea true (sondeo cada 20 ms); falla tras `ms`. */
export async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('until: tiempo agotado');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Un proyecto normalizado sin `repos`, para editar sus campos sueltos y volver a normalizar. */
export function withoutRepos(p: ProjectConfig): ProjectConfig {
  const { repos: _repos, ...rest } = p;
  return rest;
}
