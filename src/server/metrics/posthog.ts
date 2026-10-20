import type { MetricSource } from './types';

export const FUNNEL_EVENTS = [
  'onboarding_iniciado', 'permiso_tiempo_uso', 'apps_elegidas', 'onboarding_completado',
  'paywall_visto', 'compra_iniciada', 'compra_completada',
];

export const FUNNEL_QUERY =
  'SELECT event, count(DISTINCT person_id) FROM events WHERE timestamp > now() - INTERVAL 7 DAY ' +
  `AND properties.entorno = 'produccion' AND event IN (${FUNNEL_EVENTS.map((e) => `'${e}'`).join(', ')}) ` +
  // La app manda permiso_tiempo_uso con resultado 'concedido' | 'denegado': la etapa cuenta solo a quien lo concedió.
  "AND (event != 'permiso_tiempo_uso' OR properties.resultado = 'concedido') GROUP BY event";

export const posthogSource: MetricSource = {
  id: 'posthog',
  label: 'PostHog',
  async collect(ctx) {
    const { posthogProjectId: id, posthogHost: host } = ctx.config;
    const key = id && host ? await ctx.secret('posthog') : null;
    if (!id || !host || !key) return { configured: false };
    const res = await ctx.fetch(`${host.replace(/\/+$/, '')}/api/projects/${encodeURIComponent(id)}/query/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: FUNNEL_QUERY } }),
    });
    if (res.status !== 200) throw new Error(`PostHog respondió ${res.status}`);
    const body = (await res.json()) as { results?: [string, number][] };
    const data: Record<string, number | null> = Object.fromEntries(FUNNEL_EVENTS.map((e) => [e, 0]));
    for (const [event, n] of body.results ?? []) if (Object.hasOwn(data, event)) data[event] = Number(n) || 0;
    const seen = data.paywall_visto as number;
    data.conversion_paywall_compra = seen > 0 ? (data.compra_completada as number) / seen : null;
    return { configured: true, data };
  },
};
