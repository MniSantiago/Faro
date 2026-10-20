import { execFile } from 'node:child_process';

export type SecretName = 'revenuecat' | 'posthog' | 'asc-key-id' | 'asc-issuer' | 'asc-p8' | 'github-lectura';

/** Lee un secreto del llavero (servicio `faro`). `null` si no existe o no se puede leer; nunca lanza ni registra el valor. */
export function readSecret(
  name: SecretName,
  opts: { securityBin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
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

/** Comando que debe ejecutar el usuario para guardar un secreto (pide el valor por teclado). */
export function addSecretCommand(name: SecretName): string {
  return `security add-generic-password -U -s faro -a ${name} -w`;
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
