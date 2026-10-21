import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentEnv, ALWAYS_DENIED, decide, toolRules } from '../src/server/policy';
import { gitSync, makeRepo } from './helpers';

describe('toolRules', () => {
  it('nivel 1 no puede escribir', () => {
    const r = toolRules(1);
    expect(r.allowed).not.toContain('Edit');
    expect(r.allowed).not.toContain('Write');
    expect(r.allowed).not.toContain('Bash');
    expect(r.disallowed).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']));
  });

  it('nivel 1 deniega git diff --output (escribiría archivos)', () => {
    expect(toolRules(1).disallowed).toContain('Bash(git diff --output:*)');
  });

  it.each([1, 2, 3, 4] as const)('nivel %i deniega todas las reglas de ALWAYS_DENIED', (level) => {
    expect(toolRules(level).disallowed).toEqual(expect.arrayContaining([...ALWAYS_DENIED]));
  });

  it.each([1, 2, 3, 4] as const)('nivel %i siempre deniega push, merge, eas y variantes', (level) => {
    const r = toolRules(level);
    for (const rule of [
      'Bash(git push:*)', 'Bash(git merge:*)', 'Bash(eas:*)', 'Bash(npx eas:*)', 'Bash(gh pr merge:*)',
      'Bash(git -C:*)', 'Bash(sh -c:*)', 'Bash(npx -y eas-cli:*)', 'Bash(gh:*)',
    ]) {
      expect(r.disallowed).toContain(rule);
    }
  });

  it.each([1, 2, 3, 4] as const)('nivel %i con token de lectura: gh de lectura sí, gh que escribe no', (level) => {
    const r = toolRules(level, { ghRead: true });
    expect(r.disallowed).not.toContain('Bash(gh:*)');
    for (const rule of ['Bash(gh pr merge:*)', 'Bash(gh pr create:*)', 'Bash(gh api:*)', 'Bash(gh issue comment:*)', 'Bash(gh release:*)', 'Bash(gh -R:*)']) {
      expect(r.disallowed).toContain(rule);
    }
    if (level === 1) expect(r.allowed).toEqual(expect.arrayContaining(['Bash(gh pr view:*)', 'Bash(gh run view:*)', 'Bash(gh issue list:*)']));
    else expect(r.allowed).toContain('Bash');
  });

  it('agentEnv: GH_TOKEN falso sin token de lectura y el de lectura si lo hay', () => {
    expect(agentEnv('origin').GH_TOKEN).toBe('faro-sin-acceso');
    expect(agentEnv('origin', 'tok').GH_TOKEN).toBe('tok');
    expect(agentEnv('origin', 'tok').GITHUB_TOKEN).toBe('tok');
  });

  it('niveles 2-4 pueden editar y usar Bash', () => {
    for (const level of [2, 3, 4] as const) {
      expect(toolRules(level).allowed).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash']));
    }
  });

  it('ninguna regla contiene comas (se pasan separadas por comas a la CLI)', () => {
    for (const rule of [...ALWAYS_DENIED, ...toolRules(2).allowed, ...toolRules(1).allowed]) {
      expect(rule).not.toContain(',');
    }
  });
});

describe('agentEnv', () => {
  it('quita credenciales y destino de push, con el remoto interpolado', () => {
    expect(agentEnv('origin')).toEqual({
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_0: 'remote.origin.pushurl',
      GIT_CONFIG_VALUE_0: 'faro-sin-push://bloqueado',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'url.faro-sin-push://bloqueado/.pushInsteadOf',
      GIT_CONFIG_VALUE_2: 'https://',
      GIT_CONFIG_KEY_3: 'url.faro-sin-push://bloqueado/.pushInsteadOf',
      GIT_CONFIG_VALUE_3: 'git@',
      GIT_CONFIG_KEY_4: 'url.faro-sin-push://bloqueado/.pushInsteadOf',
      GIT_CONFIG_VALUE_4: 'ssh://',
      GIT_SSH_COMMAND: 'false',
      GIT_TERMINAL_PROMPT: '0',
      GH_TOKEN: 'faro-sin-acceso',
      GITHUB_TOKEN: 'faro-sin-acceso',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      EXPO_TOKEN: 'faro-sin-acceso',
      CLAUDE_CODE_RETRY_WATCHDOG: '1',
      CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: '300000',
      CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS: '300000',
      CLAUDE_CODE_FORK_SUBAGENT: '0',
    });
    expect(agentEnv('upstream')['GIT_CONFIG_KEY_0']).toBe('remote.upstream.pushurl');
  });

  it('agentEnv con dos remotos iguales pone una sola pushurl; con dos distintos, dos', () => {
    expect(agentEnv(['origin', 'origin'])).toEqual(agentEnv('origin'));
    const e = agentEnv(['origin', 'upstream']);
    expect(e.GIT_CONFIG_COUNT).toBe('6');
    expect(e.GIT_CONFIG_KEY_0).toBe('remote.origin.pushurl');
    expect(e.GIT_CONFIG_KEY_1).toBe('remote.upstream.pushurl');
    expect(e.GIT_CONFIG_VALUE_1).toBe('faro-sin-push://bloqueado');
    expect([e.GIT_CONFIG_KEY_2, e.GIT_CONFIG_VALUE_2]).toEqual(['credential.helper', '']);
    expect([e.GIT_CONFIG_KEY_5, e.GIT_CONFIG_VALUE_5]).toEqual(['url.faro-sin-push://bloqueado/.pushInsteadOf', 'ssh://']);
    expect(e).not.toHaveProperty('GIT_CONFIG_KEY_6');
  });

  it('las esperas del modo de reintento desatendido son configurables y se puede apagar', () => {
    const e = agentEnv('origin', null, { maxWaitMs: 60_000, maxUsageLimitWaitMs: 0 });
    expect(e).toMatchObject({
      CLAUDE_CODE_RETRY_WATCHDOG: '1', CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: '60000', CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS: '0',
    });
    const off = agentEnv('origin', null, { enabled: false });
    expect(off).not.toHaveProperty('CLAUDE_CODE_RETRY_WATCHDOG');
    expect(off).not.toHaveProperty('CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS');
    expect(off.CLAUDE_CODE_FORK_SUBAGENT).toBe('0');
  });

  it('git push con ese entorno falla y no crea la rama en el remoto; sin él, sí funciona', () => {
    const root = mkdtempSync(join(tmpdir(), 'faro-policy-'));
    const bare = join(root, 'remote.git');
    const repo = join(root, 'repo');
    const git = (cwd: string, args: string[], env?: Record<string, string>) =>
      execFileSync('git', args, {
        cwd,
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env },
        stdio: 'pipe',
      }).toString();

    git(root, ['init', '--bare', '-b', 'main', bare]);
    git(root, ['init', '-b', 'main', repo]);
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);
    git(repo, ['remote', 'add', 'origin', bare]);

    expect(() => git(repo, ['push', 'origin', 'main'], agentEnv('origin'))).toThrow();
    expect(() => git(bare, ['rev-parse', '--verify', 'refs/heads/main'])).toThrow();

    git(repo, ['push', 'origin', 'main']);
    expect(git(bare, ['rev-parse', '--verify', 'refs/heads/main']).trim()).toHaveLength(40);
  });

  it('anula los credential helpers y redirige los push a URLs https explícitas', () => {
    const repo = mkdtempSync(join(tmpdir(), 'faro-policy-'));
    const git = (args: string[], env?: Record<string, string>) =>
      execFileSync('git', args, { cwd: repo, env: { ...process.env, ...env }, stdio: 'pipe' }).toString();
    git(['init', '-q', '-b', 'main']);
    git(['config', 'credential.helper', 'store']);
    expect(git(['config', '--get-all', 'credential.helper']).trim().split('\n').at(-1)).toBe('store');
    // Un valor vacío reinicia la lista: git no consulta ningún helper anterior.
    const helpers = git(['config', '--get-all', 'credential.helper'], agentEnv('origin')).split('\n');
    expect(helpers.at(-2)).toBe('');
    const url = git(['ls-remote', '--get-url', 'https://github.com/x/y.git'], agentEnv('origin')).trim();
    expect(url).toBe('https://github.com/x/y.git');
    git(['remote', 'add', 'gh', 'https://github.com/x/y.git']);
    expect(git(['remote', 'get-url', '--push', 'gh'], agentEnv('origin')).trim()).toBe('faro-sin-push://bloqueado/github.com/x/y.git');
  });
});

describe('decide', () => {
  it.each([
    [1, 'merge', 'ask'], [2, 'merge', 'auto'], [3, 'merge', 'auto'], [4, 'merge', 'auto'],
    [3, 'push', 'ask'], [4, 'push', 'auto'],
    [3, 'eas', 'ask'], [4, 'eas', 'auto'],
    [4, 'publish', 'ask'],
  ] as const)('nivel %i, %s → %s', (level, action, expected) => {
    expect(decide(level, action)).toBe(expected);
  });
});

it('agentEnv: ningún push sale, ni por el remoto ni por URL ssh, scp o https', () => {
  const repo = makeRepo();
  gitSync(repo, 'remote', 'add', 'origin', 'git@github.com:x/y.git');
  const env = { ...process.env, ...agentEnv('origin') };
  for (const target of ['origin', 'git@github.com:x/y.git', 'ssh://git@github.com/x/y.git', 'https://github.com/x/y.git']) {
    const r = spawnSync('git', ['push', target, 'main'], { cwd: repo, env, encoding: 'utf8', timeout: 10_000 });
    expect(r.status, target).not.toBe(0);
    expect(r.stderr, target).toMatch(/faro-sin-push/);
  }
  expect(env.GIT_SSH_COMMAND).toBe('false');
});
