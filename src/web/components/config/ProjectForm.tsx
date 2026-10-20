import { useEffect, useRef, useState } from 'react';
import type { ConfigFull, ConfigProjectView } from '../../../server/api-config';
import { api } from '../../api';
import { formFromProject, METRIC_IDS, projectSame, projectToBody, type ProjectFormState, type Tri } from '../../settings-form';
import { CopyButton } from './CopyButton';

const TRI: [Tri, string][] = [['default', 'Por defecto'], ['on', 'Sí'], ['off', 'No']];
const ID_LABEL: Record<typeof METRIC_IDS[number], string> = {
  revenuecatProjectId: 'RevenueCat: id del proyecto', posthogHost: 'PostHog: host', posthogProjectId: 'PostHog: id del proyecto',
  ascAppId: 'App Store Connect: id de la app', ascVendorNumber: 'App Store Connect: número de proveedor',
};
const SECRET_LABEL: Record<string, string> = {
  revenuecat: 'RevenueCat', posthog: 'PostHog', 'asc-key-id': 'ASC: key id', 'asc-issuer': 'ASC: issuer', 'asc-p8': 'ASC: clave .p8',
};
const FIELD_LABEL: Record<string, string> = {
  baseBranch: 'Rama base', github: 'GitHub', backlogFile: 'Archivo de backlog', contextWindow: 'Ventana de contexto', metrics: 'Métricas',
};
const ORIGIN_TEXT = { config: 'De faro.config.ts', editada: 'De faro.config.ts, editada en el panel', panel: 'Del panel' } as const;

interface Props {
  full: ConfigFull;
  project: ConfigProjectView;
  onDirty: (dirty: boolean) => void;
  onSaved: () => Promise<void>;
}

function Tri3({ label, value, onChange }: { label: string; value: Tri; onChange: (t: Tri) => void }) {
  return (
    <div className="field">
      <span className="flabel">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {TRI.map(([k, text]) => (
          <button key={k} type="button" role="radio" aria-checked={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{text}</button>
        ))}
      </div>
    </div>
  );
}

export function ProjectForm({ full, project, onDirty, onSaved }: Props) {
  const base = formFromProject(project);
  const [f, setF] = useState<ProjectFormState>(base);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prevBase = useRef(base);
  useEffect(() => {
    if (!projectSame(prevBase.current, base)) {
      setF((cur) => (projectSame(cur, prevBase.current) ? base : cur));
      prevBase.current = base;
    }
  });
  const dirty = !projectSame(f, base);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const readonly = !project.editable.ok;
  const reason = project.editable.ok ? null : project.editable.reason || 'Solo desde el Mac';
  const set = <K extends keyof ProjectFormState>(k: K, v: ProjectFormState[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const overridden = project.origin === 'editada' ? project.overridden : [];

  const save = async () => {
    const b = projectToBody(f);
    if (!b.ok) { setError(b.error); return; }
    setBusy(true); setError(null);
    try {
      await api.saveProjectConfig(project.id, b.body);
      onDirty(false);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ro = project.readonly;
  const secretNames = Object.keys(project.secrets);
  return (
    <div className="cdetail">
      <form className="rform" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {reason && <p className="notice" role="note">{reason}</p>}
        <fieldset className="rform-body" disabled={readonly}>
          <div className="r2">
            <label>Rama base
              <input value={f.baseBranch} onChange={(e) => set('baseBranch', e.target.value)} required spellCheck={false} />
            </label>
            <label>Ventana de contexto (tokens)
              <input inputMode="numeric" value={f.contextWindow} onChange={(e) => set('contextWindow', e.target.value)} placeholder="200000" />
            </label>
          </div>
          <label>Archivo de backlog
            <input value={f.backlogFile} onChange={(e) => set('backlogFile', e.target.value)} placeholder="Sin backlog" spellCheck={false} />
          </label>

          <h3 className="fgroup">GitHub</h3>
          <Tri3 label="Vigilar el CI" value={f.ci} onChange={(v) => set('ci', v)} />
          <Tri3 label="Integrar cada tarea por PR" value={f.prs} onChange={(v) => set('prs', v)} />
          <label>Perfil que arregla el CI
            <select value={f.ciProfile} onChange={(e) => set('ciProfile', e.target.value)}>
              <option value="">El primero con nivel 2 o más</option>
              {f.ciProfile && !full.profiles.some((p) => p.id === f.ciProfile) && <option value={f.ciProfile}>{f.ciProfile}</option>}
              {full.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>

          <h3 className="fgroup">Métricas</h3>
          <p className="hint muted">Solo identificadores, no secretos. Si dejas todo vacío, el proyecto no tiene métricas.</p>
          <div className="r2">
            {METRIC_IDS.map((k) => (
              <label key={k}>{ID_LABEL[k]}
                <input value={f.ids[k]} onChange={(e) => setF((cur) => ({ ...cur, ids: { ...cur.ids, [k]: e.target.value } }))} spellCheck={false} />
              </label>
            ))}
          </div>
          <label>Embudo de PostHog (JSON)
            <textarea className="mono funnel" value={f.funnel} onChange={(e) => set('funnel', e.target.value)} rows={8} spellCheck={false}
              placeholder='{"steps": [{"event": "app_open", "label": "Abre la app"}]}' />
          </label>
        </fieldset>

        {error && <p className="error" role="alert">{error}</p>}
        <div className="rform-bar">
          <span className="origin">
            {ORIGIN_TEXT[project.origin]}
            {overridden.length > 0 && ` · tapa: ${overridden.map((k) => FIELD_LABEL[k] ?? k).join(', ')}`}
          </span>
          <button type="submit" className="btn primary" disabled={readonly || busy || !dirty}>{busy ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>

      {secretNames.length > 0 && (
        <section className="rform" aria-label="Claves">
          <h3 className="fgroup">Claves</h3>
          <p className="hint muted">Faro nunca te pide claves por la web: ejecuta el comando en la Terminal del Mac y pega la clave cuando la pida.</p>
          <ul className="secrets">
            {secretNames.map((n) => {
              const ok = project.secrets[n];
              return (
                <li key={n}>
                  <span className={`pill ${ok ? 'g' : 'r'}`}>{ok ? 'Conectada' : 'Falta'}</span>
                  <strong>{SECRET_LABEL[n] ?? n}</strong>
                  {!ok && project.secretCommands[n] && <><code className="cmd">{project.secretCommands[n]}</code><CopyButton text={project.secretCommands[n]} /></>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="rform ro" aria-label="Solo lectura">
        <h3 className="fgroup">Solo lectura</h3>
        <p className="notice">Se edita en <code>faro.config.ts</code>.</p>
        <dl>
          <dt>Repositorio</dt><dd><code>{ro.repoPath}</code></dd>
          <dt>Worktrees</dt><dd><code>{ro.worktreesDir}</code></dd>
          <dt>Comprobaciones</dt>
          <dd>{ro.checks.length ? ro.checks.map((c) => (
            <div key={c.name}><strong>{c.name}</strong>: <code>{c.command}</code>{c.whenChanged && <span className="muted"> · si cambia {c.whenChanged}</span>}</div>
          )) : <span className="muted">Ninguna</span>}</dd>
          <dt>Preparación</dt>
          <dd>{ro.prepare.length ? ro.prepare.map((c) => <div key={c}><code>{c}</code></div>) : <span className="muted">Ninguna</span>}</dd>
          <dt>Excluidos</dt>
          <dd>{ro.exclude.length ? ro.exclude.map((c) => <div key={c}><code>{c}</code></div>) : <span className="muted">Ninguno</span>}</dd>
          <dt>Release</dt>
          <dd>{ro.release ? (
            <>
              <div>Carpeta: <code>{ro.release.cwd}</code></div>
              <div>Build: <code>{ro.release.build}</code></div>
              <div>Envío: <code>{ro.release.submit}</code></div>
              {ro.release.timeoutMinutes != null && <div className="muted">Tiempo máximo: {ro.release.timeoutMinutes} min</div>}
            </>
          ) : <span className="muted">Sin release</span>}</dd>
          <dt>Tiendas ASO</dt>
          <dd>{ro.asoStores.length ? ro.asoStores.map((s) => (
            <div key={s.id}><strong>{s.id}</strong> · {s.country} · <code>{s.fichaFile}</code></div>
          )) : <span className="muted">Ninguna</span>}</dd>
        </dl>
      </section>
    </div>
  );
}
