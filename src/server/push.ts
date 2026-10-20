import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import type { Store } from './store';

export interface PushMessage { title: string; body: string; url: string }
export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }
export type Sender = (sub: PushSub, payload: string) => Promise<{ statusCode: number }>;
export interface Vapid { publicKey: string; privateKey: string }

/** Lee `<dataDir>/vapid.json` o, si falta, genera las claves y lo crea con permisos 0600. */
export function loadVapid(dataDir: string): Vapid {
  const file = path.join(dataDir, 'vapid.json');
  if (existsSync(file)) {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')) as Vapid;
      if (typeof v.publicKey === 'string' && typeof v.privateKey === 'string' && v.publicKey && v.privateKey) {
        if ((statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600);
        return v;
      }
    } catch { /* se regenera abajo */ }
    console.warn('vapid.json no válido; se generan claves nuevas — los dispositivos tendrán que volver a activar los avisos');
  }
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  writeFileSync(file, JSON.stringify({ publicKey, privateKey }, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  return { publicKey, privateKey };
}

const TITLE_MAX = 80;
const BODY_MAX = 200;
/** Tiempo máximo de cada envío al servicio push (ms): un servidor colgado no retiene el aviso. */
const SEND_TIMEOUT_MS = 15_000;

/** Corta a `max` caracteres (sin partir emojis) acabando en «…». */
function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

export class Push {
  private readonly sender: Sender;

  constructor(private d: { store: Store; vapid: Vapid; contact: string; sender?: Sender }) {
    this.sender = d.sender ?? ((sub, payload) => {
      const details = { subject: d.contact, publicKey: d.vapid.publicKey, privateKey: d.vapid.privateKey };
      return webpush.sendNotification(sub, payload, { vapidDetails: details, TTL: 3600, timeout: SEND_TIMEOUT_MS });
    });
  }

  publicKey(): string {
    return this.d.vapid.publicKey;
  }

  subscribe(deviceId: string | null, sub: PushSub): void {
    this.d.store.upsertPushSubscription(deviceId, sub.endpoint, sub.keys);
  }

  unsubscribe(endpoint: string): void {
    this.d.store.deletePushSubscription(endpoint);
  }

  /** Envía el aviso (título y cuerpo acotados) a todas las suscripciones; 404/410 las borra y otro error queda en `last_error`. */
  async send(msg: PushMessage): Promise<{ sent: number; failed: number }> {
    const payload = JSON.stringify({ title: clip(msg.title, TITLE_MAX), body: clip(msg.body, BODY_MAX), url: msg.url });
    let sent = 0;
    let failed = 0;
    await Promise.all(this.d.store.listPushSubscriptions().map(async (s) => {
      const sub = { endpoint: s.endpoint, keys: s.keys };
      try {
        const r = await this.sender(sub, payload);
        if (r.statusCode === 404 || r.statusCode === 410) { this.d.store.deletePushSubscription(s.endpoint); failed++; }
        else if (r.statusCode >= 400) { this.d.store.setPushError(s.endpoint, `HTTP ${r.statusCode}`); failed++; }
        else {
          sent++;
          if (s.lastError) this.d.store.setPushError(s.endpoint, null);
        }
      } catch (e) {
        failed++;
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) this.d.store.deletePushSubscription(s.endpoint);
        else this.d.store.setPushError(s.endpoint, e instanceof Error ? e.message : String(e));
      }
    }));
    return { sent, failed };
  }
}
