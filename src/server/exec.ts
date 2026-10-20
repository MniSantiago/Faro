import { execFile, spawn } from 'node:child_process';
import { wrapSandbox } from './sandbox';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Ejecuta un comando y nunca lanza: el código de salida va en el resultado (124 = tiempo agotado). */
export function exec(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, env: opts.env ?? process.env },
      (err, stdout, stderr) => {
        let code = 0;
        let errText = String(stderr);
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
          code = e.killed ? 124 : typeof e.code === 'number' ? e.code : 1;
          if (!errText.trim()) errText = e.message;
        }
        resolve({ code, stdout: String(stdout), stderr: errText });
      },
    );
  });
}

/**
 * Faro nunca ejecuta hooks de git en sus propias órdenes (commit, merge, worktree add…): un agente
 * podría haberlos plantado en el repo y correrían (igual que un fsmonitor) con los permisos de Faro, fuera del sandbox.
 */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

export function git(cwd: string, args: string[]): Promise<ExecResult> {
  return exec('git', [...NO_HOOKS, ...args], { cwd });
}

export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} falló: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export function sh(command: string, cwd: string, timeoutMs?: number): Promise<ExecResult> {
  return exec('/bin/sh', ['-c', command], { cwd, timeoutMs });
}

/**
 * Como `sh`, pero el comando corre en su propio grupo de procesos: `signal` o el tiempo máximo
 * matan el grupo entero (también los nietos). 130 = cancelado, 124 = tiempo agotado.
 */
export function shAbortable(
  command: string,
  cwd: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; sandboxProfile?: string | null } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) return resolve({ code: 130, stdout: '', stderr: 'cancelado' });
    const [cmd, argv] = wrapSandbox('/bin/sh', ['-c', command], opts.sandboxProfile);
    const child = spawn(cmd, argv, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    let reason: 'timeout' | 'abort' | null = null;
    const cap = (s: string, b: Buffer) => (s + b.toString()).slice(-1_000_000);
    child.stdout.on('data', (b: Buffer) => { stdout = cap(stdout, b); });
    child.stderr.on('data', (b: Buffer) => { stderr = cap(stderr, b); });
    const killGroup = () => {
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* ya terminó */ }
      setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* ya terminó */ } }, 3000).unref();
    };
    const timer = opts.timeoutMs ? setTimeout(() => { reason = 'timeout'; killGroup(); }, opts.timeoutMs) : undefined;
    const onAbort = () => { reason = 'abort'; killGroup(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { stderr += e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code: reason === 'abort' ? 130 : reason === 'timeout' ? 124 : code ?? 1, stdout, stderr });
    });
  });
}
