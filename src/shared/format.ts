export type ValueFormat = 'money' | 'int' | 'percent' | 'rating' | 'text';

export const STATE_ES: Record<string, string> = {
  READY_FOR_SALE: 'A la venta', WAITING_FOR_REVIEW: 'Esperando revisión', IN_REVIEW: 'En revisión',
  PREPARE_FOR_SUBMISSION: 'Preparando envío', PENDING_DEVELOPER_RELEASE: 'Pendiente de publicar',
  REJECTED: 'Rechazada', DEVELOPER_REJECTED: 'Retirada', METADATA_REJECTED: 'Metadatos rechazados',
};

const nf = (d: number) => ({ minimumFractionDigits: d, maximumFractionDigits: d });

/** Formato único (web e informe): es-ES; el MRR de RevenueCat va en dólares. */
export function formatValue(value: number | string | null, format: ValueFormat): string {
  if (value === null) return '—';
  if (typeof value === 'string') return format === 'text' ? STATE_ES[value] ?? value : value;
  switch (format) {
    case 'money': return value.toLocaleString('es-ES', { style: 'currency', currency: 'USD', currencyDisplay: 'code', ...nf(2) });
    case 'percent': return `${(value * 100).toLocaleString('es-ES', nf(1))} %`;
    case 'rating': return value.toLocaleString('es-ES', nf(1));
    default: return value.toLocaleString('es-ES', nf(0));
  }
}

/** Importe en dólares con coma decimal: «≈ 1,52 $»; «≥ 1,52 $» si falta el coste de alguna ejecución. */
export function formatUsd(n: number | null, partial = false): string {
  if (n === null) return '—';
  return `${partial ? '≥' : '≈'} ${n.toFixed(2).replace('.', ',')} $`;
}
