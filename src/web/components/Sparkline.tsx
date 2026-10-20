import { sparkPath } from '../home';

const W = 100;
const H = 22;

/** Mini-gráfica de una cifra (sin ejes). `tone` elige el color del trazo. */
export function Sparkline({ values, tone }: { values: (number | null)[]; tone: 'ok' | 'bad' | 'muted' }) {
  const d = sparkPath(values, W, H - 4);
  if (!d) return <span className="tile-spark" aria-hidden="true" />;
  return (
    <svg className={`tile-spark ${tone}`} viewBox={`0 -2 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
