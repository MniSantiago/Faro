import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Cron } from 'croner';
import { EFFORTS, type FaroConfig, type ProfileConfig, type ProjectConfig } from './types';
import type { FunnelConfig } from './metrics/types';

export class ConfigError extends Error {}

export function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function firstDuplicate(xs: string[]): string | undefined {
  return xs.find((x, i) => xs.indexOf(x) !== i);
}

function checkBudget(where: string, v: unknown): void {
  if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v > 0)) {
    throw new ConfigError(`${where}: maxBudgetUsd debe ser un número positivo`);
  }
}

const METRICS_KEYS = ['revenuecatProjectId', 'posthogHost', 'posthogProjectId', 'ascAppId', 'ascVendorNumber'];

export function normalizeConfig(raw: FaroConfig): FaroConfig {
  const projects = raw.projects.map((p) => ({
    ...p,
    repoPath: expandHome(p.repoPath),
    worktreesDir: expandHome(p.worktreesDir),
    ...(p.backlogFile ? { backlogFile: expandHome(p.backlogFile) } : {}),
  }));
  const dupProject = firstDuplicate(projects.map((p) => p.id));
  if (dupProject) throw new ConfigError(`Proyecto duplicado: ${dupProject}`);
  const dupPrefix = firstDuplicate(projects.map((p) => p.prefix));
  if (dupPrefix) throw new ConfigError(`Prefijo duplicado: ${dupPrefix}`);
  const dupProfile = firstDuplicate(raw.profiles.map((p) => p.id));
  if (dupProfile) throw new ConfigError(`Perfil duplicado: ${dupProfile}`);
  for (const p of raw.profiles) {
    if (![1, 2, 3, 4].includes(p.defaultLevel)) {
      throw new ConfigError(`Nivel inválido en el perfil ${p.id}: ${p.defaultLevel}`);
    }
    if (!(p.timeoutMinutes > 0)) throw new ConfigError(`Tiempo máximo inválido en el perfil ${p.id}`);
    if (p.effort !== undefined && !(EFFORTS as readonly string[]).includes(p.effort)) {
      throw new ConfigError(`Perfil ${p.id}: effort debe ser low, medium, high, xhigh o max`);
    }
    checkBudget(`Perfil ${p.id}`, p.maxBudgetUsd);
  }
  for (const k of ['maxWaitMs', 'maxUsageLimitWaitMs'] as const) {
    const v = raw.retryWatchdog?.[k];
    if (v !== undefined && !(typeof v === 'number' && Number.isInteger(v) && v >= 0)) {
      throw new ConfigError(`retryWatchdog.${k} debe ser un entero no negativo`);
    }
  }
  if (!(raw.maxConcurrentRuns >= 1)) throw new ConfigError('maxConcurrentRuns debe ser al menos 1');
  if (raw.title !== undefined && !text(raw.title)) throw new ConfigError('title debe ser un texto no vacío');
  const profileIds = new Set(raw.profiles.map((p) => p.id));
  if (raw.coordinatorProfile !== undefined && !profileIds.has(raw.coordinatorProfile)) {
    throw new ConfigError(`coordinatorProfile: perfil desconocido ${raw.coordinatorProfile}`);
  }
  for (const p of projects) {
    const ci = p.github?.ciProfile;
    if (ci !== undefined && !profileIds.has(ci)) throw new ConfigError(`Proyecto ${p.id}: github.ciProfile: perfil desconocido ${ci}`);
  }
  const routines = projects.flatMap((p) => p.routines ?? []);
  const dupRoutine = firstDuplicate(routines.map((r) => r.id));
  if (dupRoutine) throw new ConfigError(`Rutina duplicada: ${dupRoutine}`);
  for (const r of routines) {
    if (!raw.profiles.some((p) => p.id === r.profileId)) throw new ConfigError(`Rutina ${r.id}: perfil desconocido ${r.profileId}`);
    if (![1, 2, 3, 4].includes(r.level)) throw new ConfigError(`Nivel inválido en la rutina ${r.id}: ${r.level}`);
    checkBudget(`Rutina ${r.id}`, r.maxBudgetUsd);
    if (r.context !== undefined && r.context !== 'metrics' && r.context !== 'estado' && r.context !== 'aso') throw new ConfigError(`Rutina ${r.id}: context debe ser «metrics», «estado» o «aso»`);
    if (r.cron) {
      try { new Cron(r.cron, { paused: true }); } catch { throw new ConfigError(`Rutina ${r.id}: cron inválido «${r.cron}»`); }
    }
  }
  for (const p of projects) {
    const w = p.contextWindow;
    if (w !== undefined && !(typeof w === 'number' && Number.isInteger(w) && w > 0)) {
      throw new ConfigError(`Proyecto ${p.id}: contextWindow debe ser un entero positivo`);
    }
  }
  for (const p of projects) {
    const r = p.release;
    if (r && !(r.cwd?.trim() && r.build?.trim() && r.submit?.trim())) throw new ConfigError(`Proyecto ${p.id}: release incompleto`);
  }
  for (const p of projects) {
    const m = p.metrics;
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) {
      if (k === 'posthogFunnel') continue;
      if (!METRICS_KEYS.includes(k)) throw new ConfigError(`Proyecto ${p.id}: metrics.${k} no es una clave conocida`);
      if (v !== undefined && (typeof v !== 'string' || !v.trim())) throw new ConfigError(`Proyecto ${p.id}: metrics.${k} debe ser un texto no vacío`);
    }
    if (m.posthogFunnel !== undefined) checkFunnel(p.id, m.posthogFunnel);
    if (m.posthogHost) {
      let u: URL | null = null;
      try { u = new URL(m.posthogHost); } catch { /* inválida */ }
      if (!u || u.protocol !== 'https:') throw new ConfigError(`Proyecto ${p.id}: metrics.posthogHost debe ser una URL https`);
    }
  }
  for (const p of projects) {
    const a = p.aso;
    if (a) {
      const bad = (msg: string) => new ConfigError(`Proyecto ${p.id}: aso.${msg}`);
      if (typeof a.appId !== 'string' || !/^\d+$/.test(a.appId)) throw bad('appId debe ser numérico');
      if (!Array.isArray(a.stores) || a.stores.length === 0) throw bad('stores debe tener al menos una tienda');
      const dupStore = firstDuplicate(a.stores.map((s) => s.id));
      if (dupStore) throw bad(`stores repite el id «${dupStore}»`);
      for (const s of a.stores) {
        if (typeof s.id !== 'string' || !s.id.trim()) throw bad('stores[].id debe ser un texto no vacío');
        if (typeof s.country !== 'string' || !/^[a-z]{2}$/.test(s.country)) throw bad(`stores[${s.id}].country debe ser de 2 letras minúsculas`);
        if (typeof s.storefront !== 'string' || !s.storefront.trim()) throw bad(`stores[${s.id}].storefront debe ser un texto no vacío`);
        const f = s.fichaFile;
        if (typeof f !== 'string' || !f.trim() || path.isAbsolute(f) || f.split(/[\\/]/).includes('..')) throw bad(`stores[${s.id}].fichaFile debe ser una ruta relativa sin «..»`);
      }
    }
  }
  for (const p of projects) {
    for (const r of p.routines ?? []) {
      if (r.context === 'aso' && !p.aso) throw new ConfigError(`Rutina ${r.id}: context «aso» necesita el bloque aso del proyecto`);
      if (r.release && r.release !== 'none' && !p.release) throw new ConfigError(`Rutina ${r.id}: pide release pero el proyecto ${p.id} no lo configura`);
    }
  }
  return { ...raw, dataDir: expandHome(raw.dataDir), projects, profiles: raw.profiles };
}

const text = (v: unknown) => typeof v === 'string' && v.trim() !== '';

function checkFunnel(projectId: string, f: FunnelConfig): void {
  const bad = (msg: string) => new ConfigError(`Proyecto ${projectId}: metrics.posthogFunnel.${msg}`);
  if (!f || !Array.isArray(f.steps) || f.steps.length === 0) throw bad('steps debe tener al menos una etapa');
  for (const st of f.steps) {
    if (typeof st.event !== 'string' || !/^[\w$.:-]+$/.test(st.event)) throw bad(`steps[].event «${String(st.event)}» solo admite letras, números y _ $ . : -`);
    if (!text(st.label)) throw bad(`steps[${st.event}].label debe ser un texto no vacío`);
    if (st.where !== undefined && !text(st.where)) throw bad(`steps[${st.event}].where debe ser un texto no vacío`);
  }
  const dup = firstDuplicate(f.steps.map((st) => st.event));
  if (dup) throw bad(`steps repite el evento «${dup}»`);
  if (f.filter !== undefined && !text(f.filter)) throw bad('filter debe ser un texto no vacío');
  if (f.title !== undefined && !text(f.title)) throw bad('title debe ser un texto no vacío');
  const c = f.conversion;
  if (c !== undefined) {
    const events = f.steps.map((st) => st.event);
    if (!events.includes(c.from) || !events.includes(c.to)) throw bad('conversion.from y conversion.to deben ser eventos de steps');
    if (!text(c.label)) throw bad('conversion.label debe ser un texto no vacío');
  }
}

export async function loadConfig(file = path.resolve(process.env.FARO_CONFIG ?? 'faro.config.ts')): Promise<FaroConfig> {
  if (!existsSync(file)) {
    throw new ConfigError(`No existe ${file}: copia faro.config.example.ts a faro.config.ts (o apunta FARO_CONFIG a tu config).`);
  }
  const mod = (await import(pathToFileURL(file).href)) as { default: FaroConfig };
  return normalizeConfig(mod.default);
}

export function getProject(c: FaroConfig, id: string): ProjectConfig {
  const p = c.projects.find((x) => x.id === id);
  if (!p) throw new ConfigError(`Proyecto desconocido: ${id}`);
  return p;
}

export function getProfile(c: FaroConfig, id: string): ProfileConfig {
  const p = c.profiles.find((x) => x.id === id);
  if (!p) throw new ConfigError(`Perfil desconocido: ${id}`);
  return p;
}
