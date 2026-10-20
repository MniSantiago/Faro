import { createHash, randomBytes, randomInt } from 'node:crypto';
import { sameHash, type Store } from './store';
import type { Device } from './types';

export type { Device } from './types';

/** Fallo de autenticación (la API responde 401). */
export class AuthError extends Error {}

export const COOKIE_NAME = 'faro_sesion';
const COOKIE_MAX_AGE = 31_536_000; // un año, en segundos
const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Cabeceras que añade un proxy (tailscale serve u otro): su sola presencia hace remota la petición. */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'tailscale-user-login'];
/** Mensaje único para cualquier fallo al emparejar: no revela si había código, si caducó o si se agotó. */
const PAIR_FAILED = 'Código no válido o caducado';

type ReqLike = { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } };

/**
 * Local = el navegador del propio Mac: Host 127.0.0.1/localhost en el puerto de Faro, conexión desde loopback
 * y sin cabeceras de proxy (`tailscale serve` añade X-Forwarded-For y Tailscale-User-Login; también X-Forwarded-Host/Proto y Forwarded). Todo lo demás es remoto.
 */
export function isLocalRequest(req: ReqLike, port: number): boolean {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  // Sin socket (llamada directa) solo cuentan las cabeceras; con socket, la conexión debe venir de loopback.
  return !req.socket || LOOPBACK.has(req.socket.remoteAddress ?? '');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Valor de la cookie de sesión de una cabecera Cookie, o null. */
function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}

export class Auth {
  private readonly store: Store;
  private readonly now: () => Date;
  /** Único código vigente. Solo en memoria: ni la base ni un reinicio lo conservan. */
  private pending: { codeHash: string; expiresAt: number; attempts: number } | null = null;
  private readonly revokeListeners = new Set<(deviceId: string) => void>();

  constructor(d: { store: Store; now?: () => Date }) {
    this.store = d.store;
    this.now = d.now ?? (() => new Date());
  }

  /** Código de 6 dígitos, válido 10 minutos y de un solo uso; invalida los anteriores. Solo se guarda su hash, en memoria. */
  createPairingCode(): { code: string; expiresAt: string } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = this.now().getTime() + CODE_TTL_MS;
    this.pending = { codeHash: hashToken(code), expiresAt, attempts: 0 };
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  pair(code: string, name: string): { device: Device; cookie: string } {
    const p = this.pending;
    if (!p) throw new AuthError(PAIR_FAILED);
    if (this.now().getTime() > p.expiresAt) {
      this.pending = null;
      throw new AuthError(PAIR_FAILED);
    }
    if (!sameHash(p.codeHash, hashToken(code))) {
      if (++p.attempts >= MAX_ATTEMPTS) this.pending = null;
      throw new AuthError(PAIR_FAILED);
    }
    this.pending = null;
    const token = newToken();
    const device = this.store.createDevice(name, hashToken(token), this.now().toISOString());
    const cookie = `${COOKIE_NAME}=${device.id}.${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
    return { device, cookie };
  }

  /** El dispositivo de la cookie de sesión si es válida (y anota que se ha visto); si no, null. */
  verifyCookie(header: string | undefined): Device | null {
    const value = readSessionCookie(header);
    if (!value) return null;
    const dot = value.indexOf('.');
    if (dot <= 0 || dot === value.length - 1) return null;
    const device = this.store.findDeviceByTokenHash(value.slice(0, dot), hashToken(value.slice(dot + 1)));
    if (!device) return null;
    const at = this.now().toISOString();
    this.store.touchDevice(device.id, at);
    return { ...device, lastSeenAt: at };
  }

  listDevices(): Device[] {
    return this.store.listDevices();
  }

  revoke(id: string): void {
    this.store.deleteDevice(id);
    for (const fn of this.revokeListeners) fn(id);
  }

  /** Avisa de cada dispositivo revocado (p. ej. para cerrar sus SSE). Devuelve la función para darse de baja. */
  onRevoke(fn: (deviceId: string) => void): () => void {
    this.revokeListeners.add(fn);
    return () => this.revokeListeners.delete(fn);
  }
}
