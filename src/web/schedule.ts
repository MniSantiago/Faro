/** Horario de una rutina tal como lo edita el formulario guiado. `custom` = un cron que el selector no representa. */
export type Schedule =
  | { kind: 'manual' }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; days: number[]; hour: number; minute: number }
  | { kind: 'monthly'; day: number; hour: number; minute: number }
  | { kind: 'custom'; cron: string };

/** Número sin ceros a la izquierda dentro del rango: así lo que se lee se vuelve a escribir igual. */
const num = (s: string, min: number, max: number): number | null =>
  /^(0|[1-9]\d*)$/.test(s) && Number(s) >= min && Number(s) <= max ? Number(s) : null;

/**
 * Lee un cron de 5 campos. Solo se reconocen las formas que `cronFromSchedule` escribe idénticas
 * (días de la semana 0-6 en orden y sin repetir); cualquier otra cosa queda como «Personalizado» tal cual.
 */
export function scheduleFromCron(cron: string | null): Schedule {
  if (cron === null) return { kind: 'manual' };
  const custom: Schedule = { kind: 'custom', cron };
  const f = cron.split(' ');
  if (f.length !== 5) return custom;
  const [mi, ho, dom, mon, dow] = f;
  const minute = num(mi, 0, 59);
  const hour = num(ho, 0, 23);
  if (minute === null || hour === null || mon !== '*') return custom;
  if (dom === '*' && dow === '*') return { kind: 'daily', hour, minute };
  if (dom === '*') {
    const days = dow.split(',').map((d) => num(d, 0, 6));
    const ordered = days.every((d, i) => d !== null && (i === 0 || d > days[i - 1]!));
    return ordered ? { kind: 'weekly', days: days as number[], hour, minute } : custom;
  }
  const day = num(dom, 1, 31);
  if (day !== null && dow === '*') return { kind: 'monthly', day, hour, minute };
  return custom;
}

/** El cron que guarda el formulario (null = solo a mano). Se supone válido: compruébalo antes con `scheduleError`. */
export function cronFromSchedule(s: Schedule): string | null {
  switch (s.kind) {
    case 'manual': return null;
    case 'daily': return `${s.minute} ${s.hour} * * *`;
    case 'weekly': return `${s.minute} ${s.hour} * * ${[...new Set(s.days)].sort((a, b) => a - b).join(',')}`;
    case 'monthly': return `${s.minute} ${s.hour} ${s.day} * *`;
    case 'custom': return s.cron.trim() ? s.cron : null;
  }
}

/** Motivo por el que el horario no se puede guardar, o null. */
export function scheduleError(s: Schedule): string | null {
  if (s.kind === 'manual') return null;
  if (s.kind === 'custom') return s.cron.trim() ? null : 'Escribe el cron';
  if (!Number.isInteger(s.hour) || s.hour < 0 || s.hour > 23 || !Number.isInteger(s.minute) || s.minute < 0 || s.minute > 59) return 'Hora no válida';
  if (s.kind === 'weekly' && s.days.length === 0) return 'Elige al menos un día de la semana';
  if (s.kind === 'monthly' && (!Number.isInteger(s.day) || s.day < 1 || s.day > 31)) return 'El día del mes va del 1 al 31';
  return null;
}
