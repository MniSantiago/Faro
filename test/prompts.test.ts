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
    expect(a.slice(0, 11)).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
      '--setting-sources', 'project,local', '--strict-mcp-config', '--model', 'opus',
    ]);
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

  it('añade --mcp-config si el perfil lo define', () => {
    const a = buildClaudeArgs({ sessionId: 's', resume: false, level: 2, profile: { ...profile, mcpConfig: '/x/mcp.json' }, systemPrompt: 'S' });
    expect(a[a.indexOf('--mcp-config') + 1]).toBe('/x/mcp.json');
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
});
