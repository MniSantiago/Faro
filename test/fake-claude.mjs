#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const env = process.env;
const list = (env.FAKE_FIXTURES ?? '').split(',').filter(Boolean);
let n = 0;
if (env.FAKE_COUNTER) {
  if (fs.existsSync(env.FAKE_COUNTER)) n = Number(fs.readFileSync(env.FAKE_COUNTER, 'utf8'));
  fs.writeFileSync(env.FAKE_COUNTER, String(n + 1));
}
if (env.FAKE_ENV_OUT) fs.appendFileSync(env.FAKE_ENV_OUT, JSON.stringify({ GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0 ?? null, GH_TOKEN: process.env.GH_TOKEN ?? null }) + '\n');
if (env.FAKE_ARGS_OUT) fs.appendFileSync(env.FAKE_ARGS_OUT, JSON.stringify(process.argv.slice(2)) + '\n');

let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', async () => {
  if (env.FAKE_FETCH_URL) {
    // Prueba del sandbox: ¿llega el agente al API local?
    let res = 'blocked';
    try {
      await fetch(env.FAKE_FETCH_URL, { signal: AbortSignal.timeout(3000) });
      res = 'ok';
    } catch { /* bloqueado o caído */ }
    fs.writeFileSync(env.FAKE_FETCH_OUT, res);
  }
  if (env.FAKE_WRITE_ABS) {
    try { fs.writeFileSync(env.FAKE_WRITE_ABS, '#!/bin/sh\n'); } catch { /* bloqueado por el sandbox */ }
  }
  if (env.FAKE_STDIN_OUT) fs.appendFileSync(env.FAKE_STDIN_OUT, JSON.stringify(stdin) + '\n');
  if (env.FAKE_WRITE) fs.writeFileSync(env.FAKE_WRITE, 'hola\n');
  if (env.FAKE_WRITE_ARTIFACT) {
    fs.mkdirSync(env.FAKE_WRITE_ARTIFACT.split('/').slice(0, -1).join('/') || '.', { recursive: true });
    fs.writeFileSync(env.FAKE_WRITE_ARTIFACT, env.FAKE_WRITE_ARTIFACT_CONTENT ?? 'x');
  }
  if (env.FAKE_FAIL_FIRST && n === 0) {
    process.stderr.write(env.FAKE_FAIL_FIRST + '\n');
    process.exit(1);
  }
  if (env.FAKE_HANG === '1') {
    setInterval(() => {}, 1000);
    return;
  }
  if (env.FAKE_ORPHAN === '1') {
    const gc = spawn('sleep', ['30'], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (env.FAKE_ORPHAN_PID_OUT) fs.appendFileSync(env.FAKE_ORPHAN_PID_OUT, gc.pid + '\n');
    gc.unref();
  }
  if (env.FAKE_JSON_RESULT) {
    // Como `claude -p --output-format json`: un solo objeto con `structured_output` y `total_cost_usd`.
    const structured = JSON.parse(fs.readFileSync(env.FAKE_JSON_RESULT, 'utf8'));
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: env.FAKE_JSON_SUBTYPE ?? 'success', is_error: !!env.FAKE_JSON_SUBTYPE,
      result: '', structured_output: structured, total_cost_usd: Number(env.FAKE_JSON_COST ?? 0.002),
    }) + '\n');
    process.exit(0);
  }
  const file = list[Math.min(n, list.length - 1)];
  if (file) process.stdout.write(fs.readFileSync(file, 'utf8'));
  process.exit(Number(env.FAKE_EXIT ?? 0));
});
