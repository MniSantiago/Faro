import type { QueueState } from '../../server/types';

const REASON: Record<NonNullable<QueueState['reason']>, string> = {
  rate_limit: 'Límite de uso de Claude alcanzado',
  auth: 'La sesión de Claude no es válida: ejecuta «claude login» en el Mac',
  manual: 'Cola pausada',
};

export function QueueBanner({ queue, onResume, error }: { queue: QueueState; onResume: () => void; error?: string | null }) {
  const until = queue.until ? new Date(queue.until * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <div className="banner" role="alert">
      <span>{queue.reason ? REASON[queue.reason] : 'Cola pausada'}{until ? ` · se reanuda sola hacia las ${until}` : ''}{error ? ` · No se pudo reanudar: ${error}` : ''}</span>
      <button className="btn" onClick={onResume}>Reanudar ahora</button>
    </div>
  );
}
