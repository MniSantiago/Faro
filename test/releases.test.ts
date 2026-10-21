import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Bus } from '../src/server/bus';
import { getProject, normalizeConfig } from '../src/server/config';
import { interruptedNote, parseBuildJson, Releases } from '../src/server/releases';
import { Store } from '../src/server/store';
import { releaseRepo } from '../src/server/task-repos';
import type { Level, Release } from '../src/server/types';
import { GitWorkspaces } from '../src/server/workspaces';
import { gitSync, makeConfig, makeRepo, tmpDir } from './helpers';

const FAKE_EAS = path.resolve('test/fake-eas.mjs');

function setup(env: Record<string, string> = {}) {
  const repo = makeRepo();
  const base = makeConfig(repo);
  const release = { cwd: '.', build: `node ${FAKE_EAS} build`, submit: `node ${FAKE_EAS} submit --id {buildId}`, timeoutMinutes: 1 };
  const p0 = base.projects[0];
  const relRepo = makeRepo();
  // El release vive en repos[1]: repos[0] no lo tiene, así que el espejo de campos sueltos no puede ocultar fallos.
  const config = { ...base, projects: [{ ...p0, repos: [p0.repos![0], { ...p0.repos![0], id: 'rel', path: relRepo, release }] }] };
  const store = new Store(':memory:');
  const releases = new Releases({ store, config, bus: new Bus(), workspaces: new GitWorkspaces(), env: { ...process.env, ...env } });
  const project = getProject(config, 'demo');
  const commit = gitSync(relRepo, 'rev-parse', 'main').trim();
  const doneTask = (level: Level, release: Release) => {
    const t = store.createTask(project, { title: 'T', description: '', profileId: 'dev', level, release });
    for (const s of ['queued', 'working', 'review', 'done'] as const) store.setState(t.id, s);
    return t.id;
  };
  return { repo: relRepo, store, releases, commit, doneTask };
}

describe('parseBuildJson', () => {
  it('lee id y URL del JSON de eas build', () => {
    expect(parseBuildJson('aviso\n[{"id":"b1","artifacts":{"buildUrl":"https://x"}}]\n')).toEqual({ buildId: 'b1', url: 'https://x' });
    expect(parseBuildJson('nada')).toEqual({});
  });

  it('M6: solo guarda la URL si es https', () => {
    expect(parseBuildJson('[{"id":"b1","artifacts":{"buildUrl":"javascript:alert(1)"}}]')).toEqual({ buildId: 'b1' });
    expect(parseBuildJson('[{"id":"b1","artifacts":{"buildUrl":"http://x"}}]')).toEqual({ buildId: 'b1' });
  });
});

describe('interruptedNote', () => {
  it('M6: avisa de que el trabajo puede seguir en la nube, según el tipo de lanzamiento', () => {
    expect(interruptedNote('build', 'cierre')).toContain('al cerrarse Faro');
    expect(interruptedNote('build', 'cierre')).toContain('si el build siguió en la nube');
    expect(interruptedNote('submit', 'reinicio')).toContain('al reiniciarse Faro');
    expect(interruptedNote('submit', 'reinicio')).toContain('si el envío llegó a completarse');
    expect(interruptedNote('submit', 'reinicio')).not.toContain('build');
  });
});

describe('Releases multi-repo', () => {
  it('el build de una tarea multi-repo se lanza en el repo con release (aunque no sea el primero)', async () => {
    const a = makeRepo();
    const b = makeRepo();
    writeFileSync(path.join(b, 'solo-en-b.txt'), 'x');
    gitSync(b, 'add', '.');
    gitSync(b, 'commit', '-qm', 'b');
    const data = tmpDir('faro-data-');
    const ls = path.join(tmpDir(), 'ls.txt');
    const config = normalizeConfig({
      host: '127.0.0.1', port: 0, dataDir: data, claudeBin: 'x', maxConcurrentRuns: 2, sandbox: false,
      projects: [{
        id: 'multi', name: 'Multi', prefix: 'MUL', worktreesDir: path.join(data, 'wt'), startNumber: 1,
        repos: [
          { id: 'a', path: a, baseBranch: 'main', remote: 'origin' },
          { id: 'b', path: b, baseBranch: 'main', remote: 'origin', release: { cwd: '.', build: `ls > ${ls} && node ${FAKE_EAS} build`, submit: `node ${FAKE_EAS} submit --id {buildId}` } },
        ],
      }],
      profiles: [{ id: 'dev', name: 'Dev', instructions: 'x', defaultLevel: 2, timeoutMinutes: 1 }],
    });
    const store = new Store(':memory:');
    const releases = new Releases({ store, config, bus: new Bus(), workspaces: new GitWorkspaces(), env: { ...process.env } });
    const project = getProject(config, 'multi');
    expect(releaseRepo(project)?.id).toBe('b');
    const t = store.createTask(project, { title: 'T', description: '', profileId: 'dev', level: 4, release: 'build' });
    for (const s of ['queued', 'working', 'review', 'done'] as const) store.setState(t.id, s);
    releases.afterIntegrate(t.id, gitSync(b, 'rev-parse', 'main').trim());
    await releases.waitIdle();
    expect(store.listJobs(t.id)[0]).toMatchObject({ kind: 'build', state: 'ok' });
    expect(readFileSync(ls, 'utf8')).toContain('solo-en-b.txt');
  });
});

describe('Releases', () => {
  it('nivel 4: build automático en un worktree separado; luego envío pendiente de aprobación', async () => {
    const ls = path.join(tmpDir(), 'ls.json');
    const s = setup({ FAKE_EAS_LS_OUT: ls });
    writeFileSync(path.join(s.repo, 'sin-commitear.txt'), 'x'); // main sucio no afecta al build
    const id = s.doneTask(4, 'build_submit');
    s.releases.afterIntegrate(id, s.commit);
    await s.releases.waitIdle();
    const [job] = s.store.listJobs(id);
    expect(job).toMatchObject({ kind: 'build', state: 'ok', meta: { buildId: 'build-123', url: 'https://expo.dev/artifacts/build-123' } });
    expect(JSON.parse(readFileSync(ls, 'utf8'))).not.toContain('sin-commitear.txt');
    expect(s.store.listApprovals(id).map((a) => [a.action, a.state])).toEqual([['eas', 'auto'], ['publish', 'pending']]);
    expect(existsSync(job.outputPath!)).toBe(true);
  });

  it('nivel < 4: el build espera aprobación; request lo lanza; publish con el buildId', async () => {
    const args = path.join(tmpDir(), 'args.jsonl');
    const s = setup({ FAKE_EAS_ARGS_OUT: args });
    const id = s.doneTask(3, 'build_submit');
    s.releases.afterIntegrate(id, s.commit);
    expect(s.store.listJobs(id)).toEqual([]);
    expect(s.store.listApprovals(id).map((a) => [a.action, a.state])).toEqual([['eas', 'pending']]);
    s.releases.request(id);
    await s.releases.waitIdle();
    s.releases.request(id);
    await s.releases.waitIdle();
    expect(s.store.listJobs(id).map((j) => [j.kind, j.state])).toEqual([['build', 'ok'], ['submit', 'ok']]);
    expect(readFileSync(args, 'utf8')).toContain('["submit","--id","build-123"]');
    expect(() => s.releases.request(id)).toThrow('no tiene ningún lanzamiento pendiente');
  });

  it('release none no hace nada', () => {
    const s = setup();
    const id = s.doneTask(4, 'none');
    s.releases.afterIntegrate(id, s.commit);
    expect(s.store.listApprovals(id)).toEqual([]);
  });

  it('fallo: job failed con el final del log, y reintento', async () => {
    const s = setup({ FAKE_EAS_MODE: 'fail' });
    const id = s.doneTask(4, 'build');
    s.releases.afterIntegrate(id, s.commit);
    await s.releases.waitIdle();
    const [job] = s.store.listJobs(id);
    expect(job.state).toBe('failed');
    expect(s.store.listComments(id).at(-1)?.body).toContain('Build failed: credenciales');
    s.releases.retry(job.id);
    await s.releases.waitIdle();
    expect(s.store.listJobs(id)).toHaveLength(2);
  });

  it('parar un build en marcha', async () => {
    const s = setup({ FAKE_EAS_MODE: 'hang' });
    const id = s.doneTask(4, 'build');
    s.releases.afterIntegrate(id, s.commit);
    await new Promise((r) => setTimeout(r, 500));
    const [job] = s.store.listJobs(id);
    s.releases.stop(job.id);
    await s.releases.waitIdle();
    expect(s.store.getJob(job.id).state).toBe('failed');
    expect(() => s.releases.retry(job.id)).not.toThrow();
    s.releases.stop(s.store.listJobs(id)[1].id);
    await s.releases.waitIdle();
  });

  it('recover: los jobs en marcha al reiniciar quedan interrumpidos y no se relanzan solos', () => {
    const s = setup();
    const id = s.doneTask(4, 'build');
    const j = s.store.createJob(id, 'build');
    s.releases.recover();
    expect(s.store.getJob(j.id).state).toBe('interrupted');
    expect(s.store.runningJobs()).toEqual([]);
    expect(s.store.listComments(id).at(-1)?.body).toContain('Reintentar');
  });

  it('no lanza dos a la vez para la misma tarea', async () => {
    const s = setup({ FAKE_EAS_MODE: 'hang' });
    const id = s.doneTask(4, 'build');
    s.releases.afterIntegrate(id, s.commit);
    await new Promise((r) => setTimeout(r, 200));
    const [job] = s.store.listJobs(id);
    expect(() => s.releases.retry(job.id)).toThrow('en curso');
    s.releases.stop(job.id);
    await s.releases.waitIdle();
  });

  it('retry: solo el último intento fallido o interrumpido', async () => {
    const s = setup({ FAKE_EAS_MODE: 'fail' });
    const id = s.doneTask(4, 'build');
    s.releases.afterIntegrate(id, s.commit);
    await s.releases.waitIdle();
    const [first] = s.store.listJobs(id);
    s.releases.retry(first.id);
    await s.releases.waitIdle();
    expect(() => s.releases.retry(first.id)).toThrow('más reciente');
    const ok = setup();
    const id2 = ok.doneTask(4, 'build');
    ok.releases.afterIntegrate(id2, ok.commit);
    await ok.releases.waitIdle();
    const [done] = ok.store.listJobs(id2);
    expect(done.state).toBe('ok');
    expect(() => ok.releases.retry(done.id)).toThrow('fallido o interrumpido');
  });

  it('retry de un envío: no con publish pendiente; reutiliza su buildId; no con build más nuevo', async () => {
    const args = path.join(tmpDir(), 'args.jsonl');
    const s = setup({ FAKE_EAS_ARGS_OUT: args });
    const id = s.doneTask(4, 'build_submit');
    s.releases.afterIntegrate(id, s.commit);
    await s.releases.waitIdle();
    const failed = s.store.createJob(id, 'submit');
    s.store.setJobMeta(failed.id, { buildId: 'build-123' });
    s.store.finishJob(failed.id, 'failed');
    expect(() => s.releases.retry(failed.id)).toThrow('pendiente de tu aprobación');
    s.store.decideApproval(s.store.listApprovals(id).find((a) => a.action === 'publish')!.id, 'approved');
    s.releases.retry(failed.id);
    await s.releases.waitIdle();
    expect(readFileSync(args, 'utf8')).toContain('["submit","--id","build-123"]');
    // un build más nuevo invalida el reintento de un envío anterior
    const failed2 = s.store.createJob(id, 'submit');
    s.store.setJobMeta(failed2.id, { buildId: 'viejo' });
    s.store.finishJob(failed2.id, 'failed');
    expect(() => s.releases.retry(failed2.id)).toThrow('build más reciente');
  });

  it('un buildId malicioso no llega a la shell', async () => {
    const s = setup({ FAKE_EAS_MODE: 'evil' });
    const id = s.doneTask(4, 'build_submit');
    s.releases.afterIntegrate(id, s.commit);
    await s.releases.waitIdle();
    s.releases.request(id);
    await s.releases.waitIdle();
    const sub = s.store.listJobs(id).find((j) => j.kind === 'submit')!;
    expect(sub.state).toBe('failed');
    expect(s.store.listComments(id).at(-1)?.body).toContain('no es válido');
  });
});
