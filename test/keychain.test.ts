import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { addSecretCommand, readSecret } from '../src/server/keychain';

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

  it('da el comando exacto para guardar un secreto', () => {
    expect(addSecretCommand('asc-p8')).toBe('security add-generic-password -U -s faro -a asc-p8 -w');
  });
});
