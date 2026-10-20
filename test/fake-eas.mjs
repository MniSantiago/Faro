#!/usr/bin/env node
// Simula `eas build|submit` para los tests. FAKE_EAS_MODE: ok | fail | hang. FAKE_EAS_LS_OUT: guarda el contenido del cwd.
import fs from 'node:fs';
const [kind, ...rest] = process.argv.slice(2);
const mode = process.env.FAKE_EAS_MODE ?? 'ok';
if (process.env.FAKE_EAS_LS_OUT) fs.writeFileSync(process.env.FAKE_EAS_LS_OUT, JSON.stringify(fs.readdirSync('..')));
if (process.env.FAKE_EAS_ARGS_OUT) fs.appendFileSync(process.env.FAKE_EAS_ARGS_OUT, JSON.stringify([kind, ...rest]) + '\n');
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'evil' && kind === 'build') console.log(JSON.stringify([{ id: 'x; rm -rf ~', artifacts: {} }]));
else if (mode === 'fail') { console.error('Build failed: credenciales'); process.exit(1); }
else {
  console.error('Subiendo el proyecto…');
  if (kind === 'build') console.log(JSON.stringify([{ id: 'build-123', artifacts: { buildUrl: 'https://expo.dev/artifacts/build-123' } }]));
  else console.log('Enviado a App Store Connect');
}
