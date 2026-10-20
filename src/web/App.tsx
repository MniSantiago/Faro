import { useEffect, useState } from 'react';
import type { QueueState } from '../server/types';
import { api, authState, subscribe } from './api';
import { Nav } from './components/Nav';
import { QueueBanner } from './components/QueueBanner';
import { Aso } from './pages/Aso';
import { Chats } from './pages/Chats';
import { Devices } from './pages/Devices';
import { Config } from './pages/Config';
import { History } from './pages/History';
import { Home } from './pages/Home';
import { Inbox } from './pages/Inbox';
import { Metrics } from './pages/Metrics';
import { Login } from './pages/Login';
import { NewChat } from './pages/NewChat';
import { NewTask } from './pages/NewTask';
import { Routines } from './pages/Routines';
import { Plan } from './pages/Plan';
import { TaskPage } from './pages/TaskPage';

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
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);

  // Al cambiar de página, arriba del todo (si no, se conserva el desplazamiento de la anterior).
  useEffect(() => { window.scrollTo(0, 0); }, [route]);

  useEffect(() => {
    const refresh = () => { api.queue().then(setQueue).catch(() => {}); };
    return subscribe((m) => { if (m.type === 'queue') setQueue(m.queue); }, refresh);
  }, []);

  return (
    <div className="app">
      <Nav route={route} />
      <div className="main-col">
        {queue?.paused && <QueueBanner queue={queue} error={resumeError} onResume={() => { setResumeError(null); api.resumeQueue().then(setQueue).catch((e: Error) => setResumeError(e.message)); }} />}
        <main className="content">
          {route.startsWith('/tarea/') ? <TaskPage key={route.slice('/tarea/'.length)} id={route.slice('/tarea/'.length)} />
            : route.split('?')[0] === '/nueva' ? <NewTask />
            : route === '/rutinas' ? <Routines />
            : route === '/plan' ? <Plan />
            : route === '/metricas' ? <Metrics />
            : route === '/aso' ? <Aso />
            : route === '/dispositivos' ? <Devices />
            : route === '/chat/nuevo' ? <NewChat />
            : route === '/chats' ? <Chats />
            : route === '/historial' ? <History />
            : route === '/bandeja' ? <Inbox />
            : route === '/config' || route.startsWith('/config/') ? <Config />
            : <Home />}
        </main>
      </div>
    </div>
  );
}
