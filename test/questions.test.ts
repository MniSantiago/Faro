import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../src/server/actions';
import { formatAnswers, summarizeQuestions, validateAnswers } from '../src/server/questions';

const qs = [
  { id: 'color', text: '¿Color?', options: ['Rojo', 'Azul'] },
  { id: 'idiomas', text: '¿Idiomas?', options: ['es', 'en'], multiple: true },
];

describe('questions', () => {
  it('summarizeQuestions', () => {
    expect(summarizeQuestions([qs[0]])).toBe('¿Color?');
    expect(summarizeQuestions(qs)).toBe('¿Color? (y 1 más)');
  });

  it('validateAnswers rechaza ids que no existen o tareas sin preguntas', () => {
    expect(() => validateAnswers(qs, { color: 'Rojo' })).not.toThrow();
    expect(() => validateAnswers(qs, { tamaño: 'grande' })).toThrow(BadRequestError);
    expect(() => validateAnswers(null, { color: 'Rojo' })).toThrow(BadRequestError);
  });

  it('formatAnswers: pregunta → respuesta, listas unidas y texto libre al final', () => {
    expect(formatAnswers(qs, { color: 'Azul', idiomas: ['es', 'en'] }, 'y hazlo hoy')).toBe(
      '**¿Color?** → Azul\n**¿Idiomas?** → es, en\n\ny hazlo hoy');
    expect(formatAnswers(qs, { color: 'Azul' })).toBe('**¿Color?** → Azul');
  });
});
