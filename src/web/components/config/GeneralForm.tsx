import { useEffect, useRef, useState } from 'react';
import type { ConfigFull } from '../../../server/api-config';
import { api } from '../../api';
import { formFromGeneral, generalSame, generalToBody, type GeneralFormState, type Tri } from '../../settings-form';

const FIELD_LABEL: Record<string, string> = { title: 'Título', maxConcurrentRuns: 'Ejecuciones simultáneas', coordinatorProfile: 'Perfil del coordinador', retryWatchdog: 'Reintentos' };
const ORIGIN_TEXT = { config: 'De faro.config.ts', editada: 'De faro.config.ts, editada en el panel', panel: 'Del panel' } as const;
const TRI: [Tri, string][] = [['default', 'Por defecto (activada)'], ['on', 'Activada'], ['off', 'Desactivada']];

interface Props { full: ConfigFull; onDirty: (dirty: boolean) => void; onSaved: () => Promise<void> }

export function GeneralForm({ full, onDirty, onSaved }: Props) {
  const g = full.general;
  const base = formFromGeneral(g);
  const [f, setF] = useState<GeneralFormState>(base);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prevBase = useRef(base);
  useEffect(() => {
    if (!generalSame(prevBase.current, base)) {
      setF((cur) => (generalSame(cur, prevBase.current) ? base : cur));
      prevBase.current = base;
    }
  });
  const dirty = !generalSame(f, base);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const readonly = !g.editable.ok;
  const reason = g.editable.ok ? null : g.editable.reason || 'Solo desde el Mac';
  const set = <K extends keyof GeneralFormState>(k: K, v: GeneralFormState[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const overridden = g.origin === 'editada' ? g.overridden : [];

  const save = async () => {
    const b = generalToBody(f);
    if (!b.ok) { setError(b.error); return; }
    setBusy(true); setError(null);
    try {
      await api.saveGeneralConfig(b.body);
      onDirty(false);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ro = g.readonly;
  return (
    <div className="cdetail">
      <form className="rform" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {reason && <p className="notice" role="note">{reason}</p>}
        <fieldset className="rform-body" disabled={readonly}>
          <label>Título del panel
            <input value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={80} placeholder="Faro" />
          </label>
          <div className="r2">
            <label>Ejecuciones simultáneas
              <input inputMode="numeric" value={f.maxConcurrent} onChange={(e) => set('maxConcurrent', e.target.value)} required />
            </label>
            <label>Perfil del coordinador
              <select value={f.coordinatorProfile} onChange={(e) => set('coordinatorProfile', e.target.value)}>
                {!full.profiles.some((p) => p.id === f.coordinatorProfile) && <option value={f.coordinatorProfile}>{f.coordinatorProfile}</option>}
                {full.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </div>

          <h3 className="fgroup">Reintentos ante límites de uso y sobrecarga</h3>
          <div className="field">
            <span className="flabel">Vigilancia</span>
            <div className="seg" role="radiogroup" aria-label="Vigilancia">
              {TRI.map(([k, text]) => (
                <button key={k} type="button" role="radio" aria-checked={f.enabled === k} className={f.enabled === k ? 'on' : ''} onClick={() => set('enabled', k)}>{text}</button>
              ))}
            </div>
          </div>
          <div className="r2">
            <label>Espera total máxima
              <div className="suffix"><input inputMode="decimal" value={f.maxWait} onChange={(e) => set('maxWait', e.target.value)} placeholder="5" /><span>min</span></div>
            </label>
            <label>Espera máxima por límite de uso
              <div className="suffix"><input inputMode="decimal" value={f.maxUsageWait} onChange={(e) => set('maxUsageWait', e.target.value)} placeholder="5" /><span>min</span></div>
            </label>
          </div>
        </fieldset>

        {error && <p className="error" role="alert">{error}</p>}
        <div className="rform-bar">
          <span className="origin">
            {ORIGIN_TEXT[g.origin]}
            {overridden.length > 0 && ` · tapa: ${overridden.map((k) => FIELD_LABEL[k] ?? k).join(', ')}`}
          </span>
          <button type="submit" className="btn primary" disabled={readonly || busy || !dirty}>{busy ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>

      <section className="rform ro" aria-label="Solo lectura">
        <h3 className="fgroup">Solo lectura</h3>
        <p className="notice">Se edita en <code>faro.config.ts</code>.</p>
        <dl>
          <dt>Host</dt><dd><code>{ro.host}</code></dd>
          <dt>Puerto</dt><dd><code>{ro.port}</code></dd>
          <dt>Datos</dt><dd><code>{ro.dataDir}</code></dd>
          <dt>Hosts permitidos</dt>
          <dd>{ro.allowedHosts.length ? ro.allowedHosts.map((h) => <div key={h}><code>{h}</code></div>) : <span className="muted">Solo local</span>}</dd>
          <dt>CLI de Claude</dt><dd>{ro.claudeVersion ? <code>{ro.claudeVersion}</code> : <span className="muted">No se detecta</span>}</dd>
        </dl>
      </section>
    </div>
  );
}
