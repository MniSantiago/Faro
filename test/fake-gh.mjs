#!/usr/bin/env node
// gh falso para los tests: lee y escribe su estado en FAKE_GH_STATE (JSON) y, al fusionar un PR,
// hace el squash de verdad en el repo desnudo FAKE_GH_ORIGIN.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
state.calls = [...(state.calls ?? []), process.argv.slice(2)];
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const [cmd, sub, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const out = (v) => { save(); process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
const fail = (msg) => { save(); process.stderr.write(msg); process.exit(1); };
state.prs ??= [];
state.runs ??= [];

if (cmd === 'pr' && sub === 'list') {
  const head = flag('--head');
  const open = state.prs.filter((p) => p.state === 'OPEN' && (!head || p.headRefName === head));
  out(open.map((p) => ({ number: p.number, url: p.url, title: p.title, headRefName: p.headRefName, isDraft: false })));
}
if (cmd === 'pr' && sub === 'create') {
  if (state.failCreate) fail('no se pudo crear el PR');
  const number = (state.prs.length ? Math.max(...state.prs.map((p) => p.number)) : 0) + 1;
  const pr = { number, url: `https://github.com/o/r/pull/${number}`, title: flag('--title'), body: flag('--body'), headRefName: flag('--head'),
    state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: state.defaultChecks ?? [] };
  state.prs.push(pr);
  out(`Creating pull request\n${pr.url}\n`);
}
const byNumber = (n) => state.prs.find((p) => p.number === Number(n)) ?? fail(`no existe el PR ${n}`);
if (cmd === 'pr' && sub === 'view') {
  const p = byNumber(rest[0]);
  out({ number: p.number, url: p.url, state: p.state, mergeStateStatus: p.mergeStateStatus, headRefName: p.headRefName, statusCheckRollup: p.statusCheckRollup });
}
if (cmd === 'pr' && sub === 'merge') {
  const p = byNumber(rest[0]);
  if (state.failMerge) fail('no se pudo fusionar');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
  const git = (...a) => execFileSync('git', a, { cwd: tmp, encoding: 'utf8' });
  git('clone', '-q', process.env.FAKE_GH_ORIGIN, '.');
  git('merge', '--squash', `origin/${p.headRefName}`);
  git('-c', 'user.email=gh@x', '-c', 'user.name=GitHub', 'commit', '-qm', flag('--subject'));
  git('push', '-q', 'origin', 'HEAD:main');
  p.state = 'MERGED';
  out('');
}
if (cmd === 'pr' && sub === 'close') {
  byNumber(rest[0]).state = 'CLOSED';
  out('');
}
if (cmd === 'run' && sub === 'list') {
  const branch = flag('--branch');
  out(state.runs.filter((r) => !branch || (r.branch ?? 'main') === branch));
}
if (cmd === 'run' && sub === 'view') {
  if (rest.includes('--log-failed')) out(state.failedLog ?? 'App\tnpm test\tFAIL algo.test.ts');
  out({ jobs: state.jobs ?? [{ name: 'App (tsc, lint y tests)', conclusion: 'failure' }] });
}
fail(`fake-gh: orden no soportada: ${process.argv.slice(2).join(' ')}`);
