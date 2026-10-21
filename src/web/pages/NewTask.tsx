import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Level, Release } from '../../server/types';
import { api, LEVEL_LABEL } from '../api';
import { currentProjectId as projectIdNow, setProject, shouldSyncProject, useCurrentProject, useProjectState } from '../project';

export function NewTask() {
  const { config: cfg } = useProjectState();
  const project = useCurrentProject();
  // Multi-repo: en qué repos trabaja (todos por defecto, al menos uno).
  const [repos, setRepos] = useState<string[]>(() => project?.repos.map((r) => r.id) ?? []);
  const [profileId, setProfileId] = useState('');
  const [level, setLevel] = useState<Level>(2);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [release, setRelease] = useState<Release>('none');
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // `desde` ya llevado a su proyecto (si luego eliges otro en el selector, te saca a Inicio).
  const syncedDesde = useRef<string | null>(null);

  useEffect(() => {
    if (cfg) {
      const p = cfg.profiles.find((x) => x.id !== cfg.coordinatorProfile) ?? cfg.profiles[0];
      if (p) { setProfileId(p.id); setLevel(p.defaultLevel); }
    }
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    // Desde un pendiente de «Plan»: el texto del pendiente es el título.
    const titulo = params.get('titulo');
    if (titulo) setTitle(titulo.slice(0, 200));
    const desde = params.get('desde');
    if (desde) {
      api.task(desde).then(({ task }) => {
        // El seguimiento es del proyecto de la original (una vez por original: después manda el selector).
        if (shouldSyncProject(syncedDesde.current, desde, task.projectId, projectIdNow())) setProject(task.projectId);
        syncedDesde.current = desde;
        setTitle(`Seguimiento de ${task.id}: ${task.title}`.slice(0, 200));
        setDescription(`A partir de ${task.id} «${task.title}»${task.summary ? `\n\nResumen de la original: ${task.summary}` : ''}\n\n`);
      }).catch(() => {});
    }
  }, []);

  const pickProfile = (id: string) => {
    setProfileId(id);
    const p = cfg?.profiles.find((x) => x.id === id);
    if (p) setLevel(p.defaultLevel);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!project) throw new Error('No hay proyecto');
      const t = await api.create({
        projectId: project.id, profileId, level, title, description, draft, release: project.release ? release : 'none',
        ...(project.multiRepo ? { repos } : {}),
      });
      location.hash = `/tarea/${t.id}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (!cfg) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">Cargando…</p>;

  return (
    <form className="form" onSubmit={submit}>
      <h1>Nueva tarea</h1>
      <label>Título<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} autoFocus /></label>
      <label>Descripción<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={8} /></label>
      <div className="row">
        <label>Perfil
          <select value={profileId} onChange={(e) => pickProfile(e.target.value)}>
            {cfg.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>Nivel
          <select value={level} onChange={(e) => setLevel(Number(e.target.value) as Level)}>
            {([1, 2, 3, 4] as Level[]).map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
          </select>
        </label>
      </div>
      {project?.multiRepo && (
        <fieldset className="repos">
          <legend>Repos</legend>
          {project.repos.map((r) => (
            <label key={r.id} className="check">
              <input type="checkbox" checked={repos.includes(r.id)}
                onChange={(e) => setRepos((cur) => (e.target.checked ? project.repos.map((x) => x.id).filter((id) => id === r.id || cur.includes(id)) : cur.filter((id) => id !== r.id)))} />
              {r.name}
            </label>
          ))}
          {repos.length === 0 && <p className="error">Elige al menos un repo.</p>}
        </fieldset>
      )}
      {project?.release && (
        <label>Al integrar
          <select value={release} onChange={(e) => setRelease(e.target.value as Release)}>
            <option value="none">Nada</option>
            <option value="build">Build EAS</option>
            <option value="build_submit">Build EAS + enviar a App Store</option>
          </select>
        </label>
      )}
      <label className="check"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Guardar como borrador (no arranca hasta que la apruebes)</label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy || !title.trim() || (project?.multiRepo === true && repos.length === 0)}>{draft ? 'Guardar borrador' : 'Crear y arrancar'}</button>
    </form>
  );
}
