const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Horario legible para los cron sencillos de las rutinas; los demás se muestran tal cual. */
export function describeCron(expr: string | null): string {
  if (!expr) return 'solo a mano';
  const m = expr.trim().split(/\s+/);
  if (m.length !== 5 || !/^\d+$/.test(m[0]) || !/^\d+$/.test(m[1]) || m[3] !== '*') return expr;
  const at = `a las ${Number(m[1])}:${m[0].padStart(2, '0')}`;
  const [, , dom, , dow] = m;
  if (dom === '*' && dow === '*') return `todos los días ${at}`;
  if (dom === '*' && /^[0-6](,[0-6])*$/.test(dow)) {
    const names = dow.split(',').map((d) => DAYS[Number(d)]);
    return `${names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names.at(-1)}` : names[0]} ${at}`;
  }
  if (/^\d+$/.test(dom) && dow === '*') return `el día ${Number(dom)} de cada mes ${at}`;
  return expr;
}
