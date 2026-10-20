import { useEffect, useRef, useState } from 'react';
import type { Spend, Task } from '../../server/types';
import { api, mergeTasks, subscribe } from '../api';
import { loadSeen, navSection, SEEN_EVENT, SEEN_KEY, seedSeenIfMissing, unreadChats, type NavSection } from '../chats';
import { formatUsd } from '../format';
import { inboxSections } from '../inbox';

const ACTIVE = new Set<Task['state']>(['working', 'queued']);

/** Tareas (para el contador de la bandeja y el punto de chats), gasto de hoy y chats vistos; comparte la conexión SSE. */
function useNavData() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [spend, setSpend] = useState<Spend | null>(null);
  const [seen, setSeen] = useState<Record<string, string>>(loadSeen);
  const states = useRef(new Map<string, Task['state']>());

  useEffect(() => {
    let ignore = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loadSpend = () => { api.stats().then((s) => { if (!ignore) setSpend(s.spend); }).catch(() => {}); };
    const loadSpendSoon = () => { clearTimeout(timer); timer = setTimeout(loadSpend, 1000); };
    const refresh = () => {
      api.tasks().then((list) => {
        if (ignore) return;
        seedSeenIfMissing(list);
        for (const t of list) states.current.set(t.id, t.state);
        setTasks((prev) => mergeTasks(prev, list));
      }).catch(() => {});
      loadSpend();
    };
    const off = subscribe((m) => {
      if (m.type !== 'task') return;
      const before = states.current.get(m.task.id);
      states.current.set(m.task.id, m.task.state);
      // Al terminar una ejecución cambia el gasto.
      if (before !== m.task.state && !ACTIVE.has(m.task.state)) loadSpendSoon();
      setTasks((prev) => mergeTasks(prev, [m.task]));
    }, refresh);
    refresh();
    const onSeen = () => setSeen(loadSeen());
    const onStorage = (e: StorageEvent) => { if (e.key === SEEN_KEY) onSeen(); };
    window.addEventListener(SEEN_EVENT, onSeen);
    window.addEventListener('storage', onStorage);
    return () => {
      ignore = true; off(); clearTimeout(timer);
      window.removeEventListener(SEEN_EVENT, onSeen);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return { tasks, spend, seen };
}

function Icon({ name }: { name: NavSection | 'mas' }) {
  const paths: Record<string, string> = {
    bandeja: 'M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4z',
    chats: 'M5 5h14v10H9l-4 4z',
    rutinas: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
    plan: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
    metricas: 'M5 19V11M12 19V5M19 19v-6',
    aso: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5L20 20M8 12l2-3 2 2 2-3',
    dispositivos: 'M7 3h10v18H7zM11 18h2',
    mas: 'M12 5v14M5 12h14',
  };
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  );
}

function PlusMenu({ route }: { route: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setOpen(false); }, [route]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="plus" ref={ref}>
      <button type="button" className="fab" aria-label="Crear" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="mas" />
      </button>
      {open && (
        <div className="plus-menu" role="menu">
          <a role="menuitem" href="#/nueva" onClick={() => setOpen(false)}>Nueva tarea</a>
          <a role="menuitem" href="#/chat/nuevo" onClick={() => setOpen(false)}>Nuevo chat</a>
        </div>
      )}
    </div>
  );
}

/** Navegación fija: barra lateral en pantallas anchas y barra inferior con «+» en el móvil (< 768 px). */
export function Nav({ route }: { route: string }) {
  const { tasks, spend, seen } = useNavData();
  const need = inboxSections(tasks, new Date()).need.length;
  const unread = unreadChats(tasks, seen).length > 0;
  const active = navSection(route, tasks);
  const cur = (s: NavSection) => (active === s ? 'page' as const : undefined);
  const dot = unread ? <span className="dot" aria-label="mensajes sin leer" /> : null;
  const badge = need > 0 ? <span className="nav-count" aria-label={`${need} te necesitan`}>{need}</span> : null;

  return (
    <>
      <nav className="sidebar" aria-label="Navegación">
        <a href="#/" className="brand">Faro</a>
        <a href="#/" aria-current={cur('bandeja')}><Icon name="bandeja" /><span className="label">Bandeja</span>{badge}</a>
        <a href="#/chats" aria-current={cur('chats')}><Icon name="chats" /><span className="label">Chats</span>{dot}</a>
        <a href="#/plan" aria-current={cur('plan')}><Icon name="plan" /><span className="label">Plan</span></a>
        <a href="#/rutinas" aria-current={cur('rutinas')}><Icon name="rutinas" /><span className="label">Rutinas</span></a>
        <a href="#/metricas" aria-current={cur('metricas')}><Icon name="metricas" /><span className="label">Métricas</span></a>
        <a href="#/aso" aria-current={cur('aso')}><Icon name="aso" /><span className="label">ASO</span></a>
        <a href="#/dispositivos" aria-current={cur('dispositivos')}><Icon name="dispositivos" /><span className="label">Dispositivos</span></a>
        <div className="side-actions">
          <a href="#/nueva" className="btn primary">Nueva tarea</a>
          <a href="#/chat/nuevo" className="btn">Nuevo chat</a>
        </div>
        {spend && <p className="side-spend">Hoy {formatUsd(spend.today)}<span className="note">equivalente API; tu plan no lo cobra</span></p>}
      </nav>
      <nav className="tabbar" aria-label="Navegación">
        <a href="#/" aria-current={cur('bandeja')}><span className="ico-wrap"><Icon name="bandeja" />{badge}</span>Bandeja</a>
        <a href="#/chats" aria-current={cur('chats')}><span className="ico-wrap"><Icon name="chats" />{dot}</span>Chats</a>
        <a href="#/plan" aria-current={cur('plan')}><span className="ico-wrap"><Icon name="plan" /></span>Plan</a>
        <PlusMenu route={route} />
        <a href="#/rutinas" aria-current={cur('rutinas')}><span className="ico-wrap"><Icon name="rutinas" /></span>Rutinas</a>
        <a href="#/metricas" aria-current={cur('metricas')}><span className="ico-wrap"><Icon name="metricas" /></span>Métricas</a>
      </nav>
    </>
  );
}
