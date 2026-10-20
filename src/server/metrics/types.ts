import type { SecretName } from '../keychain';

export type SourceId = 'revenuecat' | 'posthog' | 'appstore';
export interface MetricsConfig {
  revenuecatProjectId?: string; posthogHost?: string; posthogProjectId?: string; ascAppId?: string; ascVendorNumber?: string;
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
