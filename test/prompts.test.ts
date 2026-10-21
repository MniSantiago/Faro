import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../src/server/runner/args';
import { buildChatOpening, buildFollowUpPrompt, formatMessages, buildSystemPrompt, buildTaskPrompt } from '../src/server/runner/prompts';
import type { ProfileConfig, ProjectConfig } from '../src/server/types';
import { makeConfig, makeRepo, makeTask } from './helpers';

const profile: ProfileConfig = { id: 'ios', name: 'iOS', instructions: 'Instrucciones iOS.', defaultLevel: 2, timeoutMinutes: 45, model: 'opus' };
const project = { id: 'demo', name: 'Demo' } as ProjectConfig;

describe('prompts', () => {
  it('el system prompt incluye instrucciones, reglas y el contrato de salida', () => {
    const p = buildSystemPrompt(profile, project, 2);
    expect(p).toContain('Instrucciones iOS.');
    expect(p).toContain('```faro-result');
    expect(p).toContain('No cambies de rama');
    expect(p).not.toContain('solo lectura');
    expect(buildSystemPrompt(profile, project, 1)).toContain('solo lectura');
  });

  it('sin instrucciones el prompt es idéntico al de hoy', () => {
    expect(buildSystemPrompt(profile, project, 2)).toMatchInlineSnapshot(`
      "Eres el agente «iOS» de Faro y trabajas en el proyecto Demo.
      Instrucciones iOS.

      Reglas de Faro:
      - Trabajas en un git worktree aislado, en tu propia rama. No cambies de rama ni hagas merge, push, builds de EAS ni publiques nada: de eso se encarga Faro.
      - No hace falta que hagas commit: Faro commitea los cambios del worktree al terminar.
      - Si generas capturas, vídeos u otros archivos para revisión, guárdalos en .faro/artifacts/ y lista sus rutas en "artifacts".
      - Si te falta información o una decisión del usuario para continuar, termina con "status": "blocked" y pon tus preguntas en "questions" (máx. 4). Siempre que puedas, da 2-4 opciones concretas en "options", con la que recomiendas primero; usa "multiple": true si se pueden elegir varias.
      - Si el trabajo se divide mejor en tareas independientes para otros perfiles, propónlas en "subtasks": [{"title", "description", "profileId", "level"}] (nivel 1 consulta, 2 borrador, 3 integración automática). El usuario las aprueba antes de que empiecen.
      - Termina SIEMPRE tu último mensaje con un bloque como este, con JSON válido:
      \`\`\`faro-result
      {"status": "done", "summary": "qué hiciste, en 1-3 frases", "artifacts": [], "questions": []}
      \`\`\`
      Ejemplo de pregunta: {"status": "blocked", "summary": "…", "questions": [{"id": "color", "text": "¿Qué color uso para el botón?", "options": ["Ámbar (el de la marca)", "Azul"]}]}"
    `);
  });

  it('añade instrucciones y notas del proyecto tras las del perfil', () => {
    const proj = { ...project, instructions: 'Demo es una app.', profileNotes: { ios: 'Nota iOS.', web: 'Nota web.' } };
    const p = buildSystemPrompt(profile, proj, 2);
    expect(p).toContain('Instrucciones iOS.\nSobre Demo:\nDemo es una app.\nNota iOS.\n\nReglas de Faro:');
    expect(p).not.toContain('Nota web.');
    // Solo notas, sin instrucciones del proyecto.
    const solo = buildSystemPrompt(profile, { ...project, profileNotes: { ios: 'Nota iOS.' } }, 2);
    expect(solo).toContain('Instrucciones iOS.\nSobre Demo:\nNota iOS.\n\nReglas de Faro:');
  });

  it('multi-repo lista las subcarpetas', () => {
    const repos = [
      { id: 'api', name: 'API', path: '/x/api', baseBranch: 'main', remote: 'origin' },
      { id: 'web', path: '/x/web', baseBranch: 'main', remote: 'origin' },
    ];
    const p = buildSystemPrompt(profile, project, 2, { repos });
    expect(p).toContain('Tu carpeta tiene un repo por subcarpeta: api/ (API), web/ (web). Cada una es un git worktree en tu rama.');
    expect(buildSystemPrompt(profile, project, 2)).not.toContain('subcarpeta');
  });

  it('el prompt de tarea incluye id, título, descripción y contexto del padre', () => {
    const parent = makeTask({ id: 'DEM-3', title: 'Objetivo', description: 'Contexto grande' });
    const p = buildTaskPrompt(makeTask({ id: 'DEM-4', title: 'Hacer X', description: 'Detalles' }), parent);
    expect(p).toContain('Tarea DEM-4: Hacer X');
    expect(p).toContain('Detalles');
    expect(p).toContain('DEM-3 «Objetivo»');
  });

  it('el prompt de seguimiento usa la nota o un texto por defecto', () => {
    expect(buildFollowUpPrompt('Cambia el color')).toBe('Cambia el color');
    expect(buildFollowUpPrompt(null)).toBe('Continúa la tarea donde la dejaste.');
  });
});

describe('buildClaudeArgs', () => {
  it('sesión nueva', () => {
    const a = buildClaudeArgs({ sessionId: 's1', resume: false, level: 2, profile, systemPrompt: 'SYS' });
    expect(a.slice(0, 9)).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
      '--setting-sources', 'project', '--strict-mcp-config',
    ]);
    expect(a[a.indexOf('--model') + 1]).toBe('opus');
    expect(a).toEqual(expect.arrayContaining(['--append-system-prompt', 'SYS', '--session-id', 's1']));
    expect(a).not.toContain('--resume');
  });

  it('reanudar usa --resume con el mismo id', () => {
    const a = buildClaudeArgs({ sessionId: 's1', resume: true, level: 2, profile, systemPrompt: 'SYS' });
    expect(a[a.indexOf('--resume') + 1]).toBe('s1');
    expect(a).not.toContain('--session-id');
  });

  it('las listas de herramientas van al final y denegan push en todos los niveles', () => {
    for (const level of [1, 2, 3, 4] as const) {
      const a = buildClaudeArgs({ sessionId: 's', resume: false, level, profile, systemPrompt: 'S' });
      expect(a[a.length - 4]).toBe('--allowedTools');
      expect(a[a.length - 2]).toBe('--disallowedTools');
      expect(a[a.length - 1]).toContain('Bash(git push:*)');
    }
  });

  const valueOf = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

  it('aislamiento mínimo por defecto: sin skills, ni memoria, ni CLAUDE.md global, y solo las herramientas permitidas', () => {
    const a = buildClaudeArgs({ sessionId: 's', resume: false, level: 1, profile, systemPrompt: 'S' });
    expect(valueOf(a, '--setting-sources')).toBe('project');
    expect(a).toContain('--strict-mcp-config');
    expect(a).toContain('--disable-slash-commands');
    expect(JSON.parse(valueOf(a, '--settings'))).toEqual({
      autoMemoryEnabled: false, claudeMdExcludes: [join(homedir(), '.claude', 'CLAUDE.md')],
    });
    expect(valueOf(a, '--tools')).toBe('Read,Glob,Grep,WebSearch,WebFetch,Bash');
    const w = buildClaudeArgs({ sessionId: 's', resume: false, level: 2, profile, systemPrompt: 'S' });
    expect(valueOf(w, '--tools')).toBe('Read,Glob,Grep,WebSearch,WebFetch,Bash,Edit,Write,NotebookEdit');
    // Antes de las listas variádicas, que van al final.
    expect(a.indexOf('--tools')).toBeLessThan(a.indexOf('--allowedTools'));
  });

  it('con --mcp-config, el aislamiento mínimo deja ToolSearch para las herramientas MCP diferidas', () => {
    const a = buildClaudeArgs({ sessionId: 's', resume: false, level: 1, profile: { ...profile, mcpConfig: '/x/mcp.json' }, systemPrompt: 'S' });
    expect(valueOf(a, '--tools').split(',')).toContain('ToolSearch');
    expect(a).toContain('--strict-mcp-config');
  });

  it("isolation 'user' carga la configuración, skills y herramientas del usuario, pero solo los MCP del perfil", () => {
    const a = buildClaudeArgs({ sessionId: 's', resume: false, level: 1, profile: { ...profile, isolation: 'user' }, systemPrompt: 'S' });
    expect(valueOf(a, '--setting-sources')).toBe('user,project,local');
    expect(a).toContain('--strict-mcp-config');
    for (const flag of ['--disable-slash-commands', '--settings', '--tools']) expect(a).not.toContain(flag);
  });

  it('añade --mcp-config si el perfil lo define', () => {
    const a = buildClaudeArgs({ sessionId: 's', resume: false, level: 2, profile: { ...profile, mcpConfig: '/x/mcp.json' }, systemPrompt: 'S' });
    expect(a[a.indexOf('--mcp-config') + 1]).toBe('/x/mcp.json');
  });

  it('añade --effort del perfil y --max-budget-usd (el de la ejecución manda sobre el del perfil)', () => {
    const base = { sessionId: 's', resume: false, level: 2 as const, systemPrompt: 'S' };
    const plain = buildClaudeArgs({ ...base, profile });
    expect(plain).not.toContain('--effort');
    expect(plain).not.toContain('--max-budget-usd');
    const p2 = { ...profile, effort: 'medium' as const, maxBudgetUsd: 1.5 };
    const a = buildClaudeArgs({ ...base, profile: p2 });
    expect(a[a.indexOf('--effort') + 1]).toBe('medium');
    expect(a[a.indexOf('--max-budget-usd') + 1]).toBe('1.5');
    const b = buildClaudeArgs({ ...base, profile: p2, maxBudgetUsd: 0.75 });
    expect(b[b.indexOf('--max-budget-usd') + 1]).toBe('0.75');
    // Antes de las listas variádicas, que van al final.
    expect(b.indexOf('--max-budget-usd')).toBeLessThan(b.indexOf('--allowedTools'));
  });

  it('formatMessages lista los mensajes nuevos con su autor', () => {
    const c = (author: 'user' | 'faro', body: string) => ({ id: 1, taskId: 'X', author, body, createdAt: '', deliveredAt: null });
    expect(formatMessages([c('user', 'usa azul'), c('faro', 'DEM-3 está en revisión')])).toBe(
      'Mensajes nuevos desde tu último turno:\n\nUsuario: usa azul\n\nFaro: DEM-3 está en revisión');
  });
});

describe('prompts de chat', () => {
  it('el prompt del chat lista los perfiles y pide proponer subtareas', () => {
    const coord = { id: 'coordinador', name: 'Coordinador', instructions: 'Divides objetivos.', defaultLevel: 1 as const, timeoutMinutes: 20 };
    const ios = { id: 'ios', name: 'iOS', instructions: 'Trabajas en la app. Añades tests.', defaultLevel: 2 as const, timeoutMinutes: 45 };
    const proj = makeConfig(makeRepo()).projects[0];
    const p = buildSystemPrompt(coord, proj, 1, { chat: true, profiles: [coord, ios] });
    expect(p).toContain('- ios (iOS): Trabajas en la app.');
    expect(p).not.toContain('- coordinador');
    expect(p).toContain('conversación');
    expect(p).toContain('copia de solo lectura');
    expect(p).not.toContain('propia rama');
    expect(buildChatOpening()).toBe('Empieza una conversación nueva con el usuario.');
  });

  it('el chat añade a cada perfil su nota del proyecto y las instrucciones del proyecto van antes de la lista', () => {
    const coord = { id: 'coordinador', name: 'Coordinador', instructions: 'Divides objetivos.', defaultLevel: 1 as const, timeoutMinutes: 20 };
    const ios = { id: 'ios', name: 'iOS', instructions: 'Trabajas en la app. Añades tests.', defaultLevel: 2 as const, timeoutMinutes: 45 };
    const proj = { ...makeConfig(makeRepo()).projects[0], name: 'Demo', instructions: 'Demo es una app.', profileNotes: { ios: 'En Demo, carpeta app/.' } };
    const p = buildSystemPrompt(coord, proj, 1, { chat: true, profiles: [coord, ios] });
    expect(p).toContain('- ios (iOS): Trabajas en la app. En Demo, carpeta app/.');
    expect(p.indexOf('Sobre Demo:\nDemo es una app.')).toBeGreaterThan(p.indexOf('Divides objetivos.'));
    expect(p.indexOf('Sobre Demo:')).toBeLessThan(p.indexOf('Estás en una conversación'));
  });
});
