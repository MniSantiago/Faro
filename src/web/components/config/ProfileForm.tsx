import { useEffect, useRef, useState } from 'react';
import type { ConfigProfileView } from '../../../server/api-config';
import { EFFORTS, type Level } from '../../../server/types';
import { api, LEVEL_LABEL } from '../../api';
import { emptyProfileForm, formFromProfile, profileSame, profileToBody, type ProfileFormState } from '../../profile-form';

const LEVELS: Level[] = [1, 2, 3, 4];
/** Sugerencias del campo «Modelo»; es texto libre. */
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const FIELD_LABEL: Record<string, string> = {
  name: 'Nombre', instructions: 'Instrucciones', model: 'Modelo', effort: 'Esfuerzo', maxBudgetUsd: 'Tope de gasto',
  defaultLevel: 'Nivel por defecto', timeoutMinutes: 'Tiempo máximo',
};
const ORIGIN_TEXT = { config: 'De faro.config.ts', editada: 'De faro.config.ts, editada en el panel', panel: 'Creado en el panel' } as const;

interface Props {
  /** null = perfil nuevo. */
  profile: ConfigProfileView | null;
  /** El que mira es el Mac; si no, un dispositivo vinculado (máximo nivel 2). */
  local: boolean;
  onDirty: (dirty: boolean) => void;
  /** Tras guardar, crear, borrar o volver a la config. `goTo` = el perfil que hay que mostrar (null = la lista). */
  onSaved: (goTo: string | null) => Promise<void>;
}

export function ProfileForm({ profile, local, onDirty, onSaved }: Props) {
  const base = profile ? formFromProfile(profile) : emptyProfileForm();
  const [f, setF] = useState<ProfileFormState>(base);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Si el perfil cambia por fuera (SSE de config) y no habías tocado nada, el formulario se pone al día.
  const prevBase = useRef(base);
  useEffect(() => {
    if (!profileSame(prevBase.current, base)) {
      setF((cur) => (profileSame(cur, prevBase.current) ? base : cur));
      prevBase.current = base;
    }
  });

  const dirty = !profileSame(f, base);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const readonly = profile ? !profile.editable.ok : false;
  const reason = profile && !profile.editable.ok ? profile.editable.reason : null;
  const off = readonly || busy !== null;
  const overridden = profile?.origin === 'editada' ? profile.overridden : [];
  const set = <K extends keyof ProfileFormState>(k: K, v: ProfileFormState[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const mark = (field: string) => overridden.includes(field)
    ? <span className="tapado" title="Cambiado en el panel: tapa el valor de faro.config.ts">editado</span>
    : null;

  const save = async () => {
    const b = profileToBody(f);
    if (!b.ok) { setError(b.error); return; }
    setBusy('save'); setError(null);
    try {
      const saved = profile ? await api.saveProfileConfig(profile.id, b.body) : await api.createProfileConfig(b.body);
      onDirty(false);
      await onSaved(saved.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const usedBy = profile?.usedBy ?? [];
  const remove = async () => {
    if (!profile) return;
    const panel = profile.origin === 'panel';
    if (!confirm(panel ? `¿Borrar el perfil «${profile.name}»?` : '¿Descartar los cambios del panel y volver a la versión de faro.config.ts?')) return;
    setBusy('delete'); setError(null);
    try {
      await api.deleteProfileConfig(profile.id);
      onDirty(false);
      await onSaved(panel ? null : profile.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <form className="rform" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {reason && <p className="notice" role="note">{reason}</p>}
      <fieldset className="rform-body" disabled={readonly}>
        <label><span>Nombre {mark('name')}</span>
          <input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={200} required />
        </label>

        <div className="field">
          <span className="flabel">Nivel por defecto {mark('defaultLevel')}</span>
          <div className="seg" role="radiogroup" aria-label="Nivel por defecto">
            {LEVELS.map((l) => (
              <button key={l} type="button" role="radio" aria-checked={f.level === l} className={f.level === l ? 'on' : ''}
                disabled={!local && l > 2} onClick={() => set('level', l)}>{LEVEL_LABEL[l]}</button>
            ))}
          </div>
          {!local && <span className="hint muted">Desde un dispositivo vinculado solo se puede elegir hasta el nivel 2.</span>}
        </div>

        <div className="r2">
          <label><span>Modelo {mark('model')}</span>
            <input value={f.model} list="profile-models" onChange={(e) => set('model', e.target.value)} placeholder="El de la CLI" spellCheck={false} />
            <datalist id="profile-models">{MODELS.map((m) => <option key={m} value={m} />)}</datalist>
          </label>
          <label><span>Esfuerzo {mark('effort')}</span>
            <select value={f.effort} onChange={(e) => set('effort', e.target.value as ProfileFormState['effort'])}>
              <option value="">El de la CLI</option>
              {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
        </div>

        <div className="r2">
          <label><span>Tope de gasto por ejecución {mark('maxBudgetUsd')}</span>
            <div className="suffix">
              <input inputMode="decimal" value={f.budget} onChange={(e) => set('budget', e.target.value)} placeholder="Sin tope" />
              <span>$</span>
            </div>
          </label>
          <label><span>Tiempo máximo {mark('timeoutMinutes')}</span>
            <div className="suffix">
              <input inputMode="decimal" value={f.timeout} onChange={(e) => set('timeout', e.target.value)} required />
              <span>min</span>
            </div>
          </label>
        </div>

        <label><span>Instrucciones {mark('instructions')}</span>
          <textarea className="prompt" value={f.instructions} onChange={(e) => set('instructions', e.target.value)} rows={10} required />
        </label>
      </fieldset>

      {profile && (
        <div className="field">
          <span className="flabel">Usado por</span>
          {usedBy.length
            ? <span className="used">{usedBy.map((r) => <a key={r} className="chip" href={`#/config/rutinas/${encodeURIComponent(r)}`}>{r}</a>)}</span>
            : <span className="hint muted">Ninguna rutina.</span>}
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      <div className="rform-bar">
        <span className="origin">
          {profile ? ORIGIN_TEXT[profile.origin] : 'Perfil nuevo'}
          {overridden.length > 0 && ` · tapa: ${overridden.map((k) => FIELD_LABEL[k] ?? k).join(', ')}`}
        </span>
        {profile?.origin === 'panel' && (
          <button type="button" className="btn danger" disabled={off || usedBy.length > 0}
            title={usedBy.length ? 'Lo usan rutinas: cámbialas de perfil antes' : undefined} onClick={() => void remove()}>Borrar</button>
        )}
        {profile?.origin === 'editada' && <button type="button" className="btn" disabled={off} onClick={() => void remove()}>Volver a la config</button>}
        <button type="submit" className="btn primary" disabled={off || (!!profile && !dirty)}>{busy === 'save' ? 'Guardando…' : 'Guardar'}</button>
      </div>
    </form>
  );
}
