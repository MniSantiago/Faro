import { homedir } from 'node:os';
import { join } from 'node:path';
import { toolRules } from '../policy';
import type { Level, ProfileConfig } from '../types';

export interface ClaudeArgsInput {
  sessionId: string;
  resume: boolean;
  level: Level;
  profile: ProfileConfig;
  systemPrompt: string;
  /** Hay token de GitHub de solo lectura: se permite `gh` de lectura. */
  ghRead?: boolean;
  /** Tope de gasto de esta ejecución (el de la rutina); si falta, el del perfil. */
  maxBudgetUsd?: number;
}

/** El prompt no va aquí: se envía por stdin. Las listas variádicas van al final para no tragarse otros argumentos. */
export function buildClaudeArgs(i: ClaudeArgsInput): string[] {
  const { allowed, disallowed } = toolRules(i.level, { ghRead: i.ghRead });
  const minimal = (i.profile.isolation ?? 'minimal') === 'minimal';
  // MCP: solo los del perfil, también en 'user'. 'project' basta para el CLAUDE.md del repo.
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
    '--setting-sources', minimal ? 'project' : 'user,project,local', '--strict-mcp-config',
  ];
  if (minimal) {
    // Sin skills ni comandos, sin la memoria automática del usuario y sin ~/.claude/CLAUDE.md, que se cuela como
    // CLAUDE.md «de proyecto» porque ~ es ancestro del repo y de los worktrees.
    args.push('--disable-slash-commands', '--settings', JSON.stringify({
      autoMemoryEnabled: false, claudeMdExcludes: [join(homedir(), '.claude', 'CLAUDE.md')],
    }));
  }
  if (i.profile.model) args.push('--model', i.profile.model);
  if (i.profile.effort) args.push('--effort', i.profile.effort);
  const budget = i.maxBudgetUsd ?? i.profile.maxBudgetUsd;
  if (budget !== undefined) args.push('--max-budget-usd', String(budget));
  if (i.profile.mcpConfig) args.push('--mcp-config', i.profile.mcpConfig);
  args.push('--append-system-prompt', i.systemPrompt);
  args.push(i.resume ? '--resume' : '--session-id', i.sessionId);
  // Solo las definiciones de las herramientas permitidas: las demás (Workflow, Agent, Cron…) son miles de tokens por llamada.
  if (minimal) args.push('--tools', builtinTools(allowed, !!i.profile.mcpConfig).join(','));
  args.push('--allowedTools', allowed.join(','));
  args.push('--disallowedTools', disallowed.join(','));
  return args;
}

/** Herramientas integradas de las reglas permitidas (`Bash(git log:*)` → `Bash`), más ToolSearch si hay MCP que diferir. */
function builtinTools(allowed: string[], mcp: boolean): string[] {
  const names = [...new Set(allowed.map((r) => r.replace(/\(.*$/, '')))];
  return mcp ? [...names, 'ToolSearch'] : names;
}
