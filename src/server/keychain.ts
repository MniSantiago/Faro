import { execFile } from 'node:child_process';

export type SecretName = 'revenuecat' | 'posthog' | 'asc-key-id' | 'asc-issuer' | 'asc-p8' | 'github-lectura';

const ENV_PREFIX = 'FARO_SECRET_';
const fromEnv = new Map<string, string>();

type SecretOpts = { securityBin?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform };

const envKey = (account: string): string => ENV_PREFIX + account.toUpperCase().replace(/[-:]/g, '_');

/** Variable de entorno con la que se puede dar un secreto: `asc-p8` → `FARO_SECRET_ASC_P8`; por proyecto, `revenuecat` + `acme` → `FARO_SECRET_REVENUECAT_ACME`. */
export function envSecretName(name: SecretName, projectId?: string): string {
  return envKey(projectId ? `${name}:${projectId}` : name);
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

/** Olvida los secretos tomados del entorno (para los tests). */
export function clearEnvSecrets(): void {
  fromEnv.clear();
}

/**
 * Lee un secreto: primero de `FARO_SECRET_<CUENTA>` (ver `takeEnvSecrets`) y, en macOS, del llavero (servicio `faro`).
 * `null` si no existe o no se puede leer; nunca lanza ni registra el valor.
 */
export function readSecret(name: SecretName, opts: SecretOpts = {}): Promise<string | null> {
  return readAccount(name, name, opts);
}

/** La clave de un proyecto (cuenta `<nombre>:<proyecto>`, o `FARO_SECRET_<NOMBRE>_<PROYECTO>`) y, si no hay, la general. */
export async function readProjectSecret(name: SecretName, projectId: string, opts: SecretOpts = {}): Promise<string | null> {
  return (await readAccount(name, `${name}:${projectId}`, opts)) ?? readSecret(name, opts);
}

function readAccount(name: SecretName, account: string, opts: SecretOpts): Promise<string | null> {
  const given = fromEnv.get(envKey(account));
  if (given) return Promise.resolve(given);
  if ((opts.platform ?? process.platform) !== 'darwin' && !opts.securityBin) return Promise.resolve(null);
  const bin = opts.securityBin ?? '/usr/bin/security';
  return new Promise((resolve) => {
    execFile(
      bin, ['find-generic-password', '-s', 'faro', '-a', account, '-w'],
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
export function secretExists(name: SecretName, opts: SecretOpts = {}): Promise<boolean> {
  return accountExists(name, name, opts);
}

/** Como `secretExists` para un proyecto: su cuenta propia o, si no, la general. */
export async function projectSecretExists(name: SecretName, projectId: string, opts: SecretOpts = {}): Promise<boolean> {
  return (await accountExists(name, `${name}:${projectId}`, opts)) || secretExists(name, opts);
}

function accountExists(name: SecretName, account: string, opts: SecretOpts): Promise<boolean> {
  if (fromEnv.get(envKey(account))) return Promise.resolve(true);
  if ((opts.platform ?? process.platform) !== 'darwin' && !opts.securityBin) return Promise.resolve(false);
  const bin = opts.securityBin ?? '/usr/bin/security';
  return new Promise((resolve) => {
    execFile(
      bin, ['find-generic-password', '-s', 'faro', '-a', account],
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

/**
 * Cómo guardar un secreto: en macOS, el comando del llavero (pide el valor por teclado); en otro sistema, la variable
 * de entorno. Con `projectId`, la cuenta propia del proyecto (`<nombre>:<proyecto>`), que se lee antes que la general.
 */
export function addSecretCommand(name: SecretName, platform: NodeJS.Platform = process.platform, projectId?: string): string {
  return platform === 'darwin'
    ? `security add-generic-password -U -s faro -a ${projectId ? `${name}:${projectId}` : name} -w`
    : `${envSecretName(name, projectId)}=… (variable de entorno al arrancar Faro)`;
}

/** RevenueCat va por proyecto: con más de uno, su ayuda sugiere la cuenta del proyecto. Las demás claves se comparten. */
export const PER_PROJECT_SECRETS: readonly SecretName[] = ['revenuecat'];

/** El comando de ayuda de un secreto para un proyecto, según cuántos proyectos hay. */
export function projectSecretCommand(name: SecretName, projectId: string, projectCount: number, platform: NodeJS.Platform = process.platform): string {
  return addSecretCommand(name, platform, projectCount > 1 && PER_PROJECT_SECRETS.includes(name) ? projectId : undefined);
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
