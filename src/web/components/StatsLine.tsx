import type { TaskStats } from '../../server/types';
import { contextLevel, formatTokens, formatUsd } from '../format';

/** Cabecera: contexto (con barra), coste equivalente, turnos y modelo. */
export function StatsLine({ stats }: { stats: TaskStats }) {
  const level = contextLevel(stats.contextTokens, stats.contextWindow);
  const pct = stats.contextTokens === null || !(stats.contextWindow > 0)
    ? null : Math.min(100, Math.round((stats.contextTokens / stats.contextWindow) * 100));
  return (
    <p className="stats">
      <span>
        Contexto{' '}
        {pct !== null && level ? (
          <>
            <span className={`meter ${level}`} role="meter" aria-label="Contexto usado" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <i style={{ width: `${pct}%` }} />
            </span>
            {formatTokens(stats.contextTokens)} de {formatTokens(stats.contextWindow)} ({pct} %)
          </>
        ) : '—'}
      </span>
      <span>
        Coste {formatUsd(stats.costUsd, stats.costPartial)}{' '}
        <span className="note">(equivalente API; tu plan no lo cobra)</span>
      </span>
      <span>
        {stats.turns} {stats.turns === 1 ? 'turno' : 'turnos'}
        {stats.model && <> · {stats.model}</>}
      </span>
    </p>
  );
}
