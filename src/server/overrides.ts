import { ConfigError, normalizeConfig } from './config';
import { NotFoundError, type Store } from './store';
import type { FaroConfig, ProfileConfig, ProjectConfig, RoutineConfig } from './types';

export type OverrideKind = 'routine' | 'profile' | 'project' | 'general';
/** Etiqueta del panel: del archivo sin tocar, del archivo con override, o creada en el panel. */
export type Origin = 'config' | 'editada' | 'panel';

/**
 * Un override del panel. `origin: 'file'` = parche por campo sobre un elemento del archivo (un campo a `null` lo quita);
 * `'panel'` = el elemento entero (una rutina lleva además `projectId`).
 */
export interface OverrideRow {
  kind: OverrideKind;
  id: string;
  origin: 'file' | 'panel';
  data: Record<string, unknown>;
  updatedAt: string;
  deviceId: string | null;
}

export interface IgnoredOverride { kind: OverrideKind; id: string; reason: string }

type Obj = Record<string, unknown>;

const LABEL: Record<OverrideKind, string> = { routine: 'Rutina', profile: 'Perfil', project: 'Proyecto', general: 'Generales' };
/** Claves que no son campos del elemento: las lleva otro tipo de override (o, `projectId`, la fila de una rutina del panel). */
/** Generales que solo se leen al arrancar o tocan la seguridad: se editan en faro.config.ts, nunca desde el panel. */
const FILE_ONLY_GENERAL = ['host', 'port', 'dataDir', 'allowedHosts', 'claudeBin', 'ghBin', 'sandbox', 'pushContact', 'projects', 'profiles'];
const NOT_FIELDS: Record<OverrideKind, string[]> = { routine: ['projectId'], profile: [], project: ['routines'], general: FILE_ONLY_GENERAL };
/** Primero lo que otros referencian: perfiles, luego proyectos, rutinas y por último Generales (coordinatorProfile). */
const KIND_ORDER: OverrideKind[] = ['profile', 'project', 'routine', 'general'];

const clone = <T>(x: T): T => structuredClone(x);

const omit = (o: Obj, keys: string[]): Obj => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** Aplica `data` sobre `target` (un `null` borra el campo) y devuelve `target`. */
function patch(target: Obj, data: Obj): Obj {
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) delete target[k];
    else target[k] = clone(v);
  }
  return target;
}

/** JSON con las claves ordenadas: compara objetos y listas sin depender del orden de las claves. */
function canonical(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Obj)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
/**
 * Igual al valor del archivo, contando dos textos iguales sin los espacios de alrededor: el API recorta los textos
 * (zod `trim`) y el archivo suele traerlos con saltos de línea (plantillas); si no, cualquier guardado los taparía.
 */
const sameAsFile = (v: unknown, file: unknown) => same(v, file) || (typeof v === 'string' && typeof file === 'string' && v.trim() === file.trim());

function findElement(c: FaroConfig, kind: OverrideKind, id: string): Obj | undefined {
  if (kind === 'general') return id === 'general' ? (c as unknown as Obj) : undefined;
  if (kind === 'profile') return c.profiles.find((p) => p.id === id) as Obj | undefined;
  if (kind === 'project') return c.projects.find((p) => p.id === id) as Obj | undefined;
  return c.projects.flatMap((p) => p.routines ?? []).find((r) => r.id === id) as Obj | undefined;
}

function applyOne(c: FaroConfig, o: OverrideRow): void {
  if (o.origin === 'file' || o.kind === 'general') {
    const el = findElement(c, o.kind, o.id);
    if (!el) throw new ConfigError(`${LABEL[o.kind]} ${o.id}: ya no está en el archivo`);
    patch(el, omit(o.data, [...NOT_FIELDS[o.kind], 'id']));
    return;
  }
  const el = patch({}, omit(o.data, NOT_FIELDS[o.kind]));
  el.id = o.id;
  if (o.kind === 'routine') {
    const p = c.projects.find((x) => x.id === o.data.projectId);
    if (!p) throw new ConfigError(`Rutina ${o.id}: proyecto desconocido ${String(o.data.projectId)}`);
    (p.routines ??= []).push(el as unknown as RoutineConfig);
  } else if (o.kind === 'profile') {
    c.profiles.push(el as unknown as ProfileConfig);
  } else {
    c.projects.push(el as unknown as ProjectConfig);
  }
}

/**
 * Config efectiva = archivo + overrides, validada con `normalizeConfig`. Se aplican por tipo (perfiles, proyectos,
 * rutinas, Generales) y, dentro de cada tipo, en el orden recibido. Un override que deja la config inválida se descarta
 * con su motivo y se sigue con los demás. `raw` no se toca. Si el archivo ya es inválido, lanza su ConfigError.
 */
export function applyOverrides(raw: FaroConfig, rows: OverrideRow[]): { config: FaroConfig; ignored: IgnoredOverride[] } {
  normalizeConfig(clone(raw));
  const ignored: IgnoredOverride[] = [];
  let cur = clone(raw);
  const sorted = KIND_ORDER.flatMap((k) => rows.filter((r) => r.kind === k));
  for (const o of sorted) {
    const next = clone(cur);
    try {
      applyOne(next, o);
      normalizeConfig(next);
      cur = next;
    } catch (e) {
      // Cualquier fallo (no solo ConfigError: un dato con forma rara) descarta el override; Faro arranca igual.
      ignored.push({ kind: o.kind, id: o.id, reason: (e as Error).message });
    }
  }
  return { config: normalizeConfig(cur), ignored };
}

/** Sustituye los campos de `target` por los de `src` sin cambiar la referencia (salvo las claves de `keep`). */
function assignInPlace(target: Obj, src: Obj, keep: string[] = []): void {
  for (const k of Object.keys(target)) if (!(k in src) && !keep.includes(k)) delete target[k];
  for (const [k, v] of Object.entries(src)) if (!keep.includes(k)) target[k] = v;
}

/** Deja `target` con los elementos de `src` en su orden, reutilizando los objetos que ya estaban (mismo id). */
function syncById<T extends { id: string }>(target: T[], src: T[], each: (t: T, s: T) => void): void {
  const byId = new Map(target.map((t) => [t.id, t]));
  const merged = src.map((s) => {
    const t = byId.get(s.id);
    if (!t) return s;
    each(t, s);
    return t;
  });
  target.splice(0, target.length, ...merged);
}

/** Copia la config efectiva dentro de la compartida: los módulos que guardan referencias ven el cambio. */
function copyInto(target: FaroConfig, src: FaroConfig): void {
  assignInPlace(target as unknown as Obj, src as unknown as Obj, ['projects', 'profiles']);
  syncById(target.profiles, src.profiles, (t, s) => assignInPlace(t as unknown as Obj, s as unknown as Obj));
  syncById(target.projects, src.projects, (t, s) => {
    assignInPlace(t as unknown as Obj, s as unknown as Obj, ['routines']);
    if (t.routines) t.routines.splice(0, t.routines.length, ...(s.routines ?? []));
    else if (s.routines) t.routines = s.routines;
  });
}

const key = (kind: OverrideKind, id: string) => `${kind}:${id}`;

/** La config viva: archivo + overrides de la BD, con cambios en caliente sobre el mismo objeto `config`. */
export class LiveConfig {
  readonly config: FaroConfig;
  private rows: OverrideRow[];
  private ignoredList: IgnoredOverride[];
  /** Filas de la BD con datos ilegibles: no se aplican y se listan en `ignored()`. */
  private unreadable: IgnoredOverride[] = [];
  /** El archivo normalizado: una ruta con «~» expandida cuenta como igual a la del archivo. */
  private readonly fileNormalized: FaroConfig;

  constructor(private d: { raw: FaroConfig; store: Store; onChange?: () => void }) {
    this.rows = d.store.listOverrides((kind, id) => this.unreadable.push({ kind, id, reason: 'datos ilegibles' }));
    const r = applyOverrides(d.raw, this.rows);
    this.config = r.config;
    this.ignoredList = r.ignored;
    this.fileNormalized = normalizeConfig(clone(d.raw));
  }

  /** La config del archivo, normalizada y sin overrides (la misma cada vez: solo lectura). Es lo que restaura «volver a la config». */
  fileConfig(): FaroConfig {
    return this.fileNormalized;
  }

  /** Overrides guardados que no se aplican: dejarían la config inválida o sus datos son ilegibles. */
  ignored(): IgnoredOverride[] {
    return [...this.unreadable, ...this.ignoredList].map((i) => ({ ...i }));
  }

  private row(kind: OverrideKind, id: string): OverrideRow | undefined {
    return this.rows.find((r) => r.kind === kind && r.id === id);
  }

  /** El override de ese elemento, solo si está aplicado en la config efectiva. */
  private applied(kind: OverrideKind, id: string): OverrideRow | undefined {
    return this.ignoredList.some((i) => i.kind === kind && i.id === id) ? undefined : this.row(kind, id);
  }

  /** Un override ignorado no cuenta: el elemento del archivo sigue siendo «config» y uno del panel no está en la config. */
  origin(kind: OverrideKind, id: string): Origin {
    const applied = this.applied(kind, id);
    if (findElement(this.d.raw, kind, id)) return applied ? 'editada' : 'config';
    return applied ? 'panel' : 'config';
  }

  /** Campos del archivo que tapa el override aplicado (vacío si no hay, está ignorado o el elemento es del panel). */
  overriddenFields(kind: OverrideKind, id: string): string[] {
    const r = this.applied(kind, id);
    return r?.origin === 'file' ? Object.keys(r.data) : [];
  }

  /**
   * Guarda `value` sobre el elemento: los campos que no trae se conservan (los del override anterior o los del archivo)
   * y un campo a `null` se quita. En un elemento del archivo solo se guardan los campos que quedan distintos del archivo
   * (si no queda ninguno, se borra el override); en uno nuevo o del panel, el elemento entero (una rutina, con `projectId`).
   * Si el cambio deja la config inválida, lanza ConfigError sin tocar nada.
   */
  save(kind: OverrideKind, id: string, value: Record<string, unknown>, by: { deviceId: string | null }): FaroConfig {
    if (kind === 'general' && id !== 'general') throw new ConfigError('Generales: el id es «general»');
    const fileOnly = kind === 'general' ? Object.keys(value).filter((k) => FILE_ONLY_GENERAL.includes(k)) : [];
    if (fileOnly.length) throw new ConfigError(`Se edita en faro.config.ts: ${fileOnly.join(', ')}`);
    const base = { kind, id, updatedAt: new Date().toISOString(), deviceId: by.deviceId };
    const prev = this.row(kind, id);
    const file = findElement(this.d.raw, kind, id);
    if (!file) {
      const data = patch(clone(prev?.origin === 'panel' ? prev.data : {}), omit(value, ['id', ...(kind === 'routine' ? [] : NOT_FIELDS[kind])]));
      return this.commit(kind, id, { ...base, origin: 'panel', data });
    }
    const skip = [...NOT_FIELDS[kind], 'id'];
    const fileFields = omit(file, skip);
    const fileN = omit(findElement(this.fileNormalized, kind, id) ?? {}, skip);
    const wanted = patch(patch(clone(fileFields), prev?.origin === 'file' ? prev.data : {}), omit(value, skip));
    const diff: Obj = {};
    for (const k of new Set([...Object.keys(fileFields), ...Object.keys(wanted)])) {
      if (sameAsFile(wanted[k], fileFields[k]) || sameAsFile(wanted[k], fileN[k])) continue;
      diff[k] = wanted[k] ?? null;
    }
    return this.commit(kind, id, Object.keys(diff).length ? { ...base, origin: 'file', data: diff } : null);
  }

  /** Elemento del archivo: borra su override (vuelve al archivo; sin override no hace nada). Del panel: lo borra. */
  remove(kind: OverrideKind, id: string): FaroConfig {
    if (!this.row(kind, id) && !this.unreadable.some((i) => i.kind === kind && i.id === id)) {
      if (findElement(this.d.raw, kind, id)) return this.config;
      throw new NotFoundError(`${LABEL[kind]} ${id}: no existe`);
    }
    return this.commit(kind, id, null);
  }

  private commit(kind: OverrideKind, id: string, next: OverrideRow | null): FaroConfig {
    const rows = this.rows.filter((r) => !(r.kind === kind && r.id === id));
    if (next) rows.push(next);
    const res = applyOverrides(this.d.raw, rows);
    // Falla si se descarta el propio cambio o si deja inválido otro override que hasta ahora valía.
    const before = new Set(this.ignoredList.map((i) => key(i.kind, i.id)));
    const fail = res.ignored.find((i) => key(i.kind, i.id) === key(kind, id) || !before.has(key(i.kind, i.id)));
    if (fail) throw new ConfigError(fail.reason);
    if (next) this.d.store.setOverride(next);
    else this.d.store.deleteOverride(kind, id);
    this.rows = rows;
    this.ignoredList = res.ignored;
    // Guardar o borrar la fila sustituye la ilegible que hubiera.
    this.unreadable = this.unreadable.filter((i) => key(i.kind, i.id) !== key(kind, id));
    copyInto(this.config, res.config);
    // El cambio ya está aplicado: un fallo al reaccionar (p. ej. resincronizar rutinas) no debe deshacerlo ni propagarse.
    try {
      this.d.onChange?.();
    } catch (e) {
      console.error('[faro] fallo al aplicar el cambio de config', e);
    }
    return this.config;
  }
}
