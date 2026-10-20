import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfigFull, ConfigProfileView, ConfigProjectView, ConfigRoutineView } from '../../server/api-config';
import { api, authState, subscribe, type RoutineView } from '../api';
import { GeneralForm } from '../components/config/GeneralForm';
import { ProfileForm } from '../components/config/ProfileForm';
import { ProjectForm } from '../components/config/ProjectForm';
import { RoutineForm, type SavedNotice } from '../components/config/RoutineForm';
import { describeCron } from '../cron';

const TABS = [['rutinas', 'Rutinas'], ['perfiles', 'Perfiles'], ['proyecto', 'Proyecto'], ['generales', 'Generales']] as const;
type Tab = typeof TABS[number][0];
/** Elemento de la ruta para una rutina nueva (los ids son slugs: nunca llevan «+»). */
const NEW_ID = '+nueva';
/** Igual, para un perfil nuevo. */
const NEW_PROFILE = '+nuevo';
const CHANGES_LOST = 'Hay cambios sin guardar. ¿Descartarlos?';

/** `#/config/<pestaña>/<id>` → pestaña (por defecto Rutinas) e id del elemento. */
function parseRoute(route: string): { tab: Tab; id: string | null } {
  const [, , tab, ...rest] = route.split('?')[0].split('/');
  const t = TABS.find(([k]) => k === tab)?.[0] ?? 'rutinas';
  const id = rest.length ? decodeURIComponent(rest.join('/')) : null;
  return { tab: t, id: id || null };
}

export function Config({ route }: { route: string }) {
  const { tab, id } = parseRoute(route);
  const [full, setFull] = useState<ConfigFull | null>(null);
  const [rows, setRows] = useState<RoutineView[]>([]);
  const [local, setLocal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  const onDirty = useCallback((d: boolean) => { dirty.current = d; }, []);

  // «Activada» es el interruptor de la página Rutinas (estado del programador, no de la config).
  const loadRows = useCallback(() => api.routines().then(setRows).catch(() => {}), []);
  /** Recarga la config y los interruptores; nunca falla (el error queda en pantalla). */
  const load = useCallback(async () => {
    await Promise.all([
      api.configFull().then((c) => { setFull(c); setError(null); }).catch((e: Error) => setError(e.message)),
      loadRows(),
    ]);
  }, [loadRows]);
  useEffect(() => { authState().then((s) => setLocal(s.local)).catch(() => {}); }, []);
  useEffect(() => subscribe((m) => {
    if (m.type === 'config') void load();
    else if (m.type === 'task' && m.task.routineId) void loadRows();
  }, () => void load()), [load, loadRows]);
  useEffect(() => { void load(); }, [load]);

  // Al cerrar o recargar la página con cambios sin guardar, el navegador avisa.
  useEffect(() => {
    const f = (e: BeforeUnloadEvent) => { if (dirty.current) e.preventDefault(); };
    addEventListener('beforeunload', f);
    return () => removeEventListener('beforeunload', f);
  }, []);

  const go = (hash: string) => {
    if (location.hash === hash) return;
    if (dirty.current && !confirm(CHANGES_LOST)) return;
    dirty.current = false;
    location.hash = hash;
  };

  return (
    <div className="config">
      <h1 className="page-head">Configuración</h1>
      <div className="ctabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''}
            onClick={() => go(`#/config/${k}`)}>{label}</button>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {!full ? (!error && <p className="muted">Cargando…</p>)
        : tab === 'rutinas' ? <RoutinesTab full={full} rows={rows} id={id} local={local} go={go} onDirty={onDirty} reload={load} />
        : tab === 'perfiles' ? <ProfilesTab full={full} id={id} local={local} go={go} onDirty={onDirty} reload={load} />
        : tab === 'proyecto' ? <ProjectTab full={full} id={id} go={go} onDirty={onDirty} reload={load} />
        : <GeneralTab full={full} onDirty={onDirty} reload={load} />}
    </div>
  );
}

/** Solo en el móvil (< 768 px): con un elemento elegido se ve únicamente su formulario, con este enlace para volver a la lista. */
const Back = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" className="link cback" onClick={onClick}>← {label}</button>
);

interface TabProps {
  full: ConfigFull; rows: RoutineView[]; id: string | null; local: boolean;
  go: (hash: string) => void; onDirty: (d: boolean) => void; reload: () => Promise<void>;
}
type SimpleTabProps = Omit<TabProps, 'rows' | 'local'>;

function RoutinesTab({ full, rows, id, local, go, onDirty, reload }: TabProps) {
  // Se incrementa tras cada guardado: el formulario se monta de nuevo desde la rutina guardada.
  const [version, setVersion] = useState(0);
  // Aviso tras guardar (tarea lanzada o lo que falló después de crear), para la rutina en la que se dio.
  const [notice, setNotice] = useState<SavedNotice & { routineId: string } | null>(null);
  const enabledOf = (rid: string) => rows.find((r) => r.id === rid)?.enabled ?? false;
  const profileName = (pid: string) => full.profiles.find((p) => p.id === pid)?.name ?? pid;
  const projectName = (pid: string) => full.projects.find((p) => p.id === pid)?.name ?? pid;
  const many = full.projects.length > 1;
  const creating = id === NEW_ID;
  // Sin id en la ruta, la primera rutina.
  const selected: ConfigRoutineView | null = creating ? null : full.routines.find((r) => r.id === id) ?? (id ? null : full.routines[0] ?? null);
  const ignored = full.ignored.filter((i) => i.kind === 'routine');

  // Se espera a tener la config nueva antes de cambiar de formulario: así no asoman los valores viejos
  // ni «la rutina no existe» con una recién creada.
  const onSaved = async (goTo: string | null, after?: SavedNotice) => {
    await reload();
    setVersion((v) => v + 1);
    setNotice(goTo && (after?.taskId || after?.error) ? { routineId: goTo, ...after } : null);
    const hash = goTo ? `#/config/rutinas/${encodeURIComponent(goTo)}` : '#/config/rutinas';
    if (location.hash !== hash) location.hash = hash;
  };

  return (
    <>
      {ignored.length > 0 && (
        <div className="notice config-ignored" role="note">
          {ignored.map((i) => <p key={i.id}>No se aplica el cambio del panel en la rutina <code>{i.id}</code>: {i.reason}</p>)}
        </div>
      )}
      <div className={`config-grid${id ? ' has-sel' : ''}`}>
        <Back label="Rutinas" onClick={() => go('#/config/rutinas')} />
        <div className="clist">
          {full.routines.map((r) => {
            const on = enabledOf(r.id);
            const current = selected?.id === r.id;
            return (
              <button key={r.id} type="button" className={`cli${current ? ' on' : ''}`} aria-current={current || undefined}
                onClick={() => go(`#/config/rutinas/${encodeURIComponent(r.id)}`)}>
                <span className="cli-main">
                  {r.name}
                  <small>
                    {describeCron(r.cron ?? null)}{!on && ' · desactivada'} · {profileName(r.profileId)} · N{r.level}
                    {many && ` · ${projectName(r.projectId)}`}
                  </small>
                </span>
                <span className={`tag${r.origin === 'config' ? '' : ' p'}${on ? '' : ' off'}`}>{r.origin}</span>
              </button>
            );
          })}
          {full.routines.length === 0 && <p className="muted cli-empty">No hay rutinas todavía.</p>}
          <button type="button" className={`cli new${creating ? ' on' : ''}`} onClick={() => go(`#/config/rutinas/${NEW_ID}`)}>+ Nueva rutina</button>
        </div>
        <div className="cdetail">
          {notice && selected?.id === notice.routineId && (notice.error
            ? <p className="error" role="alert">Rutina creada, pero: {notice.error}</p>
            : <p className="notice">Lanzada: <a href={`#/tarea/${notice.taskId}`}>{notice.taskId}</a></p>)}
          {creating || selected ? (
            <RoutineForm key={`${selected?.id ?? NEW_ID}:${version}`} full={full} routine={selected}
              enabled={selected ? enabledOf(selected.id) : false} local={local} onDirty={onDirty} onSaved={onSaved} />
          ) : id ? (
            <p className="muted">La rutina <code>{id}</code> no existe.</p>
          ) : null}
        </div>
      </div>
    </>
  );
}

function ProfilesTab({ full, id, local, go, onDirty, reload }: Omit<TabProps, 'rows'>) {
  const [version, setVersion] = useState(0);
  const creating = id === NEW_PROFILE;
  const selected: ConfigProfileView | null = creating ? null : full.profiles.find((p) => p.id === id) ?? (id ? null : full.profiles[0] ?? null);
  const ignored = full.ignored.filter((i) => i.kind === 'profile');

  // Como en Rutinas: se espera a tener la config nueva antes de cambiar de formulario.
  const onSaved = async (goTo: string | null) => {
    await reload();
    setVersion((v) => v + 1);
    const hash = goTo ? `#/config/perfiles/${encodeURIComponent(goTo)}` : '#/config/perfiles';
    if (location.hash !== hash) location.hash = hash;
  };

  return (
    <>
      {ignored.length > 0 && (
        <div className="notice config-ignored" role="note">
          {ignored.map((i) => <p key={i.id}>No se aplica el cambio del panel en el perfil <code>{i.id}</code>: {i.reason}</p>)}
        </div>
      )}
      <div className={`config-grid${id ? ' has-sel' : ''}`}>
        <Back label="Perfiles" onClick={() => go('#/config/perfiles')} />
        <div className="clist">
          {full.profiles.map((p) => {
            const current = selected?.id === p.id;
            return (
              <button key={p.id} type="button" className={`cli${current ? ' on' : ''}`} aria-current={current || undefined}
                onClick={() => go(`#/config/perfiles/${encodeURIComponent(p.id)}`)}>
                <span className="cli-main">
                  {p.name}
                  <small>N{p.defaultLevel}{p.model ? ` · ${p.model}` : ''}{p.usedBy.length ? ` · ${p.usedBy.length} ${p.usedBy.length > 1 ? 'rutinas' : 'rutina'}` : ''}</small>
                </span>
                <span className={`tag${p.origin === 'config' ? '' : ' p'}`}>{p.origin}</span>
              </button>
            );
          })}
          <button type="button" className={`cli new${creating ? ' on' : ''}`} onClick={() => go(`#/config/perfiles/${NEW_PROFILE}`)}>+ Nuevo perfil</button>
        </div>
        <div className="cdetail">
          {creating || selected ? (
            <ProfileForm key={`${selected?.id ?? NEW_PROFILE}:${version}`} profile={selected} local={local} onDirty={onDirty} onSaved={onSaved} />
          ) : id ? (
            <p className="muted">El perfil <code>{id}</code> no existe.</p>
          ) : null}
        </div>
      </div>
    </>
  );
}

function ProjectTab({ full, id, go, onDirty, reload }: SimpleTabProps) {
  const [version, setVersion] = useState(0);
  const selected: ConfigProjectView | null = full.projects.find((p) => p.id === id) ?? (id ? null : full.projects[0] ?? null);
  const onSaved = async () => { await reload(); setVersion((v) => v + 1); };
  const form = selected
    ? <ProjectForm key={`${selected.id}:${version}`} full={full} project={selected} onDirty={onDirty} onSaved={onSaved} />
    : id ? <p className="muted">El proyecto <code>{id}</code> no existe.</p> : <p className="muted">No hay proyectos en la config.</p>;
  if (full.projects.length < 2) return form;
  return (
    <div className={`config-grid${id ? ' has-sel' : ''}`}>
      <Back label="Proyectos" onClick={() => go('#/config/proyecto')} />
      <div className="clist">
        {full.projects.map((p) => {
          const current = selected?.id === p.id;
          return (
            <button key={p.id} type="button" className={`cli${current ? ' on' : ''}`} aria-current={current || undefined}
              onClick={() => go(`#/config/proyecto/${encodeURIComponent(p.id)}`)}>
              <span className="cli-main">{p.name}<small>{p.baseBranch}</small></span>
              <span className={`tag${p.origin === 'config' ? '' : ' p'}`}>{p.origin}</span>
            </button>
          );
        })}
      </div>
      {form}
    </div>
  );
}

function GeneralTab({ full, onDirty, reload }: Pick<SimpleTabProps, 'full' | 'onDirty' | 'reload'>) {
  const [version, setVersion] = useState(0);
  const onSaved = async () => { await reload(); setVersion((v) => v + 1); };
  return <GeneralForm key={version} full={full} onDirty={onDirty} onSaved={onSaved} />;
}
