import { useEffect, useRef, useState } from 'react';
import { formatValue, type ValueFormat } from '../../shared/format';
import { dayLabel, niceTicks, sparkPath } from '../home';

const H = 240;
const PAD = { top: 12, right: 12, bottom: 26, left: 80 };

/** Ancho del contenedor en píxeles (para dibujar el SVG sin deformar textos). */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * Gráfica de línea de una serie diaria con ejes (días abajo, valores a la izquierda). Al pasar el ratón o tocar, marca el día
 * más cercano con su valor. Los días sin dato cortan la línea.
 */
export function LineChart({ points, format, zero }: { points: { day: string; value: number | null }[]; format: ValueFormat; zero: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const values = points.map((p) => p.value);
  const known = values.filter((v): v is number => v !== null);
  if (!known.length) return <div ref={ref} className="chart chart-empty muted">Sin datos en este periodo</div>;

  const ticks = niceTicks(zero ? Math.min(0, ...known) : Math.min(...known), Math.max(...known));
  const lo = ticks[0];
  const hi = ticks.at(-1)!;
  const iw = Math.max(0, width - PAD.left - PAD.right);
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => PAD.top + ih - ((v - lo) / (hi - lo)) * ih;
  // Unas 5 etiquetas de día repartidas, siempre con la primera y la última.
  const every = Math.max(1, Math.ceil((points.length - 1) / 5));
  const xLabels = points.map((_, i) => i).filter((i) => i === points.length - 1 || (i % every === 0 && points.length - 1 - i >= every / 2));

  const pick = (clientX: number, el: SVGSVGElement) => {
    const rx = clientX - el.getBoundingClientRect().left;
    const i = Math.round(((rx - PAD.left) / (iw || 1)) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };
  const h = hover !== null ? points[hover] : null;

  return (
    <div ref={ref} className="chart">
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label="Gráfica de la serie diaria"
          onPointerMove={(e) => pick(e.clientX, e.currentTarget)} onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
          onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(null); }}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="axis" x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">{formatValue(t, format)}</text>
            </g>
          ))}
          {xLabels.map((i) => (
            <text key={i} className="axis" x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>{dayLabel(points[i].day)}</text>
          ))}
          <g transform={`translate(${PAD.left} ${PAD.top})`}>
            <path className="line" d={sparkPath(values, iw, ih, [lo, hi])} />
          </g>
          {h && (
            <g className="hover">
              <line x1={x(hover!)} x2={x(hover!)} y1={PAD.top} y2={PAD.top + ih} />
              {h.value !== null && <circle cx={x(hover!)} cy={y(h.value)} r={4} />}
            </g>
          )}
        </svg>
      )}
      <p className="chart-readout" aria-live="polite">
        {h ? <><strong>{formatValue(h.value, format)}</strong> <span className="muted">{dayLabel(h.day)}</span></>
          : <span className="muted">Pasa el ratón o toca la gráfica para ver cada día</span>}
      </p>
    </div>
  );
}
