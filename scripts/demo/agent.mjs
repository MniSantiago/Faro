#!/usr/bin/env node
// Agente de demostración: imita a `claude -p --output-format stream-json` sin llamar a ningún modelo.
// Lee el prompt de Faro, elige un guion por el título de la tarea, hace cambios de código reales en su carpeta
// y emite los mismos eventos que la CLI, con pausas para que se vea trabajar. Solo para grabar la demo.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('2.0.0 (Claude Code, demo)\n');
  process.exit(0);
}
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const sid = flag('--session-id') ?? flag('--resume') ?? '00000000-0000-4000-8000-000000000000';
const pace = Number(process.env.FARO_DEMO_PACE ?? 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * pace));
const emit = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + '\n');
let tool = 0;

const say = (text) => emit({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
async function use(name, input, result) {
  const id = `t${++tool}`;
  emit({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null });
  await sleep(900);
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: false }] } });
  await sleep(700);
}
function append(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
}

/** Guiones: `match` sobre el título; `run(dir)` recibe la carpeta del agente (la del repo, o la de la tarea si es multi-repo). */
const SCRIPTS = [
  {
    match: /fecha/i, summary: 'Las entradas salen de la más reciente a la más antigua, con su test.',
    async run(d) {
      await use('Read', { file_path: 'src/posts.js' }, 'export function slug(title) …');
      append(path.join(d, 'src/posts.js'), '\n/** Entradas de la más reciente a la más antigua. */\nexport function sortByDate(posts) {\n  return [...posts].sort((a, b) => b.date.localeCompare(a.date));\n}\n');
      await use('Edit', { file_path: 'src/posts.js' }, 'The file src/posts.js has been updated.');
      append(path.join(d, 'test/posts.test.js'), "\ntest('sortByDate pone primero la más reciente', async () => {\n  const { sortByDate } = await import('../src/posts.js');\n  assert.deepEqual(sortByDate([{ date: '2026-01-01' }, { date: '2026-03-01' }]).map((p) => p.date), ['2026-03-01', '2026-01-01']);\n});\n");
      await use('Edit', { file_path: 'test/posts.test.js' }, 'The file test/posts.test.js has been updated.');
    },
  },
  {
    match: /lectura/i, summary: 'Cada entrada calcula sus minutos de lectura (200 palabras por minuto).',
    async run(d) {
      await use('Grep', { pattern: 'export function', path: 'src' }, 'src/posts.js:2');
      append(path.join(d, 'src/posts.js'), '\n/** Minutos de lectura, a 200 palabras por minuto (mínimo 1). */\nexport function readingTime(body) {\n  return Math.max(1, Math.round(body.trim().split(/\\s+/).length / 200));\n}\n');
      await use('Edit', { file_path: 'src/posts.js' }, 'The file src/posts.js has been updated.');
    },
  },
  {
    match: /etiqueta/i, summary: 'He añadido `byTag` para filtrar entradas por etiqueta (sin distinguir mayúsculas), con su test.',
    async run(d) {
      say('Miro cómo se guardan las entradas y si ya hay algo de etiquetas.');
      await sleep(800);
      await use('Grep', { pattern: 'tags', path: 'src' }, 'No matches found');
      await use('Read', { file_path: 'src/posts.js' }, 'export function slug(title) …');
      say('No hay nada: añado `byTag` junto a las demás funciones, con su test.');
      await sleep(800);
      append(path.join(d, 'src/posts.js'), '\n/** Entradas con una etiqueta, sin distinguir mayúsculas. */\nexport function byTag(posts, tag) {\n  const t = tag.toLowerCase();\n  return posts.filter((p) => (p.tags ?? []).some((x) => x.toLowerCase() === t));\n}\n');
      await use('Edit', { file_path: 'src/posts.js' }, 'The file src/posts.js has been updated.');
      append(path.join(d, 'test/posts.test.js'), "\ntest('byTag filtra sin distinguir mayúsculas', async () => {\n  const { byTag } = await import('../src/posts.js');\n  const posts = [{ id: 1, tags: ['Node'] }, { id: 2, tags: ['css'] }, { id: 3 }];\n  assert.deepEqual(byTag(posts, 'node').map((p) => p.id), [1]);\n  assert.deepEqual(byTag(posts, 'rust'), []);\n});\n");
      await use('Edit', { file_path: 'test/posts.test.js' }, 'The file test/posts.test.js has been updated.');
      await use('Bash', { command: 'npm test' }, '# tests 2\n# pass 2\n# fail 0');
    },
  },
  {
    match: /dependencias/i, summary: 'Sin vulnerabilidades. Dos dependencias de desarrollo van una versión menor por detrás; nada urgente.',
    async run() {
      await use('Bash', { command: 'npm audit' }, 'found 0 vulnerabilities');
      await use('Bash', { command: 'npm outdated' }, '(sin cambios mayores)');
    },
  },
  {
    match: /total|carrito/i, summary: 'La API calcula el total del carrito y la app lo muestra bajo la lista.',
    async run(d) {
      say('Toca los dos repos: el total se calcula en la API y la app lo pinta.');
      await sleep(800);
      await use('Read', { file_path: 'api/src/cart.js' }, 'export function lines(cart) …');
      append(path.join(d, 'api/src/cart.js'), '\n/** Total del carrito en céntimos. */\nexport function total(cart) {\n  return cart.items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n');
      await use('Edit', { file_path: 'api/src/cart.js' }, 'The file api/src/cart.js has been updated.');
      append(path.join(d, 'app/src/cart.js'), "\n/** Texto del total bajo la lista (la API lo da en céntimos). */\nexport function totalLabel(cents) {\n  return `Total: ${(cents / 100).toFixed(2)} €`;\n}\n");
      await use('Edit', { file_path: 'app/src/cart.js' }, 'The file app/src/cart.js has been updated.');
    },
  },
];

let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  const title = /Tarea [A-Z]+-\d+: (.*)/.exec(prompt)?.[1] ?? '';
  const script = SCRIPTS.find((s) => s.match.test(title));
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'claude-opus-5-5' });
  await sleep(600);
  say('Leo la tarea y el código relacionado.');
  await sleep(900);
  let summary = 'Hecho.';
  if (script) {
    await script.run(process.cwd());
    summary = script.summary;
  } else {
    append(path.join(process.cwd(), 'NOTAS.md'), `- ${title}\n`);
    await use('Edit', { file_path: 'NOTAS.md' }, 'The file NOTAS.md has been updated.');
  }
  await sleep(600);
  const block = JSON.stringify({ status: 'done', summary, artifacts: [], questions: [] });
  emit({
    type: 'result', subtype: 'success', is_error: false, api_error_status: null,
    result: `${summary}\n\n\`\`\`faro-result\n${block}\n\`\`\``,
    usage: { input_tokens: 1200, cache_read_input_tokens: 42000, output_tokens: 900 },
    total_cost_usd: 0.12 + Math.round(Math.random() * 30) / 100, permission_denials: [],
  });
  process.exit(0);
});
