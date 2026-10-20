import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { addSecretCommand, envSecretName, readSecret, secretExists, takeEnvSecrets } from '../src/server/keychain';
import { tmpDir } from './helpers';

const securityBin = path.resolve('test/fake-security.sh');

describe('llavero', () => {
  it('devuelve el valor de FAKE_SECRET_<cuenta> sin salto de línea', async () => {
    const env = { ...process.env, FAKE_SECRET_revenuecat: 'sk_abc', FAKE_SECRET_asc_key_id: 'KID' };
    expect(await readSecret('revenuecat', { securityBin, env })).toBe('sk_abc');
    expect(await readSecret('asc-key-id', { securityBin, env })).toBe('KID');
  });

  it('devuelve null si no existe (código 44)', async () => {
    const env = { ...process.env };
    delete env.FAKE_SECRET_posthog;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await readSecret('posthog', { securityBin, env })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('devuelve null si el binario no existe, sin volcar el valor', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = { ...process.env, FAKE_SECRET_posthog: 'sk_secreto' };
    expect(await readSecret('posthog', { securityBin: '/no/existe/security', env })).toBeNull();
    expect(JSON.stringify(spy.mock.calls)).not.toContain('sk_secreto');
    spy.mockRestore();
  });

  it('decodifica el hexadecimal que imprime security para valores con saltos de línea', async () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
    const env = { ...process.env, FAKE_SECRET_asc_p8: Buffer.from(pem).toString('hex'), FAKE_SECRET_posthog: 'abcd1234' };
    expect(await readSecret('asc-p8', { securityBin, env })).toBe(pem);
    // Un valor hex sin saltos de línea es un valor normal.
    expect(await readSecret('posthog', { securityBin, env })).toBe('abcd1234');
  });

  it('secretExists: consulta sin -w (no lee el valor) y «no encontrado» no se registra', async () => {
    const log = path.join(tmpDir(), 'security.log');
    const env: NodeJS.ProcessEnv = { ...process.env, FAKE_SECURITY_LOG: log, FAKE_SECRET_revenuecat: 'sk_abc' };
    delete env.FAKE_SECRET_posthog;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await secretExists('revenuecat', { securityBin, env })).toBe(true);
    expect(await secretExists('posthog', { securityBin, env })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(await secretExists('posthog', { securityBin: '/no/existe/security', env })).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'find-generic-password -s faro -a revenuecat', 'find-generic-password -s faro -a posthog',
    ]);
    expect(await secretExists('posthog', { platform: 'linux' })).toBe(false);
  });

  it('da el comando exacto para guardar un secreto', () => {
    expect(addSecretCommand('asc-p8', 'darwin')).toBe('security add-generic-password -U -s faro -a asc-p8 -w');
    expect(addSecretCommand('asc-p8', 'linux')).toBe('FARO_SECRET_ASC_P8=… (variable de entorno al arrancar Faro)');
  });

  it('fuera de macOS, sin variable de entorno, no hay secreto y no se llama a security', async () => {
    expect(await readSecret('github-lectura', { platform: 'linux' })).toBeNull();
  });

  it('FARO_SECRET_* tiene prioridad y desaparece del entorno (no lo heredan los agentes)', async () => {
    const env: NodeJS.ProcessEnv = { [envSecretName('revenuecat')]: 'sk_env', OTRA: '1', FARO_SECRET_VACIO: '' };
    takeEnvSecrets(env);
    expect(env).toEqual({ OTRA: '1' });
    const fake = { ...process.env, FAKE_SECRET_revenuecat: 'sk_llavero' };
    expect(await readSecret('revenuecat', { securityBin, env: fake })).toBe('sk_env');
    expect(await readSecret('revenuecat', { platform: 'linux' })).toBe('sk_env');
  });
});
