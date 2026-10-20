import { readSecret, type SecretName } from '../keychain';
import type { Store } from '../store';
import type { FaroConfig } from '../types';
import type { MetricSource, Snapshot, SourceContext, SourceId } from './types';

const SIX_HOURS = 6 * 60 * 60 * 1000;

export function redact(message: string, secrets: string[]): string {
  let out = message;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) if (s) out = out.split(s).join('***');
  return out;
}

export interface CollectorDeps {
  store: Store;
  config: FaroConfig;
  sources: MetricSource[];
  secret?: SourceContext['secret'];
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export class MetricsCollector {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly configured = new Map<string, boolean>();

  constructor(private readonly d: CollectorDeps) {}

  /** Una pasada: por proyecto con `metrics` y por fuente. Si ya hay una en curso, espera a esa. */
  collectAll(): Promise<void> {
    this.running ??= this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<void> {
    const projects = this.d.config.projects.filter((p) => p.metrics);
    await Promise.all(projects.flatMap((p) => this.d.sources.map((s) => this.collectOne(p.id, p.metrics!, s))));
  }

  private async collectOne(projectId: string, config: NonNullable<FaroConfig['projects'][number]['metrics']>, source: MetricSource): Promise<void> {
    const seen: string[] = [];
    const secret = async (n: SecretName) => {
      const v = await (this.d.secret ?? readSecret)(n);
      if (v) seen.push(v);
      return v;
    };
    const at = (this.d.now ?? (() => new Date()))();
    const ctrl = new AbortController();
    const baseFetch = this.d.fetch ?? fetch;
    const f = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => baseFetch(input, { ...init, signal: ctrl.signal })) as typeof fetch;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { ctrl.abort(); reject(new Error('Tiempo agotado')); }, this.d.timeoutMs ?? 30_000);
    });
    try {
      const knownDownloadDays = this.d.store.downloadDays(projectId, new Date(at.getTime() - 91 * 86_400_000).toISOString().slice(0, 10));
      const res = await Promise.race([source.collect({ config, secret, fetch: f, now: at, knownDownloadDays }), timeout]);
      this.configured.set(`${projectId}:${source.id}`, res.configured);
      if (res.configured) {
        // Las descargas por día y país van a su tabla; la foto solo guarda valores escalares.
        const { downloads_by_day: byDay, ...scalars } = res.data ?? {};
        if (Array.isArray(byDay)) for (const d of byDay) this.d.store.upsertDailyDownloads(projectId, d.day, d.rows);
        this.d.store.addSnapshot(projectId, source.id, true, scalars as Snapshot['data'], null, at);
      }
    } catch (e) {
      this.configured.set(`${projectId}:${source.id}`, true);
      const msg = redact(e instanceof Error ? e.message : String(e), seen);
      this.d.store.addSnapshot(projectId, source.id, false, {}, msg, at);
    } finally {
      clearTimeout(timer);
    }
  }

  start(intervalMs = SIX_HOURS): void {
    if (this.timer) return;
    const now = (this.d.now ?? (() => new Date()))();
    const stale = this.d.config.projects.some((p) => {
      if (!p.metrics) return false;
      return this.d.sources.some((s) => {
        const last = this.d.store.latestSnapshot(p.id, s.id, false);
        return !last || now.getTime() - Date.parse(last.takenAt) > SIX_HOURS;
      });
    });
    if (stale) void this.collectAll().catch((e) => console.error('[faro] error recogiendo métricas', e));
    this.timer = setInterval(() => {
      void this.collectAll().catch((e) => console.error('[faro] error recogiendo métricas', e));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(projectId: string): { source: SourceId; label: string; configured: boolean | null; last: Snapshot | null; lastOk: Snapshot | null }[] {
    return this.d.sources.map((s) => ({
      source: s.id,
      label: s.label,
      configured: this.configured.get(`${projectId}:${s.id}`) ?? null,
      last: this.d.store.latestSnapshot(projectId, s.id, false),
      lastOk: this.d.store.latestSnapshot(projectId, s.id, true),
    }));
  }
}
