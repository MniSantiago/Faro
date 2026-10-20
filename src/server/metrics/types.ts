import type { SecretName } from '../keychain';

export type SourceId = 'revenuecat' | 'posthog' | 'appstore';
/** Una etapa del embudo: un evento de PostHog y, opcionalmente, una condición HogQL extra solo para ese evento. */
export interface FunnelStep { event: string; label: string; where?: string }
export interface FunnelConfig {
  /** Título de la sección en la página Métricas (por defecto, «Embudo»). */
  title?: string;
  steps: FunnelStep[];
  /** Condición HogQL para todos los eventos, p. ej. `properties.entorno = 'produccion'`. */
  filter?: string;
  /** Tarjeta de conversión entre dos etapas (eventos de `steps`). */
  conversion?: { from: string; to: string; label: string };
}
export interface MetricsConfig {
  revenuecatProjectId?: string; posthogHost?: string; posthogProjectId?: string; ascAppId?: string; ascVendorNumber?: string;
  posthogFunnel?: FunnelConfig;
}
export interface SourceContext {
  config: MetricsConfig;
  secret: (n: SecretName) => Promise<string | null>;
  fetch: typeof fetch;
  now: Date;
}
export interface SourceResult { configured: boolean; data?: Record<string, number | string | null> }
export interface MetricSource { id: SourceId; label: string; collect(ctx: SourceContext): Promise<SourceResult> }
export interface Snapshot {
  id: number; projectId: string; source: SourceId; takenAt: string; ok: boolean;
  data: Record<string, number | string | null>; error: string | null;
}
