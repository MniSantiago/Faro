import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { appstoreSource, unitsByCountry } from '../src/server/metrics/appstore';
import { funnelQuery, posthogSource } from '../src/server/metrics/posthog';
import { revenuecatSource } from '../src/server/metrics/revenuecat';
import type { MetricsConfig, SourceContext } from '../src/server/metrics/types';

const fixture = (n: string) => readFileSync(new URL(`./fixtures/metrics/${n}`, import.meta.url), 'utf8');
type Call = { url: string; init?: RequestInit };
const NOW = new Date('2026-10-15T10:00:00Z');

function ctx(config: MetricsConfig, secrets: Record<string, string>, respond: (c: Call) => Response, known: Set<string> = new Set()): { c: SourceContext; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => { const call = { url: String(url), init }; calls.push(call); return respond(call); }) as unknown as typeof fetch;
  return { c: { config, secret: async (n) => secrets[n] ?? null, fetch: f, now: NOW, knownDownloadDays: known }, calls };
}
const json = (s: string, status = 200) => new Response(s, { status, headers: { 'content-type': 'application/json' } });

describe('RevenueCat', () => {
  it('mapea la respuesta con la URL y la cabecera esperadas', async () => {
    const { c, calls } = ctx({ revenuecatProjectId: 'proj1' }, { revenuecat: 'sk_secret' }, () => json(fixture('revenuecat-overview.json')));
    const r = await revenuecatSource.collect(c);
    expect(r).toEqual({ configured: true, data: { mrr: 123.4, active_trials: 7, active_subscriptions: 42, revenue: 310.5, new_customers: 18 } });
    expect(calls[0].url).toBe('https://api.revenuecat.com/v2/projects/proj1/metrics/overview');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer sk_secret');
  });
  it('acepta números como texto y descarta lo no finito', async () => {
    const body = JSON.stringify({ metrics: [{ id: 'mrr', value: '12.5' }, { id: 'active_trials', value: 'abc' }, { id: 'revenue', value: '' }, { id: 'new_customers', value: 3 }] });
    const { c } = ctx({ revenuecatProjectId: 'p' }, { revenuecat: 'k' }, () => json(body));
    expect((await revenuecatSource.collect(c)).data).toEqual({ mrr: 12.5, new_customers: 3 });
  });
  it('sin secreto o sin id no está configurada y no llama', async () => {
    const a = ctx({ revenuecatProjectId: 'p' }, {}, () => json('{}'));
    expect(await revenuecatSource.collect(a.c)).toEqual({ configured: false });
    const b = ctx({}, { revenuecat: 'x' }, () => json('{}'));
    expect(await revenuecatSource.collect(b.c)).toEqual({ configured: false });
    expect(a.calls.length + b.calls.length).toBe(0);
  });
  it('401 da error sin el secreto', async () => {
    const { c } = ctx({ revenuecatProjectId: 'p' }, { revenuecat: 'sk_secret' }, () => json('{}', 401));
    const err = await revenuecatSource.collect(c).catch((e: Error) => e);
    expect((err as Error).message).toBe('RevenueCat respondió 401');
    expect((err as Error).message).not.toContain('sk_secret');
  });
});

describe('PostHog', () => {
  const posthogFunnel = {
    filter: "properties.entorno = 'produccion'",
    steps: [
      { event: 'onboarding_iniciado', label: 'Onboarding iniciado' },
      { event: 'permiso_tiempo_uso', label: 'Permiso concedido', where: "properties.resultado = 'concedido'" },
      { event: 'apps_elegidas', label: 'Apps elegidas' },
      { event: 'onboarding_completado', label: 'Onboarding completado' },
      { event: 'paywall_visto', label: 'Paywall visto' },
      { event: 'compra_iniciada', label: 'Compra iniciada' },
      { event: 'compra_completada', label: 'Compra completada' },
    ],
    conversion: { from: 'paywall_visto', to: 'compra_completada', label: 'Conversión paywall → compra' },
  };
  const cfg = { posthogProjectId: '77', posthogHost: 'https://eu.posthog.com', posthogFunnel };
  it('manda la consulta del embudo, rellena ceros y calcula la conversión', async () => {
    const { c, calls } = ctx(cfg, { posthog: 'phx_secret' }, () => json(fixture('posthog-query.json')));
    const r = await posthogSource.collect(c);
    expect(calls[0].url).toBe('https://eu.posthog.com/api/projects/77/query/');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer phx_secret');
    const q = JSON.parse(String(calls[0].init?.body)).query;
    expect(q.kind).toBe('HogQLQuery');
    expect(q.query).toContain("properties.entorno = 'produccion'");
    expect(q.query).toContain('INTERVAL 7 DAY');
    // La condición de una etapa solo se aplica a su evento.
    expect(q.query).toContain("(event != 'permiso_tiempo_uso' OR (properties.resultado = 'concedido'))");
    for (const st of posthogFunnel.steps) expect(q.query).toContain(`'${st.event}'`);
    expect(r.data).toMatchObject({ onboarding_iniciado: 100, apps_elegidas: 60, paywall_visto: 40, compra_completada: 4, permiso_tiempo_uso: 0, compra_iniciada: 0, conversion: 0.1 });
  });
  it('ignora eventos heredados de Object.prototype', async () => {
    const { c } = ctx(cfg, { posthog: 'k' }, () => json('{"results":[["toString",5],["paywall_visto",10],["compra_completada",1]]}'));
    const r = await posthogSource.collect(c);
    expect(Object.hasOwn(r.data!, 'toString')).toBe(false);
    expect(r.data?.conversion).toBe(0.1);
  });
  it('conversión null si nadie vio el paywall; sin config no está configurada', async () => {
    const { c } = ctx(cfg, { posthog: 'k' }, () => json('{"results":[]}'));
    expect((await posthogSource.collect(c)).data?.conversion).toBeNull();
    expect(await posthogSource.collect(ctx({ ...cfg, posthogFunnel: undefined }, { posthog: 'k' }, () => json('{}')).c)).toEqual({ configured: false });
    expect(await posthogSource.collect(ctx({ posthogHost: cfg.posthogHost }, { posthog: 'k' }, () => json('{}')).c)).toEqual({ configured: false });
    expect(await posthogSource.collect(ctx(cfg, {}, () => json('{}')).c)).toEqual({ configured: false });
  });
  it('sin conversion no calcula la clave; los textos van entre comillas escapadas', async () => {
    const f = { steps: [{ event: 'a', label: 'A' }, { event: "b'c", label: 'B' }] };
    expect(funnelQuery(f)).toBe("SELECT event, count(DISTINCT person_id) FROM events WHERE timestamp > now() - INTERVAL 7 DAY AND event IN ('a', 'b\\'c') GROUP BY event");
    const { c } = ctx({ ...cfg, posthogFunnel: { steps: [{ event: 'a', label: 'A' }] } }, { posthog: 'k' }, () => json('{"results":[["a",3]]}'));
    expect((await posthogSource.collect(c)).data).toEqual({ a: 3 });
  });
  it('HTTP ≠ 200 da error sin secreto', async () => {
    const { c } = ctx(cfg, { posthog: 'phx_secret' }, () => json('{}', 403));
    await expect(posthogSource.collect(c)).rejects.toThrow('PostHog respondió 403');
  });
});

describe('App Store', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const p8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const secrets = { 'asc-key-id': 'KID123', 'asc-issuer': 'issuer-uuid', 'asc-p8': p8 };
  const report = gzipSync('Provider\tApple Identifier\tProduct Type Identifier\tUnits\tCountry Code\nAPPLE\t1234567890\t1F\t5\tES\nAPPLE\t1234567890\t1\t3\tUS\nAPPLE\t1234567890\tIA1\t9\tES\nAPPLE\t999\t1F\t50\tES\nAPPLE\t1234567890\t1F\t2\tES\n');

  const routes = (extra: Partial<Record<'versions' | 'sales', () => Response>> = {}) => (c: Call): Response => {
    if (c.url.startsWith('https://itunes.apple.com/lookup')) return json(fixture('itunes-lookup.json'));
    if (c.url.includes('/appStoreVersions')) return extra.versions?.() ?? json(fixture('asc-versions.json'));
    if (c.url.includes('/salesReports')) return extra.sales?.() ?? new Response(report, { status: 200 });
    return json('{}', 404);
  };

  it('solo con ascAppId: valoración y versión públicas, sin llamar a App Store Connect', async () => {
    const { c, calls } = ctx({ ascAppId: '1234567890' }, {}, routes());
    const r = await appstoreSource.collect(c);
    expect(calls.map((x) => x.url)).toEqual(['https://itunes.apple.com/lookup?id=1234567890&country=es']);
    expect(r.data).toMatchObject({ rating: 4.6, rating_count: 23, version: '1.0.2', review_state: null, downloads: null });
    expect(await appstoreSource.collect(ctx({}, {}, routes()).c)).toEqual({ configured: false });
  });

  it('firma un JWT ES256 verificable y lee el estado de la versión', async () => {
    const { c, calls } = ctx({ ascAppId: '1234567890' }, secrets, routes());
    const r = await appstoreSource.collect(c);
    expect(r.data).toMatchObject({ review_state: 'WAITING_FOR_REVIEW', review_version: '1.0.2' });
    const call = calls.find((x) => x.url.includes('/appStoreVersions'))!;
    expect(call.url).toBe('https://api.appstoreconnect.apple.com/v1/apps/1234567890/appStoreVersions?limit=5&fields[appStoreVersions]=versionString,appStoreState,createdDate');
    const jwt = (call.init?.headers as Record<string, string>).Authorization.replace('Bearer ', '');
    const [h, b, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KID123', typ: 'JWT' });
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
    expect(payload).toMatchObject({ iss: 'issuer-uuid', aud: 'appstoreconnect-v1' });
    expect(payload.iat).toBe(Math.floor(NOW.getTime() / 1000));
    expect(payload.exp).toBe(payload.iat + 1200);
    expect(verify('sha256', Buffer.from(`${h}.${b}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('descargas = suma de unidades de filas de app (tipo que empieza por 1) de hace dos días (hora de Los Ángeles)', async () => {
    const { c, calls } = ctx({ ascAppId: '1234567890', ascVendorNumber: '88001234' }, secrets, routes());
    const r = await appstoreSource.collect(c);
    expect(r.data?.downloads).toBe(10);
    const url = calls.find((x) => x.url.includes('/salesReports'))!.url;
    expect(url).toContain('filter[vendorNumber]=88001234');
    expect(url).toContain('filter[reportDate]=2026-10-13');
    expect(url).toContain('filter[reportType]=SALES&filter[reportSubType]=SUMMARY');
    expect(url).toContain('filter[version]=1_0');
  });

  it('unitsByCountry agrupa por país solo filas de app con tipo 1*', () => {
    const tsv = 'Apple Identifier\tProduct Type Identifier\tUnits\tCountry Code\n7\t1F\t5\tES\n7\t1\t3\tUS\n7\tIA1\t9\tES\n8\t1F\t50\tES\n7\t1F\t2\tES\n';
    expect(unitsByCountry(tsv, '7')).toEqual([{ country: 'ES', units: 7 }, { country: 'US', units: 3 }]);
    expect(unitsByCountry('Product Type Identifier\tUnits\n1F\t5\n', '7')).toBeNull();
    expect(() => unitsByCountry('x\ty\n', '7')).toThrow('formato');
  });

  it('pide el día más reciente y como mucho 5 días que falten, del más reciente al más antiguo', async () => {
    const known = new Set(['2026-10-12', '2026-10-10']);
    const { c, calls } = ctx({ ascAppId: '1234567890', ascVendorNumber: '1' }, secrets, routes(), known);
    const r = await appstoreSource.collect(c);
    const days = calls.filter((x) => x.url.includes('/salesReports')).map((x) => /reportDate\]=([\d-]+)/.exec(x.url)![1]);
    expect(days).toEqual(['2026-10-13', '2026-10-11', '2026-10-09', '2026-10-08', '2026-10-07', '2026-10-06']);
    expect((r.data?.downloads_by_day as unknown[]).length).toBe(6);
    expect((r.data?.downloads_by_day as { rows: unknown }[])[0].rows).toEqual([{ country: 'ES', units: 7 }, { country: 'US', units: 3 }]);
  });

  it('un 404 de un día viejo no anula los demás; downloads es el del día más reciente', async () => {
    const sales = (c: Call) => (c.url.includes('reportDate]=2026-10-12') ? json('{}', 404) : new Response(report, { status: 200 }));
    const { c } = ctx({ ascAppId: '1234567890', ascVendorNumber: '1' }, secrets, (call) => (call.url.includes('/salesReports') ? sales(call) : routes()(call)));
    const r = await appstoreSource.collect(c);
    expect(r.data?.downloads).toBe(10);
    expect((r.data?.downloads_by_day as { day: string }[]).map((d) => d.day)).not.toContain('2026-10-12');
    expect((r.data?.downloads_by_day as unknown[]).length).toBe(5);
    expect(String(r.data?.notes)).toContain('404');
  });

  it('sin columna Apple Identifier no se cuentan descargas y queda nota', async () => {
    const plain = gzipSync('Provider\tProduct Type Identifier\tUnits\nAPPLE\t1F\t5\n');
    const { c } = ctx({ ascAppId: '1234567890', ascVendorNumber: '1' }, secrets, routes({ sales: () => new Response(plain, { status: 200 }) }));
    const r = await appstoreSource.collect(c);
    expect(r.data?.downloads).toBeNull();
    expect(String(r.data?.notes)).toContain('Apple Identifier');
  });

  it('un fallo parcial deja el campo a null con nota, sin JWT en ella', async () => {
    const { c } = ctx({ ascAppId: '1', ascVendorNumber: '9' }, secrets, routes({ versions: () => json('{}', 401), sales: () => json('{}', 403) }));
    const r = await appstoreSource.collect(c);
    expect(r.configured).toBe(true);
    expect(r.data).toMatchObject({ rating: 4.6, review_state: null, downloads: null });
    expect(String(r.data?.notes)).toContain('401');
    expect(String(r.data?.notes)).toContain('403');
    expect(String(r.data?.notes)).not.toContain('eyJ');
  });

  it('una clave .p8 inválida no tumba la fuente', async () => {
    const { c } = ctx({ ascAppId: '1' }, { ...secrets, 'asc-p8': 'basura' }, routes());
    const r = await appstoreSource.collect(c);
    expect(r.data).toMatchObject({ rating: 4.6, review_state: null });
    expect(String(r.data?.notes)).not.toContain('basura');
  });

  it('si falla el lookup, la fuente da error', async () => {
    const { c } = ctx({ ascAppId: '1' }, {}, () => json('{}', 500));
    await expect(appstoreSource.collect(c)).rejects.toThrow('500');
  });
});
