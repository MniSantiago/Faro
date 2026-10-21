import { useEffect, useState } from 'react';
import type { HomeMetric } from '../server/home';
import type { QueueState } from '../server/types';
import { api, authState, subscribe } from './api';
import { Nav } from './components/Nav';
import { QueueBanner } from './components/QueueBanner';
import { Aso } from './pages/Aso';
import { Chats } from './pages/Chats';
import { Devices } from './pages/Devices';
import { Config } from './pages/Config';
import { History } from './pages/History';
import { HOME_METRICS } from './home';
import { Home } from './pages/Home';
import { HomeDetail } from './pages/HomeDetail';
import { Inbox } from './pages/Inbox';
import { Metrics } from './pages/Metrics';
import { Login } from './pages/Login';
import { NewChat } from './pages/NewChat';
import { NewTask } from './pages/NewTask';
import { Routines } from './pages/Routines';
import { Plan } from './pages/Plan';
import { TaskPage } from './pages/TaskPage';
import { retryConfig, useProjectState } from './project';

/** Cifra de `#/inicio/<cifra>`, o null si la ruta no es un detalle conocido (entonces se pinta la home). */
const detailMetric = (route: string): HomeMetric | null => {
  const m = route.startsWith('/inicio/') ? route.slice('/inicio/'.length) : '';
  return (HOME_METRICS as string[]).includes(m) ? (m as HomeMetric) : null;
};

function useRoute(): string {
  const [route, setRoute] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const f = () => setRoute(location.hash.slice(1) || '/');
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return route;
}

export function App() {
  const [auth, setAuth] = useState<'loading' | 'ok' | 'login'>('loading');
  useEffect(() => {
    const onLogin = () => setAuth('login');
    window.addEventListener('faro:login', onLogin);
    authState().then((s) => setAuth(!s.local && !s.device ? 'login' : 'ok')).catch(() => setAuth('ok'));
    return () => window.removeEventListener('faro:login', onLogin);
  }, []);
  if (auth === 'loading') return <p className="muted">Cargando…</p>;
  if (auth === 'login') return <Login />;
  return <Shell />;
}

function Shell() {
  const route = useRoute();
  // Sin la query del hash (`?p=`, `?titulo=`…): es lo que decide la página.
  const path = route.split('?')[0];
  const { config, projectId, error } = useProjectState();
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);

  // Al cambiar de página, arriba del todo (si no, se conserva el desplazamiento de la anterior).
  useEffect(() => { window.scrollTo(0, 0); }, [path]);

  useEffect(() => {
    const refresh = () => { api.queue().then(setQueue).catch(() => {}); };
    return subscribe((m) => { if (m.type === 'queue') setQueue(m.queue); }, refresh);
  }, []);

  return (
    <div className="app">
      <Nav route={path} />
      <div className="main-col">
        {queue?.paused && <QueueBanner queue={queue} error={resumeError} onResume={() => { setResumeError(null); api.resumeQueue().then(setQueue).catch((e: Error) => setResumeError(e.message)); }} />}
        {/* Al cambiar de proyecto la página se monta de nuevo: vuelve a pedir sus datos, ya del proyecto nuevo. */}
        <main className="content" key={projectId ?? ''}>
          {!config ? (error
            ? <p className="error" role="alert">{error} <button className="btn" onClick={retryConfig}>Reintentar</button></p>
            : <p className="muted">Cargando…</p>)
            : path.startsWith('/tarea/') ? <TaskPage key={path.slice('/tarea/'.length)} id={path.slice('/tarea/'.length)} />
            : path === '/nueva' ? <NewTask />
            : path === '/rutinas' ? <Routines />
            : path === '/plan' ? <Plan />
            : path === '/metricas' ? <Metrics />
            : path === '/aso' ? <Aso />
            : path === '/dispositivos' ? <Devices />
            : path === '/chat/nuevo' ? <NewChat />
            : path === '/chats' ? <Chats />
            : path === '/historial' ? <History />
            : path === '/bandeja' ? <Inbox />
            : path === '/config' || path.startsWith('/config/') ? <Config route={path} />
            : detailMetric(path) ? <HomeDetail key={path} metric={detailMetric(path)!} />
            : <Home />}
        </main>
      </div>
    </div>
  );
}
