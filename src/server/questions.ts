import { BadRequestError } from './errors';
import type { Question } from './types';

export type Answers = Record<string, string | string[]>;

export function summarizeQuestions(qs: Question[]): string {
  return qs.length > 1 ? `${qs[0].text} (y ${qs.length - 1} más)` : qs[0].text;
}

export function validateAnswers(qs: Question[] | null, answers: Answers): void {
  const ids = new Set((qs ?? []).map((q) => q.id));
  for (const k of Object.keys(answers)) {
    if (!ids.has(k)) throw new BadRequestError(`La pregunta «${k}» no existe en esta tarea`);
  }
}

export function formatAnswers(qs: Question[], answers: Answers, text?: string): string {
  const lines = qs
    .filter((q) => answers[q.id] !== undefined && String(answers[q.id]).trim() !== '')
    .map((q) => `**${q.text}** → ${([] as string[]).concat(answers[q.id]).join(', ')}`);
  return [lines.join('\n'), text?.trim()].filter(Boolean).join('\n\n');
}
