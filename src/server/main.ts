import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ReviewActions } from './actions';
import { buildApp } from './api';
import { Bus } from './bus';
import { runChecks } from './checks';
import { loadConfig } from './config';
import { rotateLogs } from './logs';
import { AsoCollector } from './aso/collector';
import { storedOrCurrentFicha, type CurrentFicha } from './aso/ficha';
import { MetricsCollector } from './metrics/collector';
import { appstoreSource } from './metrics/appstore';
import { posthogSource } from './metrics/posthog';
import { revenuecatSource } from './metrics/revenuecat';
import { Notifier } from './notifier';
import { loadVapid, Push } from './push';
import { Releases } from './releases';
import { Orchestrator } from './orchestrator';
import { Scheduler } from './scheduler';
import { Runner } from './runner/runner';
import { defaultWindow } from './stats';
import { Store } from './store';
import type { AsoStoreConfig } from './aso/types';
import type { ProjectConfig } from './types';
import { GitWorkspaces } from './workspaces';
import { pruneClosedWorktrees, sweepFinishedParents } from './housekeeping';
import { Plan } from './plan';
import { GitHub } from './github';
import { readSecret } from './keychain';
import { GitHubWatcher } from './github-watch';

const config = await loadConfig();
rotateLogs(path.join(config.dataDir, 'logs'));
mkdirSync(path.join(config.dataDir, 'artifacts'), { recursive: true });

const store = new Store(path.join(config.dataDir, 'faro.db'));
const bus = new Bus();
const workspaces = new GitWorkspaces();
const runner = new Runner({ store, bus, claudeBin: config.claudeBin, defaultWindow: (taskId) => defaultWindow(config, taskId) });
const releases = new Releases({ store, config, bus, workspaces });
releases.recover();
// GitHub con `gh` (sesión del usuario) solo si algún proyecto lo usa.
const github = config.projects.some((p) => p.github) ? new GitHub(config.ghBin ?? 'gh') : undefined;
const orchestrator = new Orchestrator({
  store, config, bus, runner, workspaces, runChecks, releases, github,
  ghReadToken: () => readSecret('github-lectura'),
});
const actions = new ReviewActions({ store, config, bus, workspaces, orchestrator, runner, releases, github });

// Ficha vigente: la que guardó el colector; si no hay, una consulta rápida (con tiempo máximo) solo a esa tienda.
const asoFicha = (project: ProjectConfig, s: AsoStoreConfig) => storedOrCurrentFicha(store.aso, fetch, project, s);
const asoFichas = async (project: ProjectConfig) => {
  const out: Record<string, CurrentFicha> = {};
  for (const s of project.aso?.stores ?? []) out[s.id] = await asoFicha(project, s);
  return out;
};

const plan = new Plan({ store, config, github });
const scheduler = new Scheduler({
  store, config, actions, plan,
  asoFichas,
});
scheduler.sync();
scheduler.start();

const push = new Push({ store, vapid: loadVapid(config.dataDir), contact: config.pushContact ?? 'mailto:faro@localhost' });

orchestrator.recover();
orchestrator.tick();

// Limpieza: padres cuyas hijas ya terminaron y worktrees de tareas cerradas (al arrancar y cada 6 h).
const housekeeping = async () => {
  try {
    await sweepFinishedParents({ store, config, workspaces, bus });
    const removed = await pruneClosedWorktrees({ store, config, workspaces });
    if (removed.length) console.log(`[faro] worktrees de tareas cerradas borrados: ${removed.length}`);
  } catch (e) {
    console.error('[faro] limpieza falló', e);
  }
};
void housekeeping();
const housekeepingTimer = setInterval(() => void housekeeping(), 6 * 3600_000);
housekeepingTimer.unref();
const stopNotifier = new Notifier({ store, bus, push, config, queueState: () => orchestrator.queueState() }).start();

// Vigilancia de GitHub: PR que esperan al CI (cada minuto) y CI de la rama base (cada 3 min).
const githubTimers: ReturnType<typeof setInterval>[] = [];
if (github) {
  const watcher = new GitHubWatcher({
    store, config, bus, workspaces, releases, github,
    enqueue: (id, p) => orchestrator.enqueue(id, p),
    notify: (title, body, url) => { push.send({ title, body, url }).catch((e) => console.error('[faro] aviso push falló', e)); },
  });
  let busy = false;
  const guard = (fn: () => Promise<void>) => async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } finally { busy = false; }
  };
  githubTimers.push(setInterval(guard(() => watcher.checkPrs()), 60_000), setInterval(guard(() => watcher.checkCi()), 180_000));
  for (const t of githubTimers) t.unref();
  void guard(() => watcher.checkCi())();
}

const metrics = new MetricsCollector({ store, config, sources: [revenuecatSource, posthogSource, appstoreSource] });
metrics.start();

const asoCollector = new AsoCollector({ store, config, push });
if (config.projects.some((p) => p.aso)) asoCollector.start();

const app = buildApp({ store, config, actions, orchestrator, bus, scheduler, releases, push, metrics, aso: { collector: asoCollector, ficha: asoFicha }, workspaces, plan, webDir: path.resolve('dist/web') });
await app.listen({ host: config.host, port: config.port });
console.log(`Faro escuchando en http://${config.host}:${config.port}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  let code = 0;
  try {
    stopNotifier();
    clearInterval(housekeepingTimer);
    for (const t of githubTimers) clearInterval(t);
    scheduler.stop();
    metrics.stop();
    asoCollector.stop();
    await Promise.all([orchestrator.shutdown(10_000), releases.shutdown(10_000)]);
    await app.close();
    store.close();
  } catch (e) {
    code = 1;
    console.error('[faro] error al cerrar', e);
  } finally {
    process.exit(code);
  }
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
