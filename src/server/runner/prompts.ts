import type { Comment, Level, ProfileConfig, ProjectConfig, Task } from '../types';

export const RESULT_FENCE = 'faro-result';

export function buildSystemPrompt(
  profile: ProfileConfig,
  project: ProjectConfig,
  level: Level,
  opts: { chat?: boolean; profiles?: ProfileConfig[]; ghRead?: boolean } = {},
): string {
  const lines = [
    `Eres el agente «${profile.name}» de Faro y trabajas en el proyecto ${project.name}.`,
    profile.instructions,
    '',
    'Reglas de Faro:',
    opts.chat
      ? '- Trabajas en una copia de solo lectura de la rama base; no cambies de rama ni hagas merge, push, builds de EAS ni publiques nada: de eso se encarga Faro.'
      : '- Trabajas en un git worktree aislado, en tu propia rama. No cambies de rama ni hagas merge, push, builds de EAS ni publiques nada: de eso se encarga Faro.',
    level === 1
      ? '- Esta tarea es de solo lectura: no modifiques archivos. Tu entrega es el resumen.'
      : '- No hace falta que hagas commit: Faro commitea los cambios del worktree al terminar.',
    ...(opts.ghRead
      ? ['- Puedes consultar GitHub con `gh` en solo lectura (gh pr view/list/diff/checks, gh issue view/list, gh run view/list): no crees, comentes ni fusiones nada.']
      : []),
    '- Si generas capturas, vídeos u otros archivos para revisión, guárdalos en .faro/artifacts/ y lista sus rutas en "artifacts".',
    '- Si te falta información o una decisión del usuario para continuar, termina con "status": "blocked" y pon tus preguntas en "questions" (máx. 4). Siempre que puedas, da 2-4 opciones concretas en "options", con la que recomiendas primero; usa "multiple": true si se pueden elegir varias.',
    '- Si el trabajo se divide mejor en tareas independientes para otros perfiles, propónlas en "subtasks": [{"title", "description", "profileId", "level"}] (nivel 1 consulta, 2 borrador, 3 integración automática). El usuario las aprueba antes de que empiecen.',
    '- Termina SIEMPRE tu último mensaje con un bloque como este, con JSON válido:',
    '```' + RESULT_FENCE,
    '{"status": "done", "summary": "qué hiciste, en 1-3 frases", "artifacts": [], "questions": []}',
    '```',
    'Ejemplo de pregunta: {"status": "blocked", "summary": "…", "questions": [{"id": "color", "text": "¿Qué color uso para el botón?", "options": ["Ámbar (el de la marca)", "Azul"]}]}',
  ];
  if (opts.chat) {
    const others = (opts.profiles ?? []).filter((p) => p.id !== profile.id);
    lines.splice(
      2,
      0,
      '',
      'Estás en una conversación con el usuario desde el panel de Faro. Cada mensaje suyo es un turno nuevo de esta misma sesión.',
      'Tu respuesta al usuario va en "summary" (puede tener varios párrafos, en Markdown).',
      'Ves el código actual de la rama base en solo lectura. No haces el trabajo: lo propones como "subtasks" para estos perfiles:',
      ...others.map((p) => `- ${p.id} (${p.name}): ${p.instructions.split('. ')[0].replace(/\.$/, '')}.`),
    );
  }
  return lines.join('\n');
}

export function buildChatOpening(): string {
  return 'Empieza una conversación nueva con el usuario.';
}

export function buildTaskPrompt(task: Task, parent: Task | null): string {
  const lines = [`Tarea ${task.id}: ${task.title}`, '', task.description || '(sin descripción)'];
  if (parent) lines.push('', `Contexto: forma parte de ${parent.id} «${parent.title}».`, parent.description);
  return lines.join('\n');
}

export function buildFollowUpPrompt(note: string | null): string {
  return note ?? 'Continúa la tarea donde la dejaste.';
}

export function formatMessages(list: Comment[]): string {
  const lines = list.map((c) => `${c.author === 'faro' ? 'Faro' : 'Usuario'}: ${c.body}`);
  return ['Mensajes nuevos desde tu último turno:', ...lines].join('\n\n');
}
