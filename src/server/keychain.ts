import { execFile } from 'node:child_process';

export type SecretName = 'revenuecat' | 'posthog' | 'asc-key-id' | 'asc-issuer' | 'asc-p8' | 'github-lectura';

const ENV_PREFIX = 'FARO_SECRET_';
const fromEnv = new Map<string, string>();

/** Variable de entorno con la que se puede dar un secreto: `asc-p8` → `FARO_SECRET_ASC_P8`. */
export function envSecretName(name: SecretName): string {
  return ENV_PREFIX + name.toUpperCase().replace(/-/g, '_');
}

/**
 * Saca los secretos `FARO_SECRET_*` del entorno del proceso y los guarda en memoria.
 * Se llama al arrancar, antes de lanzar nada: así ni los agentes ni las comprobaciones los heredan.
 */
export function takeEnvSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of Object.keys(env)) {
    if (!k.startsWith(ENV_PREFIX)) continue;
    const v = env[k];
    if (v) fromEnv.set(k, v);
    delete env[k];
  }
}

/**
 * Lee un secreto: primero de `FARO_SECRET_<CUENTA>` (ver `takeEnvSecrets`) y, en macOS, del llavero (servicio `faro`).
 * `null` si no existe o no se puede leer; nunca lanza ni registra el valor.
 */
export function readSecret(
  name: SecretName,
  opts: { securityBin?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<string | null> {
  const given = fromEnv.get(envSecretName(name));
  if (given) return Promise.resolve(given);
  if ((opts.platform ?? process.platform) !== 'darwin' && !opts.securityBin) return Promise.resolve(null);
  const bin = opts.securityBin ?? '/usr/bin/security';
  return new Promise((resolve) => {
    execFile(
      bin, ['find-generic-password', '-s', 'faro', '-a', name, '-w'],
      { env: opts.env ?? process.env, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000, killSignal: 'SIGKILL' },
      (err, stdout) => {
        if (err) {
          const code = (err as unknown as { code?: number | string }).code;
          if (code !== 44) console.error(`[faro] no se pudo leer el secreto «${name}» del llavero (código ${String(code)})`);
          return resolve(null);
        }
        const value = String(stdout).replace(/\r?\n$/, '');
        resolve(value === '' ? null : decodeHex(value));
      },
    );
  });
}

/**
 * ¿Existe el secreto? Como `readSecret` pero sin `-w`: no se descifra ni se lee el valor (el panel solo muestra
 * conectado / falta). «No encontrado» (código 44) no se registra; otros fallos sí. Nunca lanza.
 */
export function secretExists(
  name: SecretName,
  opts: { securityBin?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  if (fromEnv.get(envSecretName(name))) return Promise.resolve(true);
  if ((opts.platform ?? process.platform) !== 'darwin' && !opts.securityBin) return Promise.resolve(false);
  const bin = opts.securityBin ?? '/usr/bin/security';
  return new Promise((resolve) => {
    execFile(
      bin, ['find-generic-password', '-s', 'faro', '-a', name],
      { env: opts.env ?? process.env, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000, killSignal: 'SIGKILL' },
      (err) => {
        if (err) {
          const code = (err as unknown as { code?: number | string }).code;
          if (code !== 44) console.error(`[faro] no se pudo consultar el secreto «${name}» del llavero (código ${String(code)})`);
          return resolve(false);
        }
        resolve(true);
      },
    );
  });
}

/** Cómo guardar un secreto: en macOS, el comando del llavero (pide el valor por teclado); en otro sistema, la variable de entorno. */
export function addSecretCommand(name: SecretName, platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? `security add-generic-password -U -s faro -a ${name} -w`
    : `${envSecretName(name)}=… (variable de entorno al arrancar Faro)`;
}

/** `security -w` imprime en hexadecimal los valores con saltos de línea (p. ej. la clave .p8). */
function decodeHex(value: string): string {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) return value;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'hex'));
    return text.includes('\n') ? text : value;
  } catch {
    return value;
  }
}
