import type { FunnelConfig } from './types';
import type { MetricSource } from './types';

/** Clave de la conversión entre dos etapas del embudo en los datos de la foto. */
export const CONVERSION_KEY = 'conversion';

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Consulta HogQL del embudo: personas distintas por evento en los últimos 7 días. */
export function funnelQuery(f: FunnelConfig): string {
  const events = f.steps.map((s) => quote(s.event)).join(', ');
  const conds = f.steps.filter((s) => s.where).map((s) => `AND (event != ${quote(s.event)} OR (${s.where}))`);
  return [
    'SELECT event, count(DISTINCT person_id) FROM events WHERE timestamp > now() - INTERVAL 7 DAY',
    ...(f.filter ? [`AND (${f.filter})`] : []),
    `AND event IN (${events})`,
    ...conds,
    'GROUP BY event',
  ].join(' ');
}

export const posthogSource: MetricSource = {
  id: 'posthog',
  label: 'PostHog',
  async collect(ctx) {
    const { posthogProjectId: id, posthogHost: host, posthogFunnel: funnel } = ctx.config;
    const key = id && host && funnel ? await ctx.secret('posthog') : null;
    if (!id || !host || !funnel || !key) return { configured: false };
    const res = await ctx.fetch(`${host.replace(/\/+$/, '')}/api/projects/${encodeURIComponent(id)}/query/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: funnelQuery(funnel) } }),
    });
    if (res.status !== 200) throw new Error(`PostHog respondió ${res.status}`);
    const body = (await res.json()) as { results?: [string, number][] };
    const data: Record<string, number | null> = Object.fromEntries(funnel.steps.map((s) => [s.event, 0]));
    for (const [event, n] of body.results ?? []) if (Object.hasOwn(data, event)) data[event] = Number(n) || 0;
    if (funnel.conversion) {
      const from = data[funnel.conversion.from] as number;
      data[CONVERSION_KEY] = from > 0 ? (data[funnel.conversion.to] as number) / from : null;
    }
    return { configured: true, data };
  },
};
