import type { MetricSource } from './types';

const KEYS = ['mrr', 'active_trials', 'active_subscriptions', 'revenue', 'new_customers'];

export const revenuecatSource: MetricSource = {
  id: 'revenuecat',
  label: 'RevenueCat',
  async collect(ctx) {
    const id = ctx.config.revenuecatProjectId;
    const key = id ? await ctx.secret('revenuecat') : null;
    if (!id || !key) return { configured: false };
    const res = await ctx.fetch(`https://api.revenuecat.com/v2/projects/${encodeURIComponent(id)}/metrics/overview`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (res.status !== 200) throw new Error(`RevenueCat respondió ${res.status}`);
    const body = (await res.json()) as { metrics?: { id?: string; value?: unknown }[] };
    const data: Record<string, number> = {};
    for (const m of body.metrics ?? []) {
      const n = typeof m.value === 'string' && m.value.trim() ? Number(m.value) : m.value;
      if (m.id && KEYS.includes(m.id) && typeof n === 'number' && Number.isFinite(n)) data[m.id] = n;
    }
    return { configured: true, data };
  },
};
