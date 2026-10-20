import { useEffect, useState } from 'react';
import { api, subscribe, type ConfigView, type HomeView } from '../api';
import { Sparkline } from '../components/Sparkline';
import { deltaTone, formatDelta, formatMetric, loadHomeProject, saveHomeProject } from '../home';
import type { HomeTile, HealthLine } from '../../server/home';

/** Proyectos y proyecto elegido en la home (recordado en el navegador; si ya no existe, el primero). */
export function useHomeProject(): { projects: ConfigView['projects']; project: string | null; setProject: (id: string) => void; loaded: boolean; error: string | null } {
  const [projects, setProjects] = useState<ConfigView['projects']>([]);
  const [project, setProjectState] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let ignore = false;
    api.config().then((c) => {
      if (ignore) return;
      setProjects(c.projects);
      setLoaded(true);
      const saved = loadHomeProject();
      setProjectState(c.projects.find((p) => p.id === saved)?.id ?? c.projects[0]?.id ?? null);
    }).catch((e: Error) => { if (!ignore) setError(e.message); });
    return () => { ignore = true; };
  }, []);
  const setProject = (id: string) => { saveHomeProject(id); setProjectState(id); };
  return { projects, project, setProject, loaded, error };
}

function Tile({ t }: { t: HomeTile }) {
  if (!t.configured) {
    return (
      <a className="tile off" href="#/metricas">
        <span className="tile-k">{t.label}</span>
        <span className="tile-v muted">Sin configurar</span>
        <span className="tile-d accent">Configurar en Métricas →</span>
      </a>
    );
  }
  const tone = deltaTone(t.deltaPct, t.upIsGood);
  const delta = formatDelta(t.deltaPct);
  return (
    <a className="tile" href={`#/inicio/${t.metric}`}>
      <span className="tile-go" aria-hidden="true">↗</span>
      <span className="tile-k">{t.label}</span>
      <span className="tile-v">{formatMetric(t.metric, t.value, t.format)}</span>
      {delta && <span className={`tile-d ${tone}`}>{delta} vs semana pasada</span>}
      <Sparkline values={t.spark} tone={tone} />
      {t.metric === 'gasto' && <span className="tile-note">equivalente API</span>}
    </a>
  );
}

const Dot = ({ tone }: { tone: HealthLine['tone'] }) => <span className={`hl-dot ${tone}`} aria-hidden="true" />;

export function Home() {
  const { projects, project, setProject, loaded, error: configError } = useHomeProject();
  const [view, setView] = useState<HomeView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    let ignore = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    // Si el plan (EAS, GitHub) tardó y la home salió sin él, se vuelve a pedir una vez a los 5 s, cuando ya estará en la caché.
    let retried = false;
    setView(null);
    const load = () => {
      timer = undefined;
      // Solo cuenta la respuesta de la última petición: una más lenta y antigua no pisa a la nueva.
      const n = ++seq;
      api.home(project)
        .then((v) => {
          if (ignore || n !== seq) return;
          setView(v);
          setError(null);
          if (v.pending && !retried) { retried = true; timer = setTimeout(load, 5000); }
        })
        .catch((e: Error) => { if (!ignore && n === seq) setError(e.message); });
    };
    // Cuando cambia una tarea cambian el titular, la semana y el gasto: como mucho una petición por segundo, aunque los
    // avisos no paren (con agentes trabajando llegan seguidos y un temporizador que se reinicia no llegaría a saltar).
    const loadSoon = () => { if (timer === undefined) timer = setTimeout(load, 1000); };
    // La carga inicial la hace `onOpen` (también si la conexión SSE ya estaba abierta) y se repite al reconectar.
    const off = subscribe((m) => { if (m.type === 'task') loadSoon(); }, load);
    return () => { ignore = true; off(); clearTimeout(timer); };
  }, [project]);

  const err = configError ?? error;
  if (err && !view) return <p className="error" role="alert">{err}</p>;
  if (!loaded) return <p className="muted">Cargando…</p>;
  if (!project) return <p className="muted">No hay proyectos en faro.config.ts.</p>;
  if (!view) return <p className="muted">Cargando…</p>;

  const { headline: h } = view;
  return (
    <div className="home">
      {projects.length > 1 && project && (
        <label className="home-project">
          <span className="muted">Proyecto</span>
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
      <section className="hero">
        <div className="hero-text">
          <h1>{h.text}</h1>
          {h.detail && <p>{h.detail}</p>}
        </div>
        {h.needCount > 0
          ? <a className="hero-go" href="#/bandeja">Ir a la bandeja →</a>
          : <a className="hero-link" href="#/bandeja">Bandeja</a>}
      </section>
      <div className="tiles">{view.tiles.map((t) => <Tile key={t.metric} t={t} />)}</div>
      <div className="home-two">
        <section className="card home-block">
          <h2>Salud del proyecto</h2>
          {view.health.length === 0 ? <p className="muted">Nada que vigilar todavía.</p> : (
            <ul>
              {view.health.map((l) => (
                <li key={l.id}><span className="hl-label"><Dot tone={l.tone} />{l.label}</span><span className="hl-detail" title={l.title}>{l.detail}</span></li>
              ))}
            </ul>
          )}
        </section>
        <section className="card home-block">
          <h2>Esta semana</h2>
          <ul>
            {view.week.map((l) => <li key={l.label}><span className="hl-label">{l.label}</span><span className="hl-detail">{l.value}</span></li>)}
          </ul>
        </section>
      </div>
    </div>
  );
}
