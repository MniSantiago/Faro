import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './helpers';

const SCRIPT = path.resolve('scripts/install-launchd.sh');

/** Siempre en modo prueba, con HOME temporal y un `launchctl` falso que deja rastro si alguien lo llama. */
function run(env: Record<string, string>) {
  const home = tmpDir();
  const bin = tmpDir();
  const launchctlLog = path.join(home, 'launchctl.log');
  const stub = path.join(bin, 'launchctl');
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${launchctlLog}"\n`);
  chmodSync(stub, 0o755);
  const r = spawnSync('/bin/zsh', [SCRIPT], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FARO_DRY_RUN: '1', FARO_CLAUDE: '/usr/bin/true', ...env },
    encoding: 'utf8',
  });
  return { r, home, launchctlLog };
}

const noSideEffects = (home: string, launchctlLog: string) => {
  expect(existsSync(launchctlLog)).toBe(false);
  expect(existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.faro.server.plist'))).toBe(false);
};

describe('install-launchd.sh', () => {
  it('en modo prueba imprime el plist con ThrottleInterval y el Node indicado, sin tocar nada', () => {
    const { r, home, launchctlLog } = run({ FARO_NODE: process.execPath });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('<key>ThrottleInterval</key><integer>10</integer>');
    expect(r.stdout).toContain(`<string>${process.execPath}</string>`);
    noSideEffects(home, launchctlLog);
  });

  it('rechaza un Node que no es v22', () => {
    const fake = path.join(tmpDir(), 'node');
    writeFileSync(fake, '#!/bin/sh\necho 24\n');
    chmodSync(fake, 0o755);
    const { r, home, launchctlLog } = run({ FARO_NODE: fake });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Faro necesita Node 22');
    noSideEffects(home, launchctlLog);
  });

  it('avisa si el Node indicado no se puede ejecutar', () => {
    const fake = path.join(tmpDir(), 'node');
    writeFileSync(fake, '#!/bin/sh\nexit 3\n');
    chmodSync(fake, 0o755);
    const { r } = run({ FARO_NODE: fake });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No se pudo ejecutar Node');
  });
});
