import type { FinalAction, Level, RetryWatchdogConfig } from './types';

/** Reglas que ningún agente puede usar: estas acciones solo las ejecuta Faro. */
export const ALWAYS_DENIED = [
  'Bash(git push:*)',
  'Bash(git merge:*)',
  'Bash(git rebase:*)',
  'Bash(git reset --hard:*)',
  'Bash(git switch:*)',
  'Bash(git checkout main:*)',
  'Bash(git worktree:*)',
  'Bash(git branch -d:*)',
  'Bash(git branch -D:*)',
  'Bash(eas:*)',
  'Bash(npx eas:*)',
  'Bash(npx eas-cli:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh release:*)',
  'Bash(git -C:*)',
  'Bash(git -c:*)',
  'Bash(git pull:*)',
  'Bash(git cherry-pick:*)',
  'Bash(git update-ref:*)',
  'Bash(git remote:*)',
  'Bash(git config:*)',
  'Bash(git clean:*)',
  'Bash(git checkout -B:*)',
  'Bash(sh -c:*)',
  'Bash(bash -c:*)',
  'Bash(zsh -c:*)',
  'Bash(env:*)',
  'Bash(command:*)',
  'Bash(npx -y eas:*)',
  'Bash(npx -y eas-cli:*)',
  'Bash(npx --yes eas:*)',
  'Bash(npx --yes eas-cli:*)',
  'Bash(npm exec eas:*)',
  'Bash(npm exec eas-cli:*)',
  'Bash(pnpm dlx eas-cli:*)',
  'Bash(yarn eas:*)',
  'Bash(bunx eas:*)',
  'Bash(bunx eas-cli:*)',
  'Bash(./node_modules/.bin/eas:*)',
  'Bash(npm run update:*)',
] as const;

/**
 * Entorno del proceso del agente: sin credenciales para push, GitHub ni EAS.
 * Barrera estructural: aunque una regla de prefijo se esquive, no hay credenciales ni destino de push.
 */
/** Esperas por defecto del modo de reintento desatendido: por debajo del tiempo máximo de cualquier perfil. */
export const RETRY_WATCHDOG_DEFAULT_MS = 5 * 60_000;

export function agentEnv(remotes: string | string[], ghReadToken: string | null = null, watchdog: RetryWatchdogConfig = {}): Record<string, string> {
  const git: [string, string][] = [
    // Un pushurl por remoto distinto (varios repos pueden tener remotos con otro nombre).
    ...[...new Set(typeof remotes === 'string' ? [remotes] : remotes)].map((r): [string, string] => [`remote.${r}.pushurl`, 'faro-sin-push://bloqueado']),
    // Un helper vacío vacía la lista: git no puede sacar credenciales del llavero ni de ningún helper.
    ['credential.helper', ''],
    // Un push a una URL https explícita (sin pasar por el remoto) también va a un destino inexistente.
    ['url.faro-sin-push://bloqueado/.pushInsteadOf', 'https://'],
    // Las URL ssh (scp «git@…» y «ssh://») también se reescriben a un destino inexistente.
    ['url.faro-sin-push://bloqueado/.pushInsteadOf', 'git@'],
    ['url.faro-sin-push://bloqueado/.pushInsteadOf', 'ssh://'],
  ];
  return {
    GIT_CONFIG_COUNT: String(git.length),
    ...Object.fromEntries(git.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
    // Y aunque algo se colara, no hay cliente SSH.
    GIT_SSH_COMMAND: 'false',
    GIT_TERMINAL_PROMPT: '0',
    // gh de solo lectura si hay token de lectura; si no, uno falso para que gh no use la sesión del usuario.
    GH_TOKEN: ghReadToken ?? 'faro-sin-acceso',
    GITHUB_TOKEN: ghReadToken ?? 'faro-sin-acceso',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    EXPO_TOKEN: 'faro-sin-acceso',
    // Reintentos con tope: sin él, una ejecución desatendida podría esperar horas a que se reinicie un límite de uso.
    // Al cortar sale como límite de uso y Faro pausa la cola hasta el reinicio.
    ...(watchdog.enabled === false ? {} : {
      CLAUDE_CODE_RETRY_WATCHDOG: '1',
      CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: String(watchdog.maxWaitMs ?? RETRY_WATCHDOG_DEFAULT_MS),
      CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS: String(watchdog.maxUsageLimitWaitMs ?? RETRY_WATCHDOG_DEFAULT_MS),
    }),
    // Desde la 2.1.300 los subagentes «fork» vienen activados en -p: copian todo el contexto del agente y van en segundo
    // plano (emiten un segundo `result`). Faro no los necesita; los subagentes normales siguen disponibles.
    CLAUDE_CODE_FORK_SUBAGENT: '0',
  };
}

/** Sin token de lectura, `gh` entero queda prohibido (además, su GH_TOKEN es falso). */
const GH_ALL = 'Bash(gh:*)';
/** Con token de lectura: los subcomandos que escriben siguen prohibidos (el token tampoco podría). */
export const GH_WRITE_DENIED = [
  'Bash(gh pr create:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr edit:*)', 'Bash(gh pr close:*)', 'Bash(gh pr reopen:*)',
  'Bash(gh pr review:*)', 'Bash(gh pr ready:*)', 'Bash(gh pr checkout:*)', 'Bash(gh pr lock:*)', 'Bash(gh pr unlock:*)',
  'Bash(gh issue create:*)', 'Bash(gh issue comment:*)', 'Bash(gh issue edit:*)', 'Bash(gh issue close:*)',
  'Bash(gh issue reopen:*)', 'Bash(gh issue delete:*)', 'Bash(gh issue transfer:*)', 'Bash(gh issue pin:*)',
  'Bash(gh issue lock:*)', 'Bash(gh issue develop:*)', 'Bash(gh repo:*)', 'Bash(gh api:*)', 'Bash(gh workflow:*)',
  'Bash(gh run rerun:*)', 'Bash(gh run cancel:*)', 'Bash(gh run delete:*)', 'Bash(gh run download:*)',
  'Bash(gh secret:*)', 'Bash(gh variable:*)', 'Bash(gh auth:*)', 'Bash(gh gist:*)', 'Bash(gh label:*)',
  'Bash(gh cache:*)', 'Bash(gh codespace:*)', 'Bash(gh extension:*)', 'Bash(gh alias:*)', 'Bash(gh config:*)',
  'Bash(gh ruleset:*)', 'Bash(gh project:*)', 'Bash(gh ssh-key:*)', 'Bash(gh gpg-key:*)', 'Bash(gh attestation:*)',
  'Bash(gh -R:*)', 'Bash(gh --repo:*)',
];
/** Lo que se permite de `gh` en nivel 1 (en los demás niveles vale `Bash` entero, con las prohibiciones de arriba). */
export const GH_READ_ALLOWED = [
  'Bash(gh pr view:*)', 'Bash(gh pr list:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr status:*)',
  'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh issue status:*)', 'Bash(gh run view:*)', 'Bash(gh run list:*)',
];

const READ_TOOLS = [
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(ls:*)',
];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/** `ghRead`: hay token de GitHub de solo lectura para los agentes; sin él, `gh` entero está prohibido. */
export function toolRules(level: Level, opts: { ghRead?: boolean } = {}): { allowed: string[]; disallowed: string[] } {
  const gh = opts.ghRead ? GH_WRITE_DENIED : [GH_ALL];
  if (level === 1) {
    // `git diff --output=<archivo>` escribe en disco aunque git diff sea de lectura.
    return {
      allowed: [...READ_TOOLS, ...(opts.ghRead ? GH_READ_ALLOWED : [])],
      disallowed: [...ALWAYS_DENIED, ...gh, ...WRITE_TOOLS, 'Bash(git diff --output:*)'],
    };
  }
  return { allowed: [...READ_TOOLS, ...WRITE_TOOLS, 'Bash'], disallowed: [...ALWAYS_DENIED, ...gh] };
}

/** Nivel mínimo a partir del cual Faro ejecuta la acción sin preguntar (null = siempre pregunta). */
// El merge automático además exige que se haya ejecutado al menos una comprobación y que todas pasen (orchestrator).
const AUTO_FROM: Record<FinalAction, Level | null> = { merge: 2, push: 4, eas: 4, publish: null };

export function decide(level: Level, action: FinalAction): 'auto' | 'ask' {
  const min = AUTO_FROM[action];
  return min !== null && level >= min ? 'auto' : 'ask';
}
