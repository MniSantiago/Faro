import type { Approval, Job, Task } from '../../server/types';
import { api, artifactUrl } from '../api';

const KIND = { build: 'Build EAS', submit: 'Envío a App Store' } as const;
const STATE = { running: 'En curso', ok: 'Terminado', failed: 'Falló', interrupted: 'Interrumpido' } as const;

export function ReleasePanel({ task, jobs, approvals, busy, act, logArtifactId }: {
  task: Task; jobs: Job[]; approvals: Approval[]; busy: boolean;
  act: (fn: () => Promise<unknown>) => void; logArtifactId: (job: Job) => number | undefined;
}) {
  if (task.release === 'none') return null;
  const pending = (a: string) => approvals.some((x) => x.action === a && x.state === 'pending');
  const running = jobs.some((j) => j.state === 'running');
  const latest = (j: Job) => jobs.filter((x) => x.kind === j.kind).at(-1)?.id === j.id;
  return (
    <section className="release">
      <h2>Lanzamiento</h2>
      {jobs.length === 0 && !pending('eas') && <p className="muted">Se lanzará al integrar.</p>}
      <ul className="checks">
        {jobs.map((j) => {
          const log = logArtifactId(j);
          return (
            <li key={j.id} className={j.state === 'ok' ? 'ok' : j.state === 'running' ? 'skip' : 'fail'}>
              {KIND[j.kind]} · {STATE[j.state]}
              {j.meta.url?.startsWith('https://') && <> · <a href={j.meta.url} target="_blank" rel="noreferrer">ver en Expo</a></>}
              {log !== undefined && <> · <a href={artifactUrl(log)} target="_blank" rel="noreferrer">log</a></>}
              {j.state === 'running' && <button className="btn small danger" disabled={busy} onClick={() => act(() => api.stopJob(j.id))}>Parar</button>}
              {(j.state === 'failed' || j.state === 'interrupted') && !running && latest(j) && !(j.kind === 'submit' && pending('publish')) &&
                <button className="btn small" disabled={busy} onClick={() => act(() => api.retryJob(j.id))}>Reintentar</button>}
            </li>
          );
        })}
      </ul>
      <div className="actions">
        {pending('eas') && !running && <button className="btn primary" disabled={busy} onClick={() => act(() => api.release(task.id))}>Lanzar build</button>}
        {pending('publish') && !running && <button className="btn primary" disabled={busy} onClick={() => act(() => api.release(task.id))}>Enviar a App Store</button>}
      </div>
    </section>
  );
}
