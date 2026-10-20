import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { ActionError, BadRequestError, type ReviewActions } from './actions';
import { addSecretCommand } from './keychain';
import { buildCards } from './metrics/summary';
import { homeSeries, homeView } from './home';
import type { AsoCollector } from './aso/collector';
import { inFicha, fichaWords, normalizeKeyword, type CurrentFicha } from './aso/ficha';
import { MIN_PRIOR_DAYS, rankWindow } from './aso/alerts';
import { AsoProposalError } from './aso/repo';
import type { AsoStoreConfig } from './aso/types';
import { opportunity } from './aso/scores';
import type { MetricsCollector } from './metrics/collector';
import type { FunnelConfig } from './metrics/types';
import type { Push } from './push';
import { Auth, AuthError, isLocalRequest } from './auth';
import type { Bus } from './bus';
import { ConfigError, getProject } from './config';
import type { Orchestrator } from './orchestrator';
import { isInside } from './paths';
import { defaultWindow } from './stats';
import { NotFoundError, type Store } from './store';
import { InvalidTransitionError } from './taskState';
import type { Releases } from './releases';
import type { Scheduler } from './scheduler';
import type { Device, FaroConfig, ProjectConfig, Level, TaskState } from './types';
import type { Workspaces } from './workspaces';
import type { Plan } from './plan';

declare module 'fastify' {
  interface FastifyRequest {
    /** Petición del navegador del propio Mac (ver isLocalRequest). */
    faroLocal: boolean;
    /** Dispositivo de la cookie de sesión, si la hay y es válida. */
    faroDevice: Device | null;
  }
}

export interface ApiDeps {
  store: Store;
  /** Página «Plan»: pendientes, lo hecho sin enviar a la tienda y lo que falta probar. */
  plan?: Plan;
  /** Para contar los commits sin subir; sin él, la bandeja solo ve los push pendientes. */
  workspaces?: Pick<Workspaces, 'ahead'>;
  config: FaroConfig;
  actions: ReviewActions;
  orchestrator: Pick<Orchestrator, 'queueState' | 'resume'>;
  bus: Bus;
  scheduler: Pick<Scheduler, 'list' | 'runNow' | 'toggle'>;
  releases: Pick<Releases, 'request' | 'retry' | 'stop'>;
  /** Sesiones remotas; por defecto, una sobre el mismo store. */
  auth?: Auth;
  /** Avisos push; sin él, las rutas `/api/push/*` no existen. */
  push?: Push;
  /** Colector de métricas; sin él, las rutas `/api/metrics*` no existen. */
  metrics?: Pick<MetricsCollector, 'status' | 'collectAll'>;
  /**
   * ASO; sin él, las rutas `/api/aso*` no existen. `ficha` solo se usa si el colector aún no guardó la ficha
   * vigente de la tienda: debe ser una consulta rápida y con tiempo máximo (ver storedOrCurrentFicha).
   */
  aso?: {
    collector: Pick<AsoCollector, 'collectAll'>;
    ficha: (project: ProjectConfig, store: AsoStoreConfig) => Promise<CurrentFicha | null>;
  };
  webDir?: string | null;
}

const AsoKeywordBody = z.object({ project: z.string().min(1), store: z.string().min(1), text: z.string() });
const AsoCompetitorBody = z.object({
  project: z.string().min(1),
  appId: z.string().trim().regex(/^\d+$/, 'El appId debe ser numérico'),
  name: z.string().trim().min(1).max(200),
});
const AsoDecisionBody = z.object({ decision: z.enum(['accepted', 'rejected']) });
const AsoStoreBody = z.object({ project: z.string().min(1), store: z.string().min(1) });
const DAY = 86_400_000;

const HomeQuery = z.object({ project: z.string().min(1, 'Falta el proyecto') });
const SeriesQuery = HomeQuery.extend({
  metric: z.enum(['descargas', 'conversion', 'mrr', 'gasto']),
  days: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30), z.literal(90)])),
});

const PushSubBody = z.object({
  endpoint: z.string().max(1000).url().refine((u) => u.startsWith('https://'), 'El endpoint debe ser https'),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) }),
});
const PushUnsubBody = z.object({ endpoint: z.string().min(1) });

const QueueBody = z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional() });

const CreateBody = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().default(''),
  profileId: z.string().min(1),
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  draft: z.boolean().default(false),
  release: z.enum(['none', 'build', 'build_submit']).default('none'),
});
const CommentBody = z.object({ comment: z.string().trim().min(1) });
const ChatBody = z.object({ projectId: z.string().min(1), text: z.string().trim().min(1) });
const MessageBody = z.object({ text: z.string().trim().min(1), interrupt: z.boolean().default(false) });
const AnswerBody = z.object({
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  text: z.string().optional(),
});

/** Paginación del historial: `limit` entero ≥ 1 (se recorta a 200), `offset` entero ≥ 0. */
const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).transform((n) => Math.min(n, 200)),
  offset: z.coerce.number().int().min(0),
});

const PairBody = z.object({ code: z.string().max(32), name: z.string().trim().min(1).max(80) });

/**
 * Rutas que un dispositivo remoto puede pedir sin sesión (además de la web estática). `pairing` está para que
 * responda 403 «solo desde el Mac» en vez de 401: la propia ruta rechaza cualquier petición remota.
 */
const PUBLIC_ROUTES = new Set(['GET /api/auth/state', 'POST /api/devices/pair', 'POST /api/devices/pairing']);

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};

/** Sin sesión, un remoto solo llega a la web estática (GET fuera de /api) y a PUBLIC_ROUTES; se decide por la ruta resuelta. */
function isPublic(method: string, route: string | undefined): boolean {
  if (route && PUBLIC_ROUTES.has(`${method} ${route}`)) return true;
  return (method === 'GET' || method === 'HEAD') && !(route ?? '').startsWith('/api');
}

/** `bytes=a-b`, `a-` o `-n` sobre un archivo de `size` bytes; null si no es un rango satisfacible. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]); // últimos n bytes
    if (n === 0) return null;
    start = Math.max(size - n, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start >= size || start > end ? null : { start, end };
}

export function buildApp(d: ApiDeps): FastifyInstance {
  const { store, config, actions, orchestrator, bus, scheduler } = d;
  const auth = d.auth ?? new Auth({ store });
  const app = Fastify({ logger: false, forceCloseConnections: true });
  app.decorateRequest('faroLocal', false);
  app.decorateRequest('faroDevice', null);

  app.setErrorHandler((err: unknown, req, reply) => {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof NotFoundError) return reply.code(404).send({ error: message });
    if (err instanceof AuthError) return reply.code(401).send({ error: message });
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof ConfigError) return reply.code(400).send({ error: message });
    if (err instanceof BadRequestError) return reply.code(400).send({ error: message });
    if (err instanceof ActionError || err instanceof InvalidTransitionError) return reply.code(409).send({ error: message });
    const sc = (err as { statusCode?: unknown }).statusCode;
    if (typeof sc === 'number' && sc >= 400 && sc <= 499) return reply.code(sc).send({ error: message });
    // Un remoto no ve detalles internos (rutas, SQL...); el detalle queda en el log.
    if (!req.faroLocal) {
      console.error('Error interno', err);
      return reply.code(500).send({ error: 'Error interno' });
    }
    return reply.code(500).send({ error: message });
  });

  // Defensa del API local: Host conocido (contra DNS rebinding) y, en los POST, Origin propio y una
  // cabecera que un formulario o un fetch no-cors de otra web no pueden enviar (contra CSRF).
  const ports = (): Set<number> => {
    const set = new Set([config.port]);
    const addr = app.server.address();
    if (addr && typeof addr === 'object') set.add(addr.port);
    return set;
  };
  const allowedHosts = (): Set<string> => {
    const hosts = new Set(config.allowedHosts ?? []);
    for (const port of ports()) for (const h of ['127.0.0.1', 'localhost', config.host]) hosts.add(`${h}:${port}`);
    return hosts;
  };
  app.addHook('onRequest', async (req, reply) => {
    const hosts = allowedHosts();
    const host = req.headers.host ?? '';
    if (!hosts.has(host)) return reply.code(403).send({ error: `Host no permitido: ${host || '(vacío)'}` });

    // Acceso remoto (Tailscale): sin cookie de sesión válida solo la web estática, el estado de sesión y emparejar.
    req.faroLocal = [...ports()].some((p) => isLocalRequest(req.raw, p));
    if (!req.faroLocal) {
      req.faroDevice = auth.verifyCookie(req.headers.cookie);
      if (!req.faroDevice && !isPublic(req.method, req.routeOptions.url)) {
        return reply.code(401).send({ error: 'Inicia sesión en este dispositivo' });
      }
    }

    if (req.method !== 'POST') return;
    const origin = req.headers.origin;
    if (origin !== undefined && ![...hosts].some((h) => origin === `http://${h}` || origin === `https://${h}`)) {
      return reply.code(403).send({ error: `Origen no permitido: ${origin}` });
    }
    const json = /^application\/json\b/i.test(req.headers['content-type'] ?? '');
    if (!json && req.headers['x-faro'] !== '1') {
      return reply.code(403).send({ error: 'Petición rechazada: falta la cabecera x-faro o el cuerpo JSON' });
    }
  });

  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get('/api/auth/state', async (req) => ({ local: req.faroLocal, device: req.faroDevice }));
  app.post('/api/devices/pairing', async (req, reply) => {
    if (!req.faroLocal) return reply.code(403).send({ error: 'El código de vinculación solo se genera desde el Mac' });
    return auth.createPairingCode();
  });
  app.post('/api/devices/pair', async (req, reply) => {
    const b = PairBody.parse(req.body);
    const { device, cookie } = auth.pair(b.code, b.name);
    reply.header('set-cookie', cookie);
    return { device };
  });
  app.get('/api/devices', async () => auth.listDevices());
  app.post('/api/devices/:id/revoke', async (req) => {
    auth.revoke(id(req));
    return { ok: true };
  });

  if (d.push) {
    const push = d.push;
    app.get('/api/push/key', async () => ({ publicKey: push.publicKey() }));
    app.post('/api/push/subscribe', async (req) => {
      const b = PushSubBody.parse(req.body);
      push.subscribe(req.faroDevice?.id ?? null, b);
      return { ok: true };
    });
    app.post('/api/push/unsubscribe', async (req) => {
      push.unsubscribe(PushUnsubBody.parse(req.body).endpoint);
      return { ok: true };
    });
    app.post('/api/push/test', async () => {
      return push.send({ title: 'Faro funciona', body: 'Los avisos están activados en este dispositivo.', url: '/#/bandeja' });
    });
  }

  app.get('/api/routines', async () => scheduler.list());
  app.post('/api/routines/:id/run', async (req) => scheduler.runNow(id(req)));
  app.post('/api/routines/:id/toggle', async (req) => scheduler.toggle(id(req)));

  app.get('/api/config', async () => ({
    projects: config.projects.map((p) => ({ id: p.id, name: p.name, prefix: p.prefix, release: Boolean(p.release), metrics: Boolean(p.metrics), aso: Boolean(d.aso && p.aso) })),
    profiles: config.profiles.map((p) => ({ id: p.id, name: p.name, defaultLevel: p.defaultLevel })),
    coordinatorProfile: config.coordinatorProfile ?? 'coordinador',
    title: config.title ?? 'Faro',
  }));

  // Home: titular, cifras, salud y semana de un proyecto; y la serie de una cifra para su detalle.
  const homeProject = (projectId: string): string => {
    if (!config.projects.some((p) => p.id === projectId)) throw new NotFoundError('Proyecto desconocido');
    return projectId;
  };
  app.get('/api/home', async (req) => {
    const q = HomeQuery.parse(req.query);
    return homeView({ store, config, plan: d.plan }, homeProject(q.project), new Date());
  });
  app.get('/api/home/series', async (req) => {
    const q = SeriesQuery.parse(req.query);
    return homeSeries({ store, config }, homeProject(q.project), q.metric, q.days, new Date());
  });

  app.get('/api/tasks', async (req) => {
    const { state, parent, limit, offset } = req.query as { state?: string; parent?: string; limit?: string; offset?: string };
    if (parent) return store.listChildren(parent);
    const states = state ? (state.split(',') as TaskState[]) : undefined;
    // Sin `limit`, la lista completa como siempre; con `limit`, página de las más recientes primero.
    if (limit === undefined) return store.listTasks(states);
    const page = PageQuery.parse({ limit, offset: offset ?? '0' });
    return store.listTasks(states, { ...page, newestFirst: true });
  });

  // Coste y contexto de las tareas vivas (las del tablero) y gasto equivalente de hoy y de la semana.
  app.get('/api/stats', async () => {
    const live = store.listTasks(['draft', 'queued', 'working', 'blocked', 'review', 'pr', 'idle']);
    return { tasks: store.taskStats(live.map((t) => t.id), (tid) => defaultWindow(config, tid)), spend: store.spend(new Date()) };
  });

  app.post('/api/tasks', async (req) => {
    const b = CreateBody.parse(req.body);
    if (b.release !== 'none' && !getProject(config, b.projectId).release) throw new BadRequestError('Este proyecto no tiene lanzamientos configurados');
    return actions.createTask({ ...b, level: b.level as Level | undefined });
  });

  app.get('/api/tasks/:id', async (req) => {
    const task = store.getTask(id(req));
    return {
      task, runs: store.listRuns(task.id), artifacts: store.listArtifacts(task.id),
      approvals: store.listApprovals(task.id), comments: store.listComments(task.id), jobs: store.listJobs(task.id),
      stats: store.taskStats([task.id], (tid) => defaultWindow(config, tid))[task.id],
    };
  });

  app.get('/api/tasks/:id/events', async (req) => {
    const { after } = req.query as { after?: string };
    store.getTask(id(req));
    return store.listEvents(id(req), Number(after ?? 0) || 0);
  });

  app.post('/api/chats', async (req) => actions.createChat(ChatBody.parse(req.body)));
  app.post('/api/tasks/:id/approve', async (req) => actions.approve(id(req)));
  app.post('/api/tasks/:id/request-changes', async (req) => actions.requestChanges(id(req), CommentBody.parse(req.body).comment));
  app.post('/api/tasks/:id/message', async (req) => {
    const b = MessageBody.parse(req.body);
    return actions.message(id(req), b.text, { interrupt: b.interrupt });
  });
  app.post('/api/tasks/:id/answer', async (req) => actions.answer(id(req), AnswerBody.parse(req.body)));
  app.post('/api/tasks/:id/discard', async (req) => actions.discard(id(req)));
  app.post('/api/tasks/:id/stop', async (req) => actions.stop(id(req)));
  app.post('/api/tasks/:id/queue', async (req) => actions.approveDraft(id(req), QueueBody.parse(req.body ?? {}).level as Level | undefined));
  // Página «Plan».
  const needPlan = (): Plan => {
    if (!d.plan) throw new BadRequestError('La página Plan no está disponible');
    return d.plan;
  };
  const planCall = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) {
      if (e instanceof ConfigError || e instanceof BadRequestError) throw e;
      throw new BadRequestError((e as Error).message);
    }
  };
  app.get('/api/plan/:id', async (req) => needPlan().state(id(req)));
  app.post('/api/plan/:id/refresh', async (req) => needPlan().refreshBuild(id(req)));
  app.post('/api/plan/:id/backlog', async (req) => {
    const b = z.object({ text: z.string() }).parse(req.body);
    return planCall(() => needPlan().addBacklog(id(req), b.text));
  });
  app.post('/api/plan/:id/backlog/:item', async (req) => {
    const b = z.object({ isDone: z.boolean() }).parse(req.body);
    const item = Number((req.params as { item: string }).item);
    return planCall(() => needPlan().setBacklogDone(id(req), item, b.isDone));
  });
  app.post('/api/plan/:id/tested/:task', async (req) => {
    const b = z.object({ tested: z.boolean() }).parse(req.body);
    needPlan().setTested(id(req), (req.params as { task: string }).task, b.tested);
    return { ok: true };
  });

  // Cambios sin subir por proyecto: commits por delante del remoto y tareas con el push pendiente.
  app.get('/api/push-state', async () => {
    const projects = await Promise.all(config.projects.map(async (p) => ({
      id: p.id, name: p.name, remote: p.remote, baseBranch: p.baseBranch,
      ahead: d.workspaces ? await d.workspaces.ahead(p) : 0,
      pending: [...new Set(store.listPendingApprovals(p.id, 'push').map((a) => a.taskId))],
    })));
    return { projects: projects.filter((p) => p.ahead > 0 || p.pending.length > 0) };
  });
  app.post('/api/projects/:id/push', async (req) => {
    await actions.pushProject(id(req));
    return { ok: true };
  });
  app.post('/api/tasks/:id/push', async (req) => {
    await actions.approvePush(id(req));
    return { ok: true };
  });

  app.post('/api/tasks/:id/release', async (req) => d.releases.request(id(req)));
  app.post('/api/jobs/:id/retry', async (req) => d.releases.retry(Number(id(req))));
  app.post('/api/jobs/:id/stop', async (req) => {
    d.releases.stop(Number(id(req)));
    return { ok: true };
  });

  app.get('/api/artifacts/:id/file', async (req, reply) => {
    const a = store.getArtifact(Number(id(req)));
    const root = path.join(config.dataDir, 'artifacts');
    if (!isInside(root, a.path)) return reply.code(403).send({ error: 'Ruta no permitida' });
    let size = -1;
    try {
      const st = statSync(a.path);
      if (st.isFile()) size = st.size;
    } catch { /* no existe */ }
    if (size < 0) return reply.code(404).send({ error: 'El archivo ya no existe' });
    const stream = (opts?: { start: number; end: number }) => {
      const s = createReadStream(a.path, opts);
      s.on('error', (e) => {
        console.error('Error leyendo artefacto', e);
        reply.raw.destroy();
      });
      return s;
    };
    reply.header('x-content-type-options', 'nosniff').header('accept-ranges', 'bytes');
    reply.type(MIME[path.extname(a.path).toLowerCase()] ?? 'text/plain; charset=utf-8');
    const header = req.headers.range;
    if (header === undefined) return reply.header('content-length', size).send(stream());
    const range = parseRange(header, size);
    if (!range) return reply.code(416).header('content-range', `bytes */${size}`).type('application/json; charset=utf-8').send({ error: 'Rango no válido' });
    return reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`)
      .header('content-length', range.end - range.start + 1).send(stream(range));
  });

  if (d.metrics) {
    const metrics = d.metrics;
    app.get('/api/metrics', async (req, reply) => {
      const project = (req.query as { project?: string }).project;
      if (!project) return reply.code(400).send({ error: 'Falta el proyecto' });
      if (!config.projects.some((p) => p.id === project)) return reply.code(404).send({ error: 'Proyecto desconocido' });
      return {
        status: metrics.status(project),
        cards: buildCards(store, project, new Date(), getProject(config, project).metrics),
        funnel: funnelView(getProject(config, project).metrics?.posthogFunnel),
        keychain: Object.fromEntries((['revenuecat', 'posthog', 'asc-key-id', 'asc-issuer', 'asc-p8'] as const).map((n) => [n, addSecretCommand(n)])),
      };
    });
    app.post('/api/metrics/refresh', async () => {
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), 60_000); });
      try {
        const result = await Promise.race([metrics.collectAll().then(() => 'ok' as const), limit]);
        return { ok: result === 'ok' };
      } finally {
        clearTimeout(timer);
      }
    });
  }

  if (d.aso) {
    const aso = d.aso;
    const asoProject = (projectId: string | undefined): ProjectConfig => {
      if (!projectId) throw new BadRequestError('Falta el proyecto');
      const p = config.projects.find((x) => x.id === projectId);
      if (!p?.aso) throw new NotFoundError('Proyecto desconocido');
      return p;
    };
    const asoStore = (projectId: string | undefined, storeId: string | undefined) => {
      const p = asoProject(projectId);
      if (!storeId) throw new BadRequestError('Falta la tienda');
      const s = p.aso!.stores.find((x) => x.id === storeId);
      if (!s) throw new NotFoundError('Tienda desconocida');
      return { project: p, store: s };
    };
    const decide = (proposalId: number, decision: 'accepted' | 'rejected') => {
      try {
        return store.aso.decideProposal(proposalId, decision);
      } catch (e) {
        if (e instanceof AsoProposalError) {
          if (e.reason === 'not_found') throw new NotFoundError(e.message);
          throw new ActionError(e.message);
        }
        throw e;
      }
    };

    app.get('/api/aso', async (req) => {
      const q = req.query as { project?: string; store?: string };
      const { project, store: st } = asoStore(q.project, q.store);
      const now = new Date();
      // La ficha la guarda el colector en cada pasada; solo si aún no hay ninguna se pregunta (rápido) a esta tienda.
      const current = store.aso.storedFicha(project.id, st.id)?.ficha ?? await aso.ficha(project, st).catch(() => null);
      const words = current ? fichaWords(current) : null;
      const keywords = store.aso.listKeywords(project.id, st.id).map((k) => {
        const last = store.aso.latestObservation(k.id);
        // Misma ventana y mínimo que los avisos (rankWindow): ≥ 3 días previos con puesto en los 7 días anteriores.
        const { today, prior } = rankWindow(store.aso, k.id, now);
        const ranked = prior.filter((o) => o.rank !== null).map((o) => o.rank as number);
        let rankDelta7: number | null = null;
        if (ranked.length >= MIN_PRIOR_DAYS && today?.ok && today.rank !== null) {
          rankDelta7 = today.rank - ranked.reduce((a, b) => a + b, 0) / ranked.length;
        }
        return {
          id: k.id, text: k.text, source: k.source, inFicha: words ? inFicha(k.text, words) : false,
          popularity: last?.popularity ?? null, difficulty: last?.difficulty ?? null,
          opportunity: last?.popularity != null && last.difficulty != null ? opportunity(last.popularity, last.difficulty) : null,
          rank: last?.rank ?? null, rankDelta7, takenAt: last?.takenAt ?? null, ok: last?.ok ?? false,
        };
      });
      const pending = store.aso.listProposals(project.id, 'pending').filter((p) => p.storeId === st.id || p.storeId === null);
      return {
        stores: project.aso!.stores.map((s) => ({ id: s.id, country: s.country })),
        lastRun: store.aso.lastRun(project.id),
        ficha: { current, proposal: [...pending].reverse().find((p) => p.kind === 'ficha' && p.storeId === st.id) ?? null },
        keywords,
        pending: pending.filter((p) => p.kind !== 'ficha'),
        competitors: store.aso.listCompetitors(project.id).map((c) => {
          const changes = store.aso.competitorSnaps(c.id, st.id, 10);
          return { id: c.id, appId: c.appId, name: c.name, current: changes[0] ?? null, changes };
        }),
      };
    });

    app.get('/api/aso/keywords/:id/history', async (req) =>
      store.aso.observations(Number(id(req)), new Date(Date.now() - 90 * DAY).toISOString()));

    app.post('/api/aso/keywords', async (req) => {
      const b = AsoKeywordBody.parse(req.body);
      const { project, store: st } = asoStore(b.project, b.store);
      if (!normalizeKeyword(b.text)) throw new BadRequestError('La keyword no puede estar vacía');
      return store.aso.addKeyword(project.id, st.id, b.text, 'user');
    });
    app.post('/api/aso/keywords/:id/archive', async (req) => {
      if (!store.aso.archiveKeyword(Number(id(req)))) throw new NotFoundError('Keyword no encontrada');
      return { ok: true };
    });

    app.post('/api/aso/competitors', async (req) => {
      const b = AsoCompetitorBody.parse(req.body);
      return store.aso.addCompetitor(asoProject(b.project).id, b.appId, b.name);
    });
    app.post('/api/aso/competitors/:id/archive', async (req) => {
      if (!store.aso.archiveCompetitor(Number(id(req)))) throw new NotFoundError('Competidor no encontrado');
      return { ok: true };
    });

    // Antes que `/proposals/:id`: la ruta fija gana, pero así se lee mejor.
    app.post('/api/aso/proposals/accept-all', async (req) => {
      const b = AsoStoreBody.parse(req.body);
      const { project, store: st } = asoStore(b.project, b.store);
      // Los competidores se proponen sin tienda: valen para todas.
      const todo = store.aso.listProposals(project.id, 'pending')
        .filter((p) => p.kind !== 'ficha' && (p.storeId === st.id || p.storeId === null));
      let accepted = 0;
      for (const p of todo) {
        // Una propuesta inválida (p. ej. un appId que no es número) se queda pendiente: no frena las demás.
        try { store.aso.decideProposal(p.id, 'accepted'); accepted++; } catch (e) { if (!(e instanceof AsoProposalError && e.reason === 'invalid')) throw e; }
      }
      return { ok: true, accepted };
    });
    app.post('/api/aso/proposals/:id', async (req) => decide(Number(id(req)), AsoDecisionBody.parse(req.body).decision));

    app.post('/api/aso/refresh', async () => {
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), 120_000); });
      try {
        const result = await Promise.race([aso.collector.collectAll().then(() => 'ok' as const), limit]);
        return { ok: result === 'ok' };
      } finally {
        clearTimeout(timer);
      }
    });
  }

  app.get('/api/queue', async () => orchestrator.queueState());
  app.post('/api/queue/resume', async () => {
    orchestrator.resume();
    return orchestrator.queueState();
  });

  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    reply.raw.write(': conectado\n\n');
    let off: (() => void) | null = null;
    let offRevoke: (() => void) | null = null;
    let ping: NodeJS.Timeout | null = null;
    const cleanup = () => {
      off?.(); off = null;
      offRevoke?.(); offRevoke = null;
      if (ping) { clearInterval(ping); ping = null; }
    };
    const close = () => {
      cleanup();
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    // Un remoto pierde el flujo en cuanto se revoca su dispositivo (aviso inmediato y, por si acaso, en cada ping).
    const deviceId = req.faroLocal ? null : (req.faroDevice?.id ?? null);
    const send = (text: string) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return cleanup();
      try {
        reply.raw.write(text);
      } catch {
        return cleanup();
      }
      if (reply.raw.writableLength > 1_000_000) {
        cleanup();
        reply.raw.end();
      }
    };
    req.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);
    off = bus.subscribe((m) => send(`data: ${JSON.stringify(m)}\n\n`));
    if (deviceId) offRevoke = auth.onRevoke((revoked) => { if (revoked === deviceId) close(); });
    ping = setInterval(() => {
      if (deviceId && auth.verifyCookie(req.headers.cookie)?.id !== deviceId) return close();
      send(': ping\n\n');
    }, 25_000);
  });

  if (d.webDir && existsSync(d.webDir)) {
    app.register(fastifyStatic, { root: d.webDir });
  }

  return app;
}

/** Lo que la web necesita del embudo: título y etapas (sin las condiciones HogQL). */
function funnelView(f: FunnelConfig | undefined): { title: string; steps: { event: string; label: string }[] } | null {
  return f ? { title: f.title ?? 'Embudo', steps: f.steps.map(({ event, label }) => ({ event, label })) } : null;
}
