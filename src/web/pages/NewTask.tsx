import { useEffect, useState, type FormEvent } from 'react';
import type { Level, Release } from '../../server/types';
import { api, LEVEL_LABEL, type ConfigView } from '../api';

export function NewTask() {
  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [projectId, setProjectId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [level, setLevel] = useState<Level>(2);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [release, setRelease] = useState<Release>('none');
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.config().then((c) => {
      setCfg(c);
      setProjectId(c.projects[0]?.id ?? '');
      const p = c.profiles.find((x) => x.id !== c.coordinatorProfile) ?? c.profiles[0];
      if (p) { setProfileId(p.id); setLevel(p.defaultLevel); }
    }).catch((e: Error) => setError(e.message));
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    // Desde un pendiente de «Plan»: el texto del pendiente es el título.
    const titulo = params.get('titulo');
    if (titulo) setTitle(titulo.slice(0, 200));
    const desde = params.get('desde');
    if (desde) {
      api.task(desde).then(({ task }) => {
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
      const t = await api.create({ projectId, profileId, level, title, description, draft, release: cfg?.projects.find((p) => p.id === projectId)?.release ? release : 'none' });
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
        {cfg.projects.length > 1 && (
          <label>Proyecto
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {cfg.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
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
      {cfg.projects.find((p) => p.id === projectId)?.release && (
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
      <button className="btn primary" disabled={busy || !title.trim()}>{draft ? 'Guardar borrador' : 'Crear y arrancar'}</button>
    </form>
  );
}
