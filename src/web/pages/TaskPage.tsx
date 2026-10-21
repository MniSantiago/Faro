import { useCallback, useEffect, useRef, useState } from 'react';
import type { Artifact, EventRow, TaskStats } from '../../server/types';
import { api, artifactUrl, LEVEL_LABEL, mergeEvents, STATE_LABEL, subscribe, type TaskDetail } from '../api';
import { DiffView } from '../components/DiffView';
import { Composer } from '../components/Composer';
import { Conversation } from '../components/Conversation';
import { Markdown } from '../components/Markdown';
import { MediaArtifact } from '../components/MediaArtifact';
import { ReleasePanel } from '../components/ReleasePanel';
import { QuestionForm } from '../components/QuestionForm';
import { StatsLine } from '../components/StatsLine';
import { SubtaskCards } from '../components/SubtaskCards';
import { Thread } from '../components/Thread';
import { saveSeen } from '../chats';
import { buildConversation } from '../conversation';
import { buildThread } from '../thread';
import { projectOfTask, shouldSyncProject, useProject } from '../project';

/** Artefacto .md: se lee y se muestra con Markdown. */
function MdArtifact({ artifact }: { artifact: Artifact }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let on = true;
    api.artifactText(artifact.id).then((t) => { if (on) setText(t); }).catch(() => { if (on) setFailed(true); });
    return () => { on = false; };
  }, [artifact.id]);
  return (
    <details className="md-artifact" open>
      <summary><a href={artifactUrl(artifact.id)} target="_blank" rel="noreferrer">{artifact.label}</a></summary>
      {failed ? <p className="muted">No se pudo leer.</p>
        : text === null ? <p className="muted">Cargando…</p>
        : <div className="body md"><Markdown text={text} /></div>}
    </details>
  );
}

export function TaskPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [tab, setTab] = useState<'hilo' | 'resultado'>('hilo');
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Una tarea de otro proyecto cambia el proyecto actual al suyo (por el prefijo del id ya antes de cargarla), una vez
  // por tarea: si luego eliges otro en el selector, no se le lleva de vuelta (y el selector te saca a Inicio).
  const { projectId, projects, setProject } = useProject();
  const taskProject = detail?.task.projectId ?? projectOfTask(projects, id);
  const synced = useRef<string | null>(null);
  useEffect(() => {
    if (!taskProject) return;
    if (shouldSyncProject(synced.current, id, taskProject, projectId)) setProject(taskProject);
    synced.current = id;
  }, [id, taskProject, projectId, setProject]);

  const reqId = useRef(0);
  const alive = useRef(true);
  const eventsRef = useRef<EventRow[]>([]);
  eventsRef.current = events;

  const load = useCallback(() => {
    const n = ++reqId.current;
    return api.task(id).then((d) => {
      if (!alive.current || n !== reqId.current) return;
      setDetail(d);
      setStats(d.stats);
      setError(null);
    }).catch((e: Error) => { if (alive.current && n === reqId.current) setError(e.message); });
  }, [id]);

  useEffect(() => {
    alive.current = true;
    const refresh = () => {
      load();
      const after = eventsRef.current.reduce((mx, e) => Math.max(mx, e.id), 0);
      api.events(id, after).then((list) => { if (alive.current) setEvents((prev) => mergeEvents(prev, list)); }).catch(() => {});
    };
    const off = subscribe((m) => {
      if (m.type === 'event' && m.taskId === id) setEvents((prev) => mergeEvents(prev, [m.event]));
      if (m.type === 'task' && m.task.id === id) load();
      if (m.type === 'stats' && m.taskId === id) setStats(m.stats);
    }, refresh);
    refresh();
    return () => { alive.current = false; off(); };
  }, [id, load]);

  // Un chat abierto cuenta como leído (también cuando llega una respuesta con la página abierta).
  const chatToMark = detail?.task.kind === 'chat' ? detail.task : null;
  useEffect(() => { if (chatToMark) saveSeen(chatToMark); }, [chatToMark]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      const status = (r as { status?: string; message?: string; followUpTaskId?: string } | undefined);
      if (status?.status === 'failed') setError(status.message ?? 'No se pudo integrar');
      if (status?.status === 'pr') setError(`PR abierto: Faro lo fusiona por squash cuando pase el CI de GitHub.`);
      if (status?.status === 'conflict') {
        setError(status.followUpTaskId === id
          ? 'La rama base ha vuelto a cambiar: Faro la ha puesto otra vez en cola para resolver los conflictos nuevos.'
          : `Conflicto al integrar: Faro lo está resolviendo solo en ${status.followUpTaskId}.`);
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!detail) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">Cargando…</p>;
  const { task, artifacts, approvals, comments, jobs } = detail;
  const isChat = task.kind === 'chat';
  const threadItems = isChat ? buildThread(comments, events) : [];
  const convItems = isChat ? [] : buildConversation(comments, events, detail.runs);
  const lastAgent = comments.filter((c) => c.author === 'agent').at(-1);
  const summary = task.summary ?? lastAgent?.body ?? null;
  const diff = artifacts.find((a) => a.kind === 'diff');
  const checks = artifacts.filter((a) => a.kind === 'check');
  const jobLogs = new Set(jobs.map((j) => j.outputPath));
  const isMd = (a: Artifact) => a.kind === 'file' && /\.md$/i.test(a.path);
  const media = artifacts.filter((a) => (a.kind === 'image' || a.kind === 'video' || a.kind === 'file') && !jobLogs.has(a.path) && !isMd(a));
  const docs = artifacts.filter((a) => isMd(a) && !jobLogs.has(a.path));
  const pendingPush = approvals.some((a) => a.action === 'push' && a.state === 'pending');

  return (
    <div className="task">
      <a href={isChat ? '#/chats' : '#/bandeja'} className="back">{isChat ? '← Chats' : '← Bandeja'}</a>
      <header className="task-head">
        <h1><span className="id">{task.id}</span> {task.title}</h1>
        <p className="meta">
          <span className={`badge ${task.state}`}>{STATE_LABEL[task.state]}</span>
          <span>{isChat ? 'Chat con el Coordinador' : task.profileId}</span>
          {!isChat && <span>Nivel {LEVEL_LABEL[task.level]}</span>}
          {task.branch && <code>{task.branch}</code>}
          {task.parentId && <a href={`#/tarea/${task.parentId}`}>↑ {task.parentId}</a>}
        </p>
        {stats && <StatsLine stats={stats} />}
        <div className="actions">
          {task.state === 'review' && <button className="btn primary" disabled={busy} onClick={() => act(() => api.approve(id))}>Aprobar y mergear</button>}
          {task.state === 'draft' && <button className="btn primary" disabled={busy} onClick={() => act(() => api.queueDraft(id))}>Aprobar y encolar</button>}
          {task.state === 'done' && pendingPush && <button className="btn primary" disabled={busy} onClick={() => act(() => api.push(id))}>Hacer push</button>}
          {task.state === 'working' && <button className="btn danger" disabled={busy} onClick={() => act(() => api.stop(id))}>Parar</button>}
          {['draft', 'queued', 'blocked', 'review', 'pr', 'idle'].includes(task.state) &&
            <button className="btn danger" disabled={busy} onClick={() => act(() => api.discard(id))}>{isChat ? 'Archivar' : 'Descartar'}</button>}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </header>

      {!isChat && (
        <div className="tabs" role="tablist">
          <button role="tab" aria-controls="panel-hilo" aria-selected={tab === 'hilo'} onClick={() => setTab('hilo')}>Conversación</button>
          <button role="tab" aria-controls="panel-resultado" aria-selected={tab === 'resultado'} onClick={() => setTab('resultado')}>Resultado</button>
        </div>
      )}

      <div className={`task-layout${isChat ? ' solo' : ''}`}>
        <section className="pane" id="panel-hilo" role="tabpanel" data-active={tab === 'hilo'}>
          {task.description && <p className="desc">{task.description}</p>}
          {isChat ? <Thread items={threadItems} task={task} /> : <Conversation items={convItems} task={task} />}
          <SubtaskCards parentId={task.id} />
          {task.state === 'blocked' && task.questions && (
            <div className="callout"><h2>Necesita tu respuesta</h2><QuestionForm task={task} onDone={load} /></div>
          )}
          {task.state === 'blocked' && !task.questions && task.blockedReason && (
            <p className="callout reason-line">{task.blockedReason}</p>
          )}
          <Composer task={task} onSent={load} />
        </section>

        {!isChat && (
          <aside className="pane side" id="panel-resultado" role="tabpanel" data-active={tab === 'resultado'}>
            {task.state === 'blocked' && (
              <p className="notice tab-only"><button type="button" onClick={() => setTab('hilo')}>Necesita tu respuesta — ver conversación</button></p>
            )}
            {summary && <><h2>Resultado</h2><div className="result-summary body md"><Markdown text={summary} /></div></>}
            <ReleasePanel task={task} jobs={jobs} approvals={approvals} busy={busy} act={act} logArtifactId={(j) => artifacts.find((a) => a.path === j.outputPath)?.id} />
            {checks.length > 0 && (
              <>
                <h2>Comprobaciones</h2>
                <ul className="checks">
                  {checks.map((c) => (
                    <li key={c.id} className={c.label.endsWith('falla') ? 'fail' : /omitida|cancelada$/.test(c.label) ? 'skip' : 'ok'}>
                      <a href={artifactUrl(c.id)} target="_blank" rel="noreferrer">{c.label}</a>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(media.length > 0 || docs.length > 0) && (
              <>
                <h2>Artefactos</h2>
                {docs.map((d) => <MdArtifact key={d.id} artifact={d} />)}
                {media.length > 0 && <div className="media">
                  {media.map((m) => <MediaArtifact key={m.id} artifact={m} />)}
                </div>}
              </>
            )}
            {diff ? <><h2>{diff.label}</h2><DiffView artifactId={diff.id} /></> : <p className="muted">Aún no hay cambios.</p>}
          </aside>
        )}
      </div>
    </div>
  );
}
