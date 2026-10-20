import { Cron } from 'croner';
import { useEffect, useRef, useState } from 'react';
import type { ConfigFull, ConfigRoutineView, RoutineContext, RoutineCreateBody } from '../../../server/api-config';
import type { Level } from '../../../server/types';
import { api, LEVEL_LABEL, type RoutineDraft } from '../../api';
import { cronFromSchedule, scheduleError, scheduleFromCron, type Schedule } from '../../schedule';

type Kind = Schedule['kind'];
const KINDS: [Kind, string][] = [['manual', 'Manual'], ['daily', 'Cada día'], ['weekly', 'Cada semana'], ['monthly', 'Cada mes'], ['custom', 'Personalizado']];
/** Lunes primero, como en el calendario de aquí; el valor es el del cron (0 = domingo). */
const WEEK: [number, string][] = [[1, 'L'], [2, 'M'], [3, 'X'], [4, 'J'], [5, 'V'], [6, 'S'], [0, 'D']];
const WEEK_NAME = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const CONTEXT_LABEL: Record<RoutineContext, string> = { estado: 'Estado', metrics: 'Métricas', aso: 'ASO' };
const LEVELS: Level[] = [1, 2, 3, 4];
/** Etiquetas de los campos que puede tapar una rutina «editada» (claves de `overridden`). */
const FIELD_LABEL: Record<string, string> = {
  name: 'Nombre', title: 'Título', cron: 'Cuándo', level: 'Nivel', profileId: 'Perfil', maxBudgetUsd: 'Tope de gasto',
  context: 'Contexto', prompt: 'Instrucciones',
};

/** Lo que edita el formulario. El tope de gasto va como texto para admitir la coma decimal. */
export interface RoutineFormState {
  name: string; title: string; schedule: Schedule; level: Level; profileId: string;
  budget: string; context: RoutineContext | null; enabled: boolean; prompt: string;
}

const fmtBudget = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','));

export function formFromRoutine(r: ConfigRoutineView, enabled: boolean): RoutineFormState {
  return {
    name: r.name, title: r.title, schedule: scheduleFromCron(r.cron ?? null), level: r.level, profileId: r.profileId,
    budget: fmtBudget(r.maxBudgetUsd), context: r.context ?? null, enabled, prompt: r.prompt,
  };
}

function emptyForm(profileId: string): RoutineFormState {
  return { name: '', title: '', schedule: { kind: 'manual' }, level: 1, profileId, budget: '', context: null, enabled: false, prompt: '' };
}

/** El cuerpo que se manda (todos los campos editables; null = quitarlo) o el motivo por el que no se puede. */
type Body = Omit<RoutineCreateBody, 'projectId'> & { cron: string | null; context: RoutineContext | null; maxBudgetUsd: number | null };
function toBody(f: RoutineFormState): { ok: true; body: Body } | { ok: false; error: string } {
  if (!f.name.trim()) return { ok: false, error: 'Falta el nombre' };
  if (!f.title.trim()) return { ok: false, error: 'Falta el título de cada tarea' };
  if (!f.prompt.trim()) return { ok: false, error: 'Faltan las instrucciones' };
  if (!f.profileId) return { ok: false, error: 'Elige un perfil' };
  const se = scheduleError(f.schedule);
  if (se) return { ok: false, error: se };
  let maxBudgetUsd: number | null = null;
  if (f.budget.trim()) {
    const n = Number(f.budget.trim().replace(',', '.').replace(/\s*\$$/, ''));
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'El tope de gasto debe ser un número mayor que 0' };
    maxBudgetUsd = n;
  }
  return {
    ok: true,
    body: { name: f.name, title: f.title, prompt: f.prompt, cron: cronFromSchedule(f.schedule), profileId: f.profileId, level: f.level, context: f.context, maxBudgetUsd },
  };
}

/** Igualdad por lo que se guardaría (dos horarios iguales pueden ser objetos distintos). */
function sameForm(a: RoutineFormState, b: RoutineFormState): boolean {
  return a.name === b.name && a.title === b.title && a.prompt === b.prompt && a.level === b.level && a.profileId === b.profileId
    && a.context === b.context && a.enabled === b.enabled && a.budget.trim() === b.budget.trim()
    && a.schedule.kind === b.schedule.kind && cronFromSchedule(a.schedule) === cronFromSchedule(b.schedule);
}

const timeOf = (s: Schedule) => ('hour' in s ? { hour: s.hour, minute: s.minute } : { hour: 9, minute: 0 });

/** Cambia de forma de horario conservando la hora; a «Personalizado» pasa el cron actual para retocarlo. */
function switchKind(s: Schedule, kind: Kind): Schedule {
  const t = timeOf(s);
  switch (kind) {
    case 'manual': return { kind };
    case 'daily': return { kind, ...t };
    case 'weekly': return { kind, days: s.kind === 'weekly' ? s.days : [1], ...t };
    case 'monthly': return { kind, day: s.kind === 'monthly' ? s.day : 1, ...t };
    case 'custom': return { kind, cron: scheduleError(s) ? '0 9 * * *' : cronFromSchedule(s) ?? '0 9 * * *' };
  }
}

const hhmm = (s: Schedule) => { const t = timeOf(s); return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`; };
const fmtNext = (d: Date) => d.toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Próxima ejecución del horario del formulario (aún sin guardar), con el mismo croner que el programador. */
function nextRunText(s: Schedule): string {
  if (scheduleError(s)) return '';
  const cron = cronFromSchedule(s);
  if (!cron) return 'Solo se lanza a mano';
  try {
    const next = new Cron(cron, { paused: true }).nextRun();
    return next ? `Próxima ejecución: ${fmtNext(next)}` : 'No se volverá a ejecutar';
  } catch {
    return 'El cron no es válido';
  }
}

const ORIGIN_TEXT = { config: 'De faro.config.ts', editada: 'De faro.config.ts, editada en el panel', panel: 'Creada en el panel' } as const;

export interface SavedNotice { taskId?: string; error?: string }

interface Props {
  full: ConfigFull;
  /** null = rutina nueva. */
  routine: ConfigRoutineView | null;
  /** Estado del interruptor de la página Rutinas (false si aún no tiene fila). */
  enabled: boolean;
  /** El que mira es el Mac; si no, un dispositivo vinculado (máximo nivel 2). */
  local: boolean;
  onDirty: (dirty: boolean) => void;
  /**
   * Tras guardar, crear, borrar o volver a la config. `goTo` = la rutina que hay que mostrar (null = la lista);
   * `taskId` = la tarea lanzada por «Probar ahora»; `error` = lo que falló después de crear la rutina.
   */
  onSaved: (goTo: string | null, after?: SavedNotice) => void;
}

export function RoutineForm({ full, routine, enabled, local, onDirty, onSaved }: Props) {
  const firstProfile = full.profiles[0]?.id ?? '';
  const base = routine ? formFromRoutine(routine, enabled) : emptyForm(firstProfile);
  const [f, setF] = useState<RoutineFormState>(base);
  const [projectId, setProjectId] = useState(routine?.projectId ?? full.projects[0]?.id ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  // Si la rutina cambia por fuera (SSE de config) y no habías tocado nada, el formulario se pone al día.
  const prevBase = useRef(base);
  useEffect(() => {
    if (!sameForm(prevBase.current, base)) {
      setF((cur) => (sameForm(cur, prevBase.current) ? base : cur));
      prevBase.current = base;
    }
  });

  const dirty = routine ? !sameForm(f, base) : !sameForm(f, emptyForm(firstProfile));
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const readonly = routine ? !routine.editable.ok : false;
  const reason = routine && !routine.editable.ok ? routine.editable.reason : null;
  const off = readonly || busy !== null;
  const overridden = new Set(routine?.origin === 'editada' ? routine.overridden : []);
  const contexts = full.contexts[projectId] ?? [];
  const contextOptions: (RoutineContext | null)[] = [null, ...contexts, ...(f.context && !contexts.includes(f.context) ? [f.context] : [])];
  const set = <K extends keyof RoutineFormState>(k: K, v: RoutineFormState[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const setSchedule = (s: Schedule) => set('schedule', s);
  const mark = (field: string) => overridden.has(field)
    ? <span className="tapado" title="Cambiado en el panel: tapa el valor de faro.config.ts">editado</span>
    : null;

  /** Guardar o «Probar ahora» (guarda si hay cambios y lanza). */
  const run = async (what: 'save' | 'try') => {
    const b = toBody(f);
    if (!b.ok) { setError(b.error); return; }
    setBusy(what); setError(null);
    let id = routine?.id ?? null;
    try {
      if (!routine) {
        id = (await api.createRoutineConfig({ ...b.body, projectId })).id;
        if (f.enabled) await api.toggleRoutine(id);
      } else if (dirty) {
        // `base.enabled` es el estado actual: así solo se compara lo que va en el PUT.
        if (!sameForm({ ...f, enabled }, base)) await api.saveRoutineConfig(routine.id, b.body);
        if (f.enabled !== enabled) await api.toggleRoutine(routine.id);
      }
      const task = what === 'try' ? await api.runRoutine(id!) : null;
      onDirty(false);
      onSaved(id, { taskId: task?.id });
    } catch (e) {
      const message = (e as Error).message;
      // La rutina nueva ya existe aunque falle lo de después (activarla, lanzarla): se pasa a ella para no duplicarla.
      if (!routine && id) { onDirty(false); onSaved(id, { error: message }); } else setError(message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!routine) return;
    const panel = routine.origin === 'panel';
    if (!confirm(panel ? `¿Borrar la rutina «${routine.name}»?` : `¿Descartar los cambios del panel y volver a la versión de faro.config.ts?`)) return;
    setBusy('delete'); setError(null);
    try {
      await api.deleteRoutineConfig(routine.id);
      onDirty(false);
      onSaved(panel ? null : routine.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const draft = async () => {
    if (!description.trim()) return;
    setDrafting(true); setDraftError(null);
    try {
      const d: RoutineDraft = await api.draftRoutine(projectId, description.trim());
      setF((cur) => ({
        ...cur, name: d.name, title: d.title, schedule: scheduleFromCron(d.cron), profileId: d.profileId, level: d.level,
        context: d.context, budget: fmtBudget(d.maxBudgetUsd), prompt: d.prompt,
      }));
    } catch (e) {
      setDraftError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  };

  const s = f.schedule;
  const cron = scheduleError(s) ? null : cronFromSchedule(s);
  const setTime = (v: string) => {
    const [h, m] = v.split(':').map(Number);
    if ('hour' in s && Number.isInteger(h) && Number.isInteger(m)) setSchedule({ ...s, hour: h, minute: m });
  };

  return (
    <form className="rform" onSubmit={(e) => { e.preventDefault(); void run('save'); }}>
      {!routine && (
        <div className="assistant">
          <label>Describe la rutina en una frase
            <div className="assistant-row">
              <input value={description} onChange={(e) => setDescription(e.target.value)} disabled={drafting} maxLength={2000}
                placeholder="Cada lunes, resume los bugs abiertos y propone por cuál empezar"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void draft(); } }} />
              <button type="button" className="btn" disabled={drafting || !description.trim()} onClick={() => void draft()}>
                {drafting ? 'Redactando…' : 'Redactar'}
              </button>
            </div>
          </label>
          {drafting && <span className="hint">Puede tardar hasta dos minutos. No se guarda nada hasta que pulses Guardar.</span>}
          {draftError && <p className="error" role="alert">{draftError}</p>}
        </div>
      )}

      {reason && <p className="notice" role="note">{reason}</p>}

      <fieldset className="rform-body" disabled={readonly}>
        {!routine && full.projects.length > 1 && (
          <label>Proyecto
            <select value={projectId} onChange={(e) => { setProjectId(e.target.value); if (f.context && !(full.contexts[e.target.value] ?? []).includes(f.context)) set('context', null); }}>
              {full.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <div className="r2">
          <label><span>Nombre {mark('name')}</span>
            <input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={200} required />
          </label>
          <label><span>Título de cada tarea {mark('title')}</span>
            <input value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={200} required />
            <span className="hint">Variables: <code>{'{fecha}'}</code> <code>{'{semana}'}</code></span>
          </label>
        </div>

        <div className="field">
          <span className="flabel">Cuándo {mark('cron')}</span>
          <div className="seg" role="radiogroup" aria-label="Cuándo">
            {KINDS.map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={s.kind === k} className={s.kind === k ? 'on' : ''}
                onClick={() => setSchedule(switchKind(s, k))}>{label}</button>
            ))}
          </div>
        </div>
        {s.kind === 'weekly' && (
          <div className="field">
            <span className="flabel">Días de la semana</span>
            <div className="days" role="group" aria-label="Días de la semana">
              {WEEK.map(([d, short]) => {
                const on = s.days.includes(d);
                return (
                  <button key={d} type="button" className={`opt${on ? ' on' : ''}`} aria-pressed={on} title={WEEK_NAME[d]}
                    onClick={() => setSchedule({ ...s, days: on ? s.days.filter((x) => x !== d) : [...s.days, d] })}>{short}</button>
                );
              })}
            </div>
          </div>
        )}
        {(s.kind === 'daily' || s.kind === 'weekly' || s.kind === 'monthly') && (
          <div className="r2">
            {s.kind === 'monthly' && (
              <label>Día del mes
                <input type="number" min={1} max={31} value={Number.isNaN(s.day) ? '' : s.day}
                  onChange={(e) => setSchedule({ ...s, day: e.target.value === '' ? NaN : Number(e.target.value) })} />
                {s.day > 28 && <span className="hint">Los meses sin ese día no se ejecuta.</span>}
              </label>
            )}
            <label>Hora
              <input type="time" value={hhmm(s)} onChange={(e) => setTime(e.target.value)} required />
            </label>
          </div>
        )}
        {s.kind === 'custom' && (
          <label>Cron
            <input value={s.cron} onChange={(e) => setSchedule({ kind: 'custom', cron: e.target.value })} className="mono" spellCheck={false} />
            <span className="hint">Cinco campos: minuto, hora, día del mes, mes y día de la semana.</span>
          </label>
        )}
        <span className="hint next">
          {scheduleError(s) ?? nextRunText(s)}
          {cron && <> · cron <code>{cron}</code></>}
          {cron && !f.enabled && ' · desactivada'}
        </span>

        <div className="field">
          <span className="flabel">Nivel de permisos {mark('level')}</span>
          <div className="seg" role="radiogroup" aria-label="Nivel de permisos">
            {LEVELS.map((l) => (
              <button key={l} type="button" role="radio" aria-checked={f.level === l} className={f.level === l ? 'on' : ''}
                disabled={!local && l > 2} onClick={() => set('level', l)}>{LEVEL_LABEL[l]}</button>
            ))}
          </div>
          {!local && <span className="hint">Desde un dispositivo vinculado solo se puede elegir hasta el nivel 2.</span>}
        </div>

        <div className="r2">
          <label><span>Perfil {mark('profileId')}</span>
            <select value={f.profileId} onChange={(e) => set('profileId', e.target.value)}>
              {!full.profiles.some((p) => p.id === f.profileId) && <option value={f.profileId}>{f.profileId}</option>}
              {full.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label><span>Tope de gasto por ejecución {mark('maxBudgetUsd')}</span>
            <div className="suffix">
              <input inputMode="decimal" value={f.budget} onChange={(e) => set('budget', e.target.value)} placeholder="El del perfil" />
              <span>$</span>
            </div>
          </label>
        </div>

        <div className="field">
          <span className="flabel">Contexto que añade Faro {mark('context')}</span>
          <div className="seg" role="radiogroup" aria-label="Contexto que añade Faro">
            {contextOptions.map((c) => (
              <button key={c ?? 'none'} type="button" role="radio" aria-checked={f.context === c} className={f.context === c ? 'on' : ''}
                onClick={() => set('context', c)}>{c ? CONTEXT_LABEL[c] : 'Ninguno'}</button>
            ))}
          </div>
        </div>

        <label className="check">
          <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Activada {!routine && <span className="hint">(si no, solo se lanza a mano)</span>}
        </label>

        <label><span>Instrucciones {mark('prompt')}</span>
          <textarea className="prompt" value={f.prompt} onChange={(e) => set('prompt', e.target.value)} rows={10} required />
        </label>
      </fieldset>

      {error && <p className="error" role="alert">{error}</p>}
      <div className="rform-bar">
        <span className="origin">
          {routine ? ORIGIN_TEXT[routine.origin] : 'Rutina nueva'}
          {overridden.size > 0 && ` · tapa: ${[...overridden].map((k) => FIELD_LABEL[k] ?? k).join(', ')}`}
        </span>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void run('try')}>
          {busy === 'try' ? 'Lanzando…' : 'Probar ahora'}
        </button>
        {routine?.origin === 'panel' && <button type="button" className="btn danger" disabled={off} onClick={() => void remove()}>Borrar</button>}
        {routine?.origin === 'editada' && <button type="button" className="btn" disabled={off} onClick={() => void remove()}>Volver a la config</button>}
        <button type="submit" className="btn primary" disabled={off || (!!routine && !dirty)}>{busy === 'save' ? 'Guardando…' : 'Guardar'}</button>
      </div>
    </form>
  );
}
