import { createPrivateKey, sign } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { MetricSource } from './types';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** JWT ES256 para App Store Connect (20 min). Nunca se incluye en mensajes de error. */
export function ascToken(keyId: string, issuer: string, p8: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: issuer, iat, exp: iat + 1200, aud: 'appstoreconnect-v1' }));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: createPrivateKey(p8), dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64url(sig)}`;
}

function sumAppUnits(tsv: string, appId: string): number | null {
  const [header, ...rows] = tsv.split(/\r?\n/).filter((l) => l.trim());
  const cols = (header ?? '').split('\t');
  const units = cols.indexOf('Units');
  const type = cols.indexOf('Product Type Identifier');
  const apple = cols.indexOf('Apple Identifier');
  if (units < 0 || type < 0) throw new Error('formato inesperado');
  if (apple < 0) return null;
  let total = 0;
  for (const r of rows) {
    const c = r.split('\t');
    if ((c[apple] ?? '').trim() !== appId) continue;
    if ((c[type] ?? '').startsWith('1')) total += Number(c[units]) || 0;
  }
  return total;
}

export const appstoreSource: MetricSource = {
  id: 'appstore',
  label: 'App Store',
  async collect(ctx) {
    const appId = ctx.config.ascAppId;
    if (!appId) return { configured: false };
    const data: Record<string, number | string | null> = {
      rating: null, rating_count: null, version: null, review_state: null, review_version: null, downloads: null,
    };
    const notes: string[] = [];

    const look = await ctx.fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=es`);
    if (look.status !== 200) throw new Error(`La búsqueda de la App Store respondió ${look.status}`);
    const hit = ((await look.json()) as { results?: { averageUserRating?: number; userRatingCount?: number; version?: string }[] }).results?.[0];
    if (!hit) throw new Error('La App Store no devolvió la app');
    data.rating = hit.averageUserRating ?? null;
    data.rating_count = hit.userRatingCount ?? null;
    data.version = hit.version ?? null;

    const [kid, iss, p8] = await Promise.all([ctx.secret('asc-key-id'), ctx.secret('asc-issuer'), ctx.secret('asc-p8')]);
    if (kid && iss && p8) {
      let headers: Record<string, string> | null = null;
      try {
        headers = { Authorization: `Bearer ${ascToken(kid, iss, p8, ctx.now.getTime())}` };
      } catch {
        notes.push('No se pudo firmar con la clave de App Store Connect');
      }
      if (headers) {
        try {
          const r = await ctx.fetch(
            `https://api.appstoreconnect.apple.com/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?limit=5&fields[appStoreVersions]=versionString,appStoreState,createdDate`,
            { headers },
          );
          if (r.status !== 200) throw new Error(`respondió ${r.status}`);
          const versions = ((await r.json()) as { data?: { attributes?: { versionString?: string; appStoreState?: string; createdDate?: string } }[] }).data ?? [];
          const created = (v: { attributes?: { createdDate?: string } }) => Date.parse(v.attributes?.createdDate ?? '') || 0;
          const a = versions.reduce<(typeof versions)[number] | undefined>((best, v) => (!best || created(v) > created(best) ? v : best), undefined)?.attributes;
          data.review_state = a?.appStoreState ?? null;
          data.review_version = a?.versionString ?? null;
        } catch (e) {
          notes.push(`Estado de la versión: App Store Connect ${e instanceof Error && e.message.startsWith('respondió') ? e.message : 'no disponible'}`);
        }
        const vendor = ctx.config.ascVendorNumber;
        if (vendor) {
          try {
            // Apple publica los informes diarios con retraso y por fecha de Los Ángeles: dos días atrás evita el 404.
            const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
              .format(new Date(ctx.now.getTime() - 2 * 86_400_000));
            const qs = `filter[frequency]=DAILY&filter[reportType]=SALES&filter[reportSubType]=SUMMARY&filter[vendorNumber]=${encodeURIComponent(vendor)}&filter[reportDate]=${day}&filter[version]=1_0`;
            const r = await ctx.fetch(`https://api.appstoreconnect.apple.com/v1/salesReports?${qs}`, { headers: { ...headers, Accept: 'application/a-gzip' } });
            if (r.status !== 200) throw new Error(`respondió ${r.status}`);
            data.downloads = sumAppUnits(gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'), appId);
            if (data.downloads === null) notes.push('Descargas: el informe de ventas no trae la columna Apple Identifier');
          } catch (e) {
            notes.push(`Descargas: ${e instanceof Error && e.message.startsWith('respondió') ? `App Store Connect ${e.message}` : 'informe de ventas no disponible'}`);
          }
        }
      }
    }
    if (notes.length) data.notes = notes.join('; ');
    return { configured: true, data };
  },
};
