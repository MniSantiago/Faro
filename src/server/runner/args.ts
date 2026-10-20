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
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
    '--setting-sources', 'project,local', '--strict-mcp-config',
  ];
  if (i.profile.model) args.push('--model', i.profile.model);
  if (i.profile.effort) args.push('--effort', i.profile.effort);
  const budget = i.maxBudgetUsd ?? i.profile.maxBudgetUsd;
  if (budget !== undefined) args.push('--max-budget-usd', String(budget));
  if (i.profile.mcpConfig) args.push('--mcp-config', i.profile.mcpConfig);
  args.push('--append-system-prompt', i.systemPrompt);
  args.push(i.resume ? '--resume' : '--session-id', i.sessionId);
  args.push('--allowedTools', allowed.join(','));
  args.push('--disallowedTools', disallowed.join(','));
  return args;
}
