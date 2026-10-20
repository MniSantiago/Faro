import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from './api';
import { canChange, editableBy, type Access, type Actor, type Change } from './config-access';
import { draftRoutine } from './assistant';
import { AssistantError, BadRequestError, ForbiddenError } from './errors';
import { addSecretCommand, secretExists, type SecretName } from './keychain';
import type { IgnoredOverride, LiveConfig, Origin, OverrideKind } from './overrides';
import { nextRun } from './scheduler';
import { NotFoundError } from './store';
import { EFFORTS, type CheckConfig, type FaroConfig, type ProfileConfig, type ProjectConfig, type ReleaseConfig, type RetryWatchdogConfig, type RoutineConfig } from './types';
import type { AsoStoreConfig } from './aso/types';
import type { MetricsConfig } from './metrics/types';
import { slugify } from './workspaces';

type Obj = Record<string, unknown>;

const level = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const text = z.string().trim().min(1);
const budget = z.number().positive();

// Campos que el panel puede escribir. `.strict()`: cualquier otro (release, draft, mcpConfig, rutas...) → 400.
const routineFields = {
  name: text.max(200),
  title: text.max(200),
  prompt: text,
  cron: text.nullable(),
  profileId: text,
  level,
  context: z.enum(['metrics', 'estado', 'aso']).nullable(),
  maxBudgetUsd: budget.nullable(),
};
const RoutinePut = z.object(routineFields).partial().strict();
const RoutinePost = z.object({
  ...routineFields,
  projectId: text,
  cron: routineFields.cron.optional(),
  context: routineFields.context.optional(),
  maxBudgetUsd: routineFields.maxBudgetUsd.optional(),
}).strict();

const profileFields = {
  name: text.max(200),
  instructions: text,
  defaultLevel: level,
  model: text.nullable(),
  effort: z.enum(EFFORTS).nullable(),
  maxBudgetUsd: budget.nullable(),
  timeoutMinutes: z.number().positive(),
};
const ProfilePut = z.object(profileFields).partial().strict();
const ProfilePost = z.object({
  ...profileFields,
  model: profileFields.model.optional(),
  effort: profileFields.effort.optional(),
  maxBudgetUsd: profileFields.maxBudgetUsd.optional(),
}).strict();

const FunnelBody = z.object({
  title: z.string().optional(),
  steps: z.array(z.object({ event: z.string(), label: z.string(), where: z.string().optional() }).strict()),
  filter: z.string().optional(),
  conversion: z.object({ from: z.string(), to: z.string(), label: z.string() }).strict().optional(),
}).strict();
const metricId = text.nullable();
const ProjectPatch = z.object({
  baseBranch: text,
  github: z.object({ ci: z.boolean().nullable(), prs: z.boolean().nullable(), ciProfile: text.nullable() }).partial().strict().nullable(),
  backlogFile: text.nullable(),
  contextWindow: z.number().int().positive().nullable(),
  metrics: z.object({
    revenuecatProjectId: metricId, posthogHost: metricId, posthogProjectId: metricId, ascAppId: metricId, ascVendorNumber: metricId,
    posthogFunnel: FunnelBody.nullable(),
  }).partial().strict().nullable(),
}).partial().strict();

/** Cuerpos que acepta el API (lo que manda la web). */
export type RoutineCreateBody = z.input<typeof RoutinePost>;
export type RoutineUpdateBody = z.input<typeof RoutinePut>;
export type ProfileCreateBody = z.input<typeof ProfilePost>;
export type ProfileUpdateBody = z.input<typeof ProfilePut>;
export type ProjectUpdateBody = z.input<typeof ProjectPatch>;

const wait = z.number().int().min(0).nullable();
const GeneralPatch = z.object({
  title: text.max(80).nullable(),
  maxConcurrentRuns: z.number().int().min(1),
  coordinatorProfile: text.nullable(),
  retryWatchdog: z.object({ enabled: z.boolean().nullable(), maxWaitMs: wait, maxUsageLimitWaitMs: wait }).partial().strict().nullable(),
}).partial().strict();
export type GeneralUpdateBody = z.input<typeof GeneralPatch>;

/** Lo que devuelven `GET /api/config/full` y, para cada elemento, las rutas que lo cambian. */
interface ElementMeta { origin: Origin; overridden: string[]; editable: Access }
export type ConfigRoutineView = RoutineConfig & ElementMeta & { projectId: string; nextRunAt: string | null };
export type ConfigProfileView = ProfileConfig & ElementMeta & { usedBy: string[] };
export interface ConfigProjectView extends ElementMeta {
  id: string; name: string; baseBranch: string;
  github: ProjectConfig['github'] | null; backlogFile: string | null; contextWindow: number | null; metrics: MetricsConfig | null;
  readonly: {
    checks: CheckConfig[]; prepare: string[]; exclude: string[]; release: ReleaseConfig | null;
    asoStores: AsoStoreConfig[]; repoPath: string; worktreesDir: string;
  };
  /** Conectado o falta (sin leer el valor), y el comando para añadirlo. Vacíos si el proyecto no tiene `metrics`. */
  secrets: Record<string, boolean>;
  secretCommands: Record<string, string>;
}
export interface ConfigGeneralView extends ElementMeta {
  title: string; maxConcurrentRuns: number; coordinatorProfile: string; retryWatchdog: RetryWatchdogConfig | null;
  readonly: { host: string; port: number; dataDir: string; allowedHosts: string[]; claudeVersion: string | null };
}
export type RoutineContext = NonNullable<RoutineConfig['context']>;
export interface ConfigFull {
  general: ConfigGeneralView;
  projects: ConfigProjectView[];
  profiles: ConfigProfileView[];
  routines: ConfigRoutineView[];
  ignored: IgnoredOverride[];
  contexts: Record<string, RoutineContext[]>;
}

/**
 * Todos los campos de una rutina y de un perfil. Se guardan todos (los que faltan, a null): así lo guardado es
 * exactamente el `after` que se comprobó, aunque quede en la BD un override anterior que no se aplica.
 */
const ROUTINE_KEYS = ['name', 'cron', 'profileId', 'level', 'title', 'prompt', 'draft', 'release', 'context', 'maxBudgetUsd'] as const;
const PROFILE_KEYS = ['name', 'instructions', 'model', 'effort', 'maxBudgetUsd', 'defaultLevel', 'timeoutMinutes', 'mcpConfig'] as const;
/** Lo editable de Proyecto y Generales: también se manda entero, por la misma razón. */
const PROJECT_KEYS = ['baseBranch', 'github', 'backlogFile', 'contextWindow', 'metrics'] as const;
const GENERAL_KEYS = ['title', 'maxConcurrentRuns', 'coordinatorProfile', 'retryWatchdog'] as const;
const SECRETS_TTL_MS = 60_000;
const METRICS_SECRETS: SecretName[] = ['revenuecat', 'posthog', 'asc-key-id', 'asc-issuer', 'asc-p8'];

const LABEL = { routine: 'La rutina', profile: 'El perfil' } as const;

/** `base` con `body` encima; un campo a null se quita. */
function merged(base: Obj, body: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** Fusiona un subobjeto (github, metrics, retryWatchdog) con el actual; null o vacío = quitarlo. */
function mergedNested(cur: unknown, body: Obj | null): Obj | null {
  if (body === null) return null;
  const out = merged((cur as Obj | undefined) ?? {}, body);
  return Object.keys(out).length ? out : null;
}

const allKeys = (after: Obj, keys: readonly string[]): Obj => Object.fromEntries(keys.map((k) => [k, after[k] ?? null]));

function findRoutine(c: FaroConfig, id: string): { project: ProjectConfig; routine: RoutineConfig } | null {
  for (const project of c.projects) {
    const routine = (project.routines ?? []).find((r) => r.id === id);
    if (routine) return { project, routine };
  }
  return null;
}

const findProfile = (c: FaroConfig, id: string): ProfileConfig | null => c.profiles.find((p) => p.id === id) ?? null;

/** Id nuevo a partir del nombre: slug y, si ya existe (también entre los overrides que no se aplican), `-2`, `-3`… */
function newId(name: string, taken: Set<string>): string {
  const base = slugify(name);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Rutas del panel de configuración (`/api/config/*`): leer la config efectiva y cambiarla con permisos por dispositivo. */
export function registerConfigRoutes(app: FastifyInstance, d: ApiDeps & { live: LiveConfig }): void {
  const { live, bus } = d;
  const config = live.config;
  const exists = d.secretExists ?? secretExists;
  // Estado de los secretos (sin leer su valor), cacheado un minuto: el panel lo pide a menudo.
  let secretsCache: { at: number; value: Promise<Record<string, boolean>> } | null = null;
  const secretsStatus = (): Promise<Record<string, boolean>> => {
    if (!secretsCache || Date.now() - secretsCache.at > SECRETS_TTL_MS) {
      const value = Promise.all(METRICS_SECRETS.map(async (n) => [n, await exists(n).catch(() => false)] as const))
        .then((pairs) => Object.fromEntries(pairs));
      secretsCache = { at: Date.now(), value };
    }
    return secretsCache.value;
  };
  const claudeVersion = () => d.claudeVersion?.() ?? null;

  const actor = (req: FastifyRequest): Actor => ({ local: req.faroLocal });
  const by = (req: FastifyRequest) => ({ deviceId: req.faroDevice?.id ?? null });
  /** `before` siempre sale de la config viva; nunca del cuerpo. */
  const check = (req: FastifyRequest, change: Change) => {
    const a = canChange(actor(req), change, config);
    if (!a.ok) throw new ForbiddenError(a.reason);
  };
  const changed = () => bus.emit({ type: 'config' });
  const isIgnored = (kind: OverrideKind, id: string) => live.ignored().some((i) => i.kind === kind && i.id === id);
  const ignoredIds = (kind: OverrideKind) => live.ignored().filter((i) => i.kind === kind).map((i) => i.id);

  const routineView = (req: FastifyRequest, projectId: string, r: RoutineConfig, now = new Date()): ConfigRoutineView => ({
    ...r,
    projectId,
    origin: live.origin('routine', r.id),
    overridden: live.overriddenFields('routine', r.id),
    editable: editableBy(actor(req), 'routine', r.id, config, live.fileConfig()),
    nextRunAt: r.cron ? nextRun(r.cron, now)?.toISOString() ?? null : null,
  });
  const profileView = (req: FastifyRequest, p: ProfileConfig): ConfigProfileView => ({
    ...p,
    origin: live.origin('profile', p.id),
    overridden: live.overriddenFields('profile', p.id),
    editable: editableBy(actor(req), 'profile', p.id, config, live.fileConfig()),
    usedBy: config.projects.flatMap((x) => (x.routines ?? []).filter((r) => r.profileId === p.id).map((r) => r.id)),
  });
  const projectView = (req: FastifyRequest, p: ProjectConfig, secrets: Record<string, boolean>): ConfigProjectView => ({
    id: p.id,
    name: p.name,
    baseBranch: p.baseBranch,
    github: p.github ?? null,
    backlogFile: p.backlogFile ?? null,
    contextWindow: p.contextWindow ?? null,
    metrics: p.metrics ?? null,
    // Se ven, pero se editan en faro.config.ts.
    readonly: {
      checks: p.checks ?? [], prepare: p.prepare ?? [], exclude: p.exclude ?? [], release: p.release ?? null,
      asoStores: p.aso?.stores ?? [], repoPath: p.repoPath, worktreesDir: p.worktreesDir,
    },
    secrets: p.metrics ? secrets : {},
    secretCommands: p.metrics ? Object.fromEntries(METRICS_SECRETS.map((n) => [n, addSecretCommand(n)])) : {},
    origin: live.origin('project', p.id),
    overridden: live.overriddenFields('project', p.id),
    editable: editableBy(actor(req), 'project', p.id, config),
  });
  const generalView = (req: FastifyRequest): ConfigGeneralView => ({
    title: config.title ?? 'Faro',
    maxConcurrentRuns: config.maxConcurrentRuns,
    coordinatorProfile: config.coordinatorProfile ?? 'coordinador',
    retryWatchdog: config.retryWatchdog ?? null,
    readonly: { host: config.host, port: config.port, dataDir: config.dataDir, allowedHosts: config.allowedHosts ?? [], claudeVersion: claudeVersion() },
    origin: live.origin('general', 'general'),
    overridden: live.overriddenFields('general', 'general'),
    editable: editableBy(actor(req), 'general', 'general', config),
  });

  const routineOrThrow = (id: string) => {
    const x = findRoutine(config, id);
    if (!x) throw new NotFoundError(`La rutina ${id} no existe`);
    return x;
  };
  const profileOrThrow = (id: string) => {
    const p = findProfile(config, id);
    if (!p) throw new NotFoundError(`El perfil ${id} no existe`);
    return p;
  };
  const projectOrThrow = (id: string) => {
    const p = config.projects.find((x) => x.id === id);
    if (!p) throw new NotFoundError('Proyecto desconocido');
    return p;
  };

  const id = (req: FastifyRequest) => (req.params as { id: string }).id;

  app.get('/api/config/full', async (req): Promise<ConfigFull> => {
    const secrets = await secretsStatus();
    const now = new Date();
    return {
      general: generalView(req),
      projects: config.projects.map((p) => projectView(req, p, secrets)),
      profiles: config.profiles.map((p) => profileView(req, p)),
      routines: config.projects.flatMap((p) => (p.routines ?? []).map((r) => routineView(req, p.id, r, now))),
      ignored: live.ignored(),
      contexts: Object.fromEntries(config.projects.map((p): [string, RoutineContext[]] => [p.id, [
        'estado', ...(p.metrics ? ['metrics' as const] : []), ...(p.aso ? ['aso' as const] : []),
      ]])),
    };
  });

  // Asistente: no guarda nada (el nivel del borrador ya viene capado a 2), así que vale para cualquier dispositivo vinculado.
  app.post('/api/config/routines/draft', async (req) => {
    const b = z.object({ projectId: text, description: text.max(2000) }).strict().parse(req.body);
    projectOrThrow(b.projectId);
    try {
      return await draftRoutine({ config, store: d.store, claudeBin: config.claudeBin }, b.projectId, b.description);
    } catch (e) {
      // Un dispositivo vinculado no ve el detalle de la CLI (rutas, salida de error): queda en el log.
      if (e instanceof AssistantError && e.status === 502 && !req.faroLocal) {
        console.error('Asistente de rutinas', e.message);
        throw new AssistantError('El asistente no pudo redactar la rutina');
      }
      throw e;
    }
  });

  // Rutinas
  app.post('/api/config/routines', async (req) => {
    const b = RoutinePost.parse(req.body);
    projectOrThrow(b.projectId);
    const taken = new Set([...config.projects.flatMap((p) => (p.routines ?? []).map((r) => r.id)), ...ignoredIds('routine')]);
    const rid = newId(b.name, taken);
    const after = merged({ id: rid }, b);
    delete after.projectId;
    check(req, { kind: 'routine', id: rid, before: null, after });
    live.save('routine', rid, merged(after, { projectId: b.projectId }), by(req));
    changed();
    const x = routineOrThrow(rid);
    return routineView(req, x.project.id, x.routine);
  });
  app.put('/api/config/routines/:id', async (req) => {
    const rid = id(req);
    const b = RoutinePut.parse(req.body);
    const cur = routineOrThrow(rid);
    const before: Obj = { ...cur.routine };
    const after = merged(before, b);
    check(req, { kind: 'routine', id: rid, before, after });
    live.save('routine', rid, allKeys(after, ROUTINE_KEYS), by(req));
    changed();
    const x = routineOrThrow(rid);
    return routineView(req, x.project.id, x.routine);
  });
  app.delete('/api/config/routines/:id', async (req) => {
    const rid = id(req);
    const cur = findRoutine(config, rid)?.routine ?? null;
    remove(req, 'routine', rid, cur ? { ...cur } : null, findRoutine(live.fileConfig(), rid)?.routine ?? null);
    return { ok: true };
  });

  // Perfiles
  app.post('/api/config/profiles', async (req) => {
    const b = ProfilePost.parse(req.body);
    const pid = newId(b.name, new Set([...config.profiles.map((p) => p.id), ...ignoredIds('profile')]));
    const after = merged({ id: pid }, b);
    check(req, { kind: 'profile', id: pid, before: null, after });
    live.save('profile', pid, after, by(req));
    changed();
    return profileView(req, profileOrThrow(pid));
  });
  app.put('/api/config/profiles/:id', async (req) => {
    const pid = id(req);
    const b = ProfilePut.parse(req.body);
    const before: Obj = { ...profileOrThrow(pid) };
    const after = merged(before, b);
    check(req, { kind: 'profile', id: pid, before, after });
    live.save('profile', pid, allKeys(after, PROFILE_KEYS), by(req));
    changed();
    return profileView(req, profileOrThrow(pid));
  });
  app.delete('/api/config/profiles/:id', async (req) => {
    const pid = id(req);
    const cur = findProfile(config, pid);
    const restored = findProfile(live.fileConfig(), pid);
    if (cur && !restored) {
      const usedBy = config.projects.flatMap((p) => (p.routines ?? []).filter((r) => r.profileId === pid).map((r) => r.id));
      if (usedBy.length) throw new BadRequestError(`No se puede borrar: ${usedBy.length > 1 ? 'lo usan las rutinas' : 'lo usa la rutina'} ${usedBy.join(', ')}`);
    }
    remove(req, 'profile', pid, cur ? { ...cur } : null, restored);
    return { ok: true };
  });

  /**
   * Del panel: lo borra. Editada: vuelve a la config (y se comprueba lo que restaura el archivo). Del archivo sin tocar: 400.
   * Un override que no se aplica (ignorado) también se puede quitar.
   */
  function remove(req: FastifyRequest, kind: 'routine' | 'profile', eid: string, before: Obj | null, fromFile: object | null) {
    const ignored = isIgnored(kind, eid);
    if (!before && !ignored) throw new NotFoundError(`${LABEL[kind]} ${eid} no existe`);
    if (before && !ignored && live.origin(kind, eid) === 'config') {
      throw new BadRequestError(`${LABEL[kind]} ${eid} es de faro.config.ts: se cambia o se borra en el archivo`);
    }
    const change: Change = { kind, id: eid, before, after: null };
    if (fromFile) change.restored = { ...fromFile };
    check(req, change);
    live.remove(kind, eid);
    changed();
  }

  // Proyecto y Generales: solo desde el Mac (lo dice canChange).
  app.patch('/api/config/projects/:id', async (req) => {
    const p = projectOrThrow(id(req));
    const b = ProjectPatch.parse(req.body);
    const value: Obj = { ...b };
    if (b.github !== undefined) value.github = mergedNested(p.github, b.github);
    if (b.metrics !== undefined) value.metrics = mergedNested(p.metrics, b.metrics);
    const before: Obj = { ...p };
    const after = merged(before, value);
    check(req, { kind: 'project', id: p.id, before, after });
    live.save('project', p.id, allKeys(after, PROJECT_KEYS), by(req));
    changed();
    return projectView(req, projectOrThrow(p.id), await secretsStatus());
  });
  app.patch('/api/config/general', async (req) => {
    const b = GeneralPatch.parse(req.body);
    const value: Obj = { ...b };
    if (b.retryWatchdog !== undefined) value.retryWatchdog = mergedNested(config.retryWatchdog, b.retryWatchdog);
    const before: Obj = { title: config.title, maxConcurrentRuns: config.maxConcurrentRuns, coordinatorProfile: config.coordinatorProfile, retryWatchdog: config.retryWatchdog };
    const after = merged(before, value);
    check(req, { kind: 'general', id: 'general', before, after });
    live.save('general', 'general', allKeys(after, GENERAL_KEYS), by(req));
    changed();
    return generalView(req);
  });
}
