import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { appstoreSource } from '../src/server/metrics/appstore';
import { FUNNEL_EVENTS, posthogSource } from '../src/server/metrics/posthog';
import { revenuecatSource } from '../src/server/metrics/revenuecat';
import type { MetricsConfig, SourceContext } from '../src/server/metrics/types';

const fixture = (n: string) => readFileSync(new URL(`./fixtures/metrics/${n}`, import.meta.url), 'utf8');
type Call = { url: string; init?: RequestInit };
const NOW = new Date('2026-10-15T10:00:00Z');

function ctx(config: MetricsConfig, secrets: Record<string, string>, respond: (c: Call) => Response): { c: SourceContext; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => { const call = { url: String(url), init }; calls.push(call); return respond(call); }) as unknown as typeof fetch;
  return { c: { config, secret: async (n) => secrets[n] ?? null, fetch: f, now: NOW }, calls };
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
  const cfg = { posthogProjectId: '77', posthogHost: 'https://eu.posthog.com' };
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
    // El permiso solo cuenta si se concedió (Demo manda resultado: 'concedido' | 'denegado').
    expect(q.query).toContain("(event != 'permiso_tiempo_uso' OR properties.resultado = 'concedido')");
    for (const e of FUNNEL_EVENTS) expect(q.query).toContain(`'${e}'`);
    expect(r.data).toMatchObject({ onboarding_iniciado: 100, apps_elegidas: 60, paywall_visto: 40, compra_completada: 4, permiso_tiempo_uso: 0, compra_iniciada: 0, conversion_paywall_compra: 0.1 });
  });
  it('ignora eventos heredados de Object.prototype', async () => {
    const { c } = ctx(cfg, { posthog: 'k' }, () => json('{"results":[["toString",5],["paywall_visto",10],["compra_completada",1]]}'));
    const r = await posthogSource.collect(c);
    expect(Object.hasOwn(r.data!, 'toString')).toBe(false);
    expect(r.data?.conversion_paywall_compra).toBe(0.1);
  });
  it('conversión null si nadie vio el paywall; sin config no está configurada', async () => {
    const { c } = ctx(cfg, { posthog: 'k' }, () => json('{"results":[]}'));
    expect((await posthogSource.collect(c)).data?.conversion_paywall_compra).toBeNull();
    expect(await posthogSource.collect(ctx({ posthogHost: cfg.posthogHost }, { posthog: 'k' }, () => json('{}')).c)).toEqual({ configured: false });
    expect(await posthogSource.collect(ctx(cfg, {}, () => json('{}')).c)).toEqual({ configured: false });
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
  const report = gzipSync('Provider\tApple Identifier\tProduct Type Identifier\tUnits\nAPPLE\t1234567890\t1F\t5\nAPPLE\t1234567890\t1\t3\nAPPLE\t1234567890\tIA1\t9\nAPPLE\t999\t1F\t50\n');

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
    expect(r.data?.downloads).toBe(8);
    const url = calls.find((x) => x.url.includes('/salesReports'))!.url;
    expect(url).toContain('filter[vendorNumber]=88001234');
    expect(url).toContain('filter[reportDate]=2026-10-13');
    expect(url).toContain('filter[reportType]=SALES&filter[reportSubType]=SUMMARY');
    expect(url).toContain('filter[version]=1_0');
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
