import type { BacklogItem } from '../server/backlog';
import type { Card } from '../server/metrics/summary';
import type { Snapshot, SourceId } from '../server/metrics/types';
import type { KeywordRow } from './aso';
import type { PlanState } from '../server/plan';
import type { Approval, Artifact, BusMessage, Comment, Device, EventRow, Job, Level, QueueState, Release, Run, Spend, Task, TaskStats } from '../server/types';

export type { BacklogItem, PlanState };

export interface ConfigView {
  projects: { id: string; name: string; prefix: string; release: boolean; metrics: boolean; aso: boolean }[];
  profiles: { id: string; name: string; defaultLevel: Level }[];
}

export interface TaskDetail {
  task: Task;
  runs: Run[];
  artifacts: Artifact[];
  approvals: Approval[];
  comments: Comment[];
  jobs: Job[];
  stats: TaskStats;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    // x-faro: el servidor rechaza los POST sin ella (protección CSRF del API local).
    headers: body === undefined ? { 'x-faro': '1' } : { 'x-faro': '1', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) window.dispatchEvent(new Event('faro:login'));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as T;
}

export interface RoutineView {
  id: string; projectId: string; cron: string | null; enabled: boolean; lastRunAt: string | null; nextRunAt: string | null;
  lastSkipReason: string | null; name: string; profileId: string; level: Level; draft: boolean; recent: Task[];
}

export interface MetricsSourceStatus {
  source: SourceId; label: string; configured: boolean | null; last: Snapshot | null; lastOk: Snapshot | null;
}
export interface MetricsView { status: MetricsSourceStatus[]; cards: Card[]; keychain: Record<string, string> }

export interface AsoFicha {
  name: string | null; subtitle: string | null; keywords: string | null;
  sources: { name: 'tienda' | 'repo' | null; subtitle: 'tienda' | 'repo' | null; keywords: 'repo' | null };
}
export interface AsoProposalView {
  id: number; projectId: string; storeId: string | null; kind: 'follow' | 'unfollow' | 'competitor' | 'ficha';
  payload: Record<string, unknown>; why: string; state: 'pending' | 'accepted' | 'rejected' | 'superseded'; createdAt: string;
}
export interface AsoCompetitorSnapView { competitorId: number; storeId: string; takenAt: string; name: string; subtitle: string | null; version: string | null }
export interface AsoCompetitorView { id: number; appId: string; name: string; current: AsoCompetitorSnapView | null; changes: AsoCompetitorSnapView[] }
export interface AsoView {
  stores: { id: string; country: string }[];
  lastRun: { at: string; ok: boolean; error: string | null } | null;
  ficha: { current: AsoFicha | null; proposal: AsoProposalView | null };
  keywords: KeywordRow[];
  pending: AsoProposalView[];
  competitors: AsoCompetitorView[];
}
export interface AsoObservationView { keywordId: number; takenAt: string; ok: boolean; popularity: number | null; difficulty: number | null; rank: number | null; error: string | null }

export const api = {
  aso: (project: string, store: string) => req<AsoView>('GET', `/api/aso?project=${encodeURIComponent(project)}&store=${encodeURIComponent(store)}`),
  asoHistory: (keywordId: number) => req<AsoObservationView[]>('GET', `/api/aso/keywords/${keywordId}/history`),
  asoAddKeyword: (project: string, store: string, text: string) => req<unknown>('POST', '/api/aso/keywords', { project, store, text }),
  asoArchiveKeyword: (id: number) => req<{ ok: true }>('POST', `/api/aso/keywords/${id}/archive`),
  asoAddCompetitor: (project: string, appId: string, name: string) => req<unknown>('POST', '/api/aso/competitors', { project, appId, name }),
  asoArchiveCompetitor: (id: number) => req<{ ok: true }>('POST', `/api/aso/competitors/${id}/archive`),
  asoDecide: (id: number, decision: 'accepted' | 'rejected') => req<unknown>('POST', `/api/aso/proposals/${id}`, { decision }),
  asoAcceptAll: (project: string, store: string) => req<{ ok: true; accepted: number }>('POST', '/api/aso/proposals/accept-all', { project, store }),
  asoRefresh: () => req<{ ok: boolean }>('POST', '/api/aso/refresh'),
  metrics: (project: string) => req<MetricsView>('GET', `/api/metrics?project=${encodeURIComponent(project)}`),
  refreshMetrics: () => req<{ ok: boolean }>('POST', '/api/metrics/refresh'),
  config: () => req<ConfigView>('GET', '/api/config'),
  routines: () => req<RoutineView[]>('GET', '/api/routines'),
  runRoutine: (id: string) => req<Task>('POST', `/api/routines/${id}/run`),
  toggleRoutine: (id: string) => req<unknown>('POST', `/api/routines/${id}/toggle`),
  tasks: () => req<Task[]>('GET', '/api/tasks'),
  stats: () => req<{ tasks: Record<string, TaskStats>; spend: Spend }>('GET', '/api/stats'),
  history: (offset: number) => req<Task[]>('GET', `/api/tasks?state=done,discarded&limit=50&offset=${offset}`),
  children: (parentId: string) => req<Task[]>('GET', `/api/tasks?parent=${encodeURIComponent(parentId)}`),
  task: (id: string) => req<TaskDetail>('GET', `/api/tasks/${id}`),
  events: (id: string, after = 0) => req<EventRow[]>('GET', `/api/tasks/${id}/events?after=${after}`),
  create: (b: { projectId: string; title: string; description: string; profileId: string; level: Level; draft: boolean; release?: Release }) =>
    req<Task>('POST', '/api/tasks', b),
  release: (id: string) => req<Job>('POST', `/api/tasks/${id}/release`),
  retryJob: (jobId: number) => req<Job>('POST', `/api/jobs/${jobId}/retry`),
  stopJob: (jobId: number) => req<{ ok: true }>('POST', `/api/jobs/${jobId}/stop`),
  approve: (id: string) => req<{ status: string; message?: string; followUpTaskId?: string }>('POST', `/api/tasks/${id}/approve`),
  createChat: (projectId: string, text: string) => req<Task>('POST', '/api/chats', { projectId, text }),
  requestChanges: (id: string, comment: string) => req<Task>('POST', `/api/tasks/${id}/request-changes`, { comment }),
  message: (id: string, text: string, interrupt = false) => req<Task>('POST', `/api/tasks/${id}/message`, { text, interrupt }),
  answer: (id: string, input: { answers?: Record<string, string | string[]>; text?: string }) => req<Task>('POST', `/api/tasks/${id}/answer`, input),
  discard: (id: string) => req<Task>('POST', `/api/tasks/${id}/discard`),
  stop: (id: string) => req<Task>('POST', `/api/tasks/${id}/stop`),
  queueDraft: (id: string, level?: Level) => req<Task>('POST', `/api/tasks/${id}/queue`, level === undefined ? {} : { level }),
  push: (id: string) => req<{ ok: true }>('POST', `/api/tasks/${id}/push`),
  plan: (projectId: string) => req<PlanState>('GET', `/api/plan/${projectId}`),
  planRefresh: (projectId: string) => req<unknown>('POST', `/api/plan/${projectId}/refresh`),
  planAdd: (projectId: string, text: string) => req<BacklogItem>('POST', `/api/plan/${projectId}/backlog`, { text }),
  planDone: (projectId: string, item: number, isDone: boolean) => req<BacklogItem>('POST', `/api/plan/${projectId}/backlog/${item}`, { isDone }),
  planTested: (projectId: string, taskId: string, tested: boolean) => req<{ ok: true }>('POST', `/api/plan/${projectId}/tested/${taskId}`, { tested }),
  pushState: () => req<{ projects: PushState[] }>('GET', '/api/push-state'),
  pushProject: (projectId: string) => req<{ ok: true }>('POST', `/api/projects/${projectId}/push`),
  queue: () => req<QueueState>('GET', '/api/queue'),
  resumeQueue: () => req<QueueState>('POST', '/api/queue/resume'),
  artifactText: async (id: number) => {
    const r = await fetch(`/api/artifacts/${id}/file`);
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
    }
    return r.text();
  },
};

export interface AuthState { local: boolean; device: Device | null }
export interface PushSubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string } }

export const authApi = {
  authState: () => req<AuthState>('GET', '/api/auth/state'),
  createPairingCode: () => req<{ code: string; expiresAt: string }>('POST', '/api/devices/pairing'),
  pair: (code: string, name: string) => req<{ device: Device }>('POST', '/api/devices/pair', { code, name }),
  devices: () => req<Device[]>('GET', '/api/devices'),
  revokeDevice: (id: string) => req<{ ok: true }>('POST', `/api/devices/${encodeURIComponent(id)}/revoke`),
  pushKey: () => req<{ publicKey: string }>('GET', '/api/push/key'),
  pushSubscribe: (sub: PushSubscriptionInput) => req<{ ok: true }>('POST', '/api/push/subscribe', sub),
  pushUnsubscribe: (endpoint: string) => req<{ ok: true }>('POST', '/api/push/unsubscribe', { endpoint }),
  pushTest: () => req<{ sent: number; failed: number }>('POST', '/api/push/test'),
};
export const { authState, createPairingCode, pair, devices, revokeDevice, pushKey, pushSubscribe, pushUnsubscribe, pushTest } = authApi;

export const artifactUrl = (id: number) => `/api/artifacts/${id}/file`;

interface Listener { fn: (m: BusMessage) => void; onOpen?: () => void }
const listeners = new Set<Listener>();
let shared: EventSource | null = null;

export function subscribe(fn: (m: BusMessage) => void, onOpen?: () => void): () => void {
  const l: Listener = { fn, onOpen };
  listeners.add(l);
  if (!shared) {
    const es = new EventSource('/api/stream');
    es.onopen = () => { for (const x of [...listeners]) x.onOpen?.(); };
    es.onmessage = (e) => {
      let m: BusMessage;
      try { m = JSON.parse(e.data) as BusMessage; } catch { return; }
      for (const x of [...listeners]) x.fn(m);
    };
    shared = es;
  } else if (shared.readyState === EventSource.OPEN) {
    onOpen?.();
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && shared) { shared.close(); shared = null; }
  };
}

export function mergeTasks(prev: Task[], incoming: Task[]): Task[] {
  const map = new Map(prev.map((t) => [t.id, t]));
  for (const t of incoming) {
    const old = map.get(t.id);
    if (!old || t.updatedAt >= old.updatedAt) map.set(t.id, t);
  }
  return [...map.values()];
}

export function mergeEvents(prev: EventRow[], incoming: EventRow[]): EventRow[] {
  const map = new Map(prev.map((e) => [e.id, e]));
  for (const e of incoming) map.set(e.id, e);
  return [...map.values()].sort((a, b) => a.id - b.id);
}

/** Cambios sin subir de un proyecto: commits por delante del remoto y tareas con el push pendiente. */
export interface PushState { id: string; name: string; remote: string; baseBranch: string; ahead: number; pending: string[] }

export const STATE_LABEL: Record<Task['state'], string> = {
  draft: 'Borrador', queued: 'En cola', working: 'Trabajando', blocked: 'Bloqueada',
  review: 'En revisión', pr: 'Esperando CI', done: 'Hecha', discarded: 'Descartada', idle: 'Esperando tu mensaje',
};

export const LEVEL_LABEL: Record<Level, string> = {
  1: '1 · Solo lectura', 2: '2 · Integra si pasan los tests', 3: '3 · Integra si pasan los tests', 4: '4 · Autónomo',
};
