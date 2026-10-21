// Faro de demostración para grabar el GIF del README: dos proyectos de ejemplo («Blog», un repo, y «Tienda», dos
// repos), un agente simulado (scripts/demo/agent.mjs, sin gastar cuota de Claude) y unas tareas ya hechas.
// Uso: npx tsx scripts/demo/start.ts [carpeta]  (por defecto, una carpeta temporal nueva). Ctrl-C lo para.
// Todo vive en esa carpeta: no toca ~/.faro ni tus repos.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.FARO_DEMO_PORT ?? 3299);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dir = path.resolve(process.argv[2] ?? mkdtempSync(path.join(os.tmpdir(), 'faro-demo-')));
const agent = path.join(here, 'agent.mjs');
chmodSync(agent, 0o755);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', ...args], { cwd, stdio: 'pipe' });

/** Un repo con su `origin` desnudo y un primer commit con estos archivos. */
function repo(rel: string, files: Record<string, string>): string {
  const p = path.join(dir, 'code', rel);
  const origin = path.join(dir, 'origin', `${rel.replace(/\//g, '-')}.git`);
  mkdirSync(p, { recursive: true });
  mkdirSync(origin, { recursive: true });
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(p, 'init', '-q', '-b', 'main');
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(p, f)), { recursive: true });
    writeFileSync(path.join(p, f), text);
  }
  git(p, 'add', '-A');
  git(p, 'commit', '-q', '-m', 'Primer commit');
  git(p, 'remote', 'add', 'origin', origin);
  git(p, 'push', '-q', '-u', 'origin', 'main');
  return p;
}

const pkg = (name: string) => JSON.stringify({ name, private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n';
const testHead = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n";

const blog = repo('blog', {
  'package.json': pkg('blog'),
  'README.md': '# Blog\n\nUn blog estático de ejemplo.\n',
  'src/posts.js': "/** Slug de una entrada a partir del título. */\nexport function slug(title) {\n  return title.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n}\n",
  'test/posts.test.js': `${testHead}import { slug } from '../src/posts.js';\n\ntest('slug quita tildes y espacios', () => {\n  assert.equal(slug('Hola, señor Ñandú'), 'hola-senor-nandu');\n});\n`,
});
const shopFiles = (what: string) => ({
  'package.json': pkg(`tienda-${what}`),
  'src/cart.js': '/** Líneas del carrito. */\nexport function lines(cart) {\n  return cart.items.map((i) => `${i.qty} × ${i.name}`);\n}\n',
  'test/cart.test.js': `${testHead}import { lines } from '../src/cart.js';\n\ntest('lines', () => {\n  assert.deepEqual(lines({ items: [{ name: 'Café', qty: 2 }] }), ['2 × Café']);\n});\n`,
});
const app = repo('tienda/app', shopFiles('app'));
const api = repo('tienda/api', shopFiles('api'));
writeFileSync(path.join(dir, 'code', 'tienda', 'CLAUDE.md'), '# Tienda\n\nLa app está en app/ y la API en api/.\n');

const data = path.join(dir, 'data');
const tests = [{ name: 'Tests', command: 'node --test' }];
const config = {
  title: 'Faro', host: '127.0.0.1', port: PORT, dataDir: data, claudeBin: agent,
  projects: [
    {
      id: 'blog', name: 'Blog', prefix: 'BLG', repoPath: blog, baseBranch: 'main', remote: 'origin',
      worktreesDir: path.join(data, 'worktrees', 'blog'), maxConcurrentRuns: 2, checks: tests,
      routines: [
        { id: 'revision-bugs', name: 'Revisión de bugs', cron: '0 9 * * 1', profileId: 'calidad', level: 1, title: 'Revisión de bugs ({fecha})', prompt: 'Revisa los cambios de la semana.' },
        { id: 'dependencias', name: 'Dependencias y seguridad', cron: '0 10 * * 1', profileId: 'calidad', level: 1, title: 'Dependencias ({fecha})', prompt: 'npm audit y npm outdated.' },
      ],
    },
    {
      id: 'tienda', name: 'Tienda', prefix: 'TIE', rootPath: path.join(dir, 'code', 'tienda'),
      worktreesDir: path.join(data, 'worktrees', 'tienda'), maxConcurrentRuns: 2,
      instructions: 'La app está en app/ y la API en api/.',
      repos: [
        { id: 'app', name: 'App', path: app, baseBranch: 'main', remote: 'origin', checks: tests },
        { id: 'api', name: 'API', path: api, baseBranch: 'main', remote: 'origin', checks: tests },
      ],
    },
  ],
  profiles: [
    { id: 'coordinador', name: 'Coordinador', instructions: 'Divides objetivos en tareas.', defaultLevel: 1, timeoutMinutes: 20 },
    { id: 'dev', name: 'Desarrollo', instructions: 'Trabajas en el código del proyecto.', defaultLevel: 2, timeoutMinutes: 45 },
    { id: 'calidad', name: 'Calidad', instructions: 'Buscas bugs y code smells.', defaultLevel: 1, timeoutMinutes: 45 },
    { id: 'analisis', name: 'Análisis', instructions: 'Escribes informes breves.', defaultLevel: 1, timeoutMinutes: 20 },
  ],
};
const configFile = path.join(dir, 'faro.config.ts');
writeFileSync(configFile, `export default ${JSON.stringify(config, null, 2)};\n`);

const server = spawn(path.join(root, 'node_modules', '.bin', 'tsx'), [path.join(root, 'src', 'server', 'main.ts')], {
  cwd: root, env: { ...process.env, FARO_CONFIG: configFile }, stdio: ['ignore', 'inherit', 'inherit'],
});
const stop = () => { server.kill('SIGTERM'); };
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
server.on('exit', (code) => { console.error(`[demo] el servidor terminó (${code})`); process.exit(1); });

const base = `http://127.0.0.1:${PORT}`;
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(base + url, {
    method, headers: body === undefined ? { 'x-faro': '1' } : { 'x-faro': '1', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; ; i++) {
  try { await call('GET', '/api/config'); break; } catch { if (i > 60) throw new Error('el servidor no arranca'); await wait(500); }
}

// Historia previa: tareas ya integradas y un informe, para que Inicio, Historial y el gasto no salgan vacíos.
const seed = [
  { projectId: 'blog', profileId: 'dev', level: 3, title: 'Ordenar las entradas por fecha' },
  { projectId: 'blog', profileId: 'dev', level: 3, title: 'Calcular el tiempo de lectura' },
  { projectId: 'blog', profileId: 'analisis', level: 1, title: 'Revisar dependencias' },
];
for (const t of seed) {
  const { id } = await call<{ id: string }>('POST', '/api/tasks', { ...t, description: '' });
  for (;;) {
    const { task } = await call<{ task: { state: string } }>('GET', `/api/tasks/${id}`);
    if (['done', 'review', 'blocked', 'discarded'].includes(task.state)) break;
    await wait(500);
  }
}
await call('POST', '/api/projects/blog/push').catch((e) => console.error('[demo] push:', (e as Error).message));
console.log(`\n[demo] listo: ${base}  (carpeta ${dir})\n`);
