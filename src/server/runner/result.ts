import { z } from 'zod';

const Subtask = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  profileId: z.string().min(1),
  level: z.number().int().min(1).max(4),
  repos: z.array(z.string().min(1)).optional(),
});

const QuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(6).optional(),
  multiple: z.boolean().optional(),
});

const Schema = z.object({
  status: z.enum(['done', 'blocked']),
  summary: z.string().default(''),
  question: z.string().nullish().transform((v) => v ?? null),
  questions: z.array(QuestionSchema).max(4).default([]),
  artifacts: z.array(z.string()).default([]),
  subtasks: z.array(Subtask).default([]),
}).refine((o) => new Set(o.questions.map((q) => q.id)).size === o.questions.length, { message: 'ids de pregunta repetidos' })
  .transform((o) => ({
    ...o,
    questions: o.questions.length ? o.questions : o.question ? [{ id: 'q1', text: o.question }] : [],
  }));

export type FaroResult = z.infer<typeof Schema>;

const BLOCK = /```faro-result[^\n]*\n([\s\S]*?)```/g;

export function extractFaroResult(text: string): FaroResult | null {
  let last: string | null = null;
  for (const m of text.matchAll(BLOCK)) last = m[1];
  if (last === null) return null;
  try {
    const parsed = Schema.safeParse(JSON.parse(last));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
