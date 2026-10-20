import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentEnv } from '../src/server/policy';
import { Bus } from '../src/server/bus';
import { Runner, type RunInput, type RunnerDeps } from '../src/server/runner/runner';
import { Store } from '../src/server/store';
import type { BusMessage, ProjectConfig } from '../src/server/types';
import { FAKE_CLAUDE, fixture, tmpDir } from './helpers';

const project = { id: 'demo', prefix: 'DEM', startNumber: 1 } as ProjectConfig;

function setup(env: Record<string, string>, killGraceMs = 100, closeGraceMs = 200, extra: Partial<RunnerDeps> = {}) {
  const store = new Store(':memory:');
  const bus = new Bus();
  const seen: BusMessage[] = [];
  bus.subscribe((m) => seen.push(m));
  const runner = new Runner({ store, bus, claudeBin: FAKE_CLAUDE, env, killGraceMs, closeGraceMs, ...extra });
  const task = store.createTask(project, { title: 'T', description: '', profileId: 'dev', level: 2 });
  const cwd = tmpDir('faro-cwd-');
  const input: RunInput = {
    taskId: task.id, cwd, sessionId: 's-1', resume: false, prompt: 'Haz algo', displayPrompt: null, systemPrompt: 'SYS', level: 2,
    profile: { id: 'dev', name: 'Dev', instructions: '', defaultLevel: 2, timeoutMinutes: 1 },
  };
  return { store, bus, runner, input, seen, cwd };
}

const strays: number[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const pid of strays.splice(0)) {
    try { process.kill(pid); } catch { /* ya terminó */ }
  }
});

describe('Runner', () => {
  it('ejecuta, guarda eventos, emite por el bus y devuelve done', async () => {
    const out = path.join(tmpDir(), 'stdin.jsonl');
    const { store, runner, input, seen, cwd } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_STDIN_OUT: out, FAKE_WRITE: 'hola.txt' });
    const r = await runner.run(input);
    expect(r.outcome).toBe('done');
    expect(r.result?.summary).toBe('He creado hola.txt');
    expect(existsSync(path.join(cwd, 'hola.txt'))).toBe(true);
    expect(JSON.parse(readFileSync(out, 'utf8').trim())).toBe('Haz algo');
    const kinds = store.listEvents(input.taskId).map((e) => e.kind);
    expect(kinds).toEqual(['system', 'message', 'tool', 'tool', 'result']);
    expect(seen.filter((m) => m.type === 'event')).toHaveLength(5);
    const run = store.getRun(r.runId);
    expect(run).toMatchObject({ outcome: 'done', inputTokens: 12, outputTokens: 34, sessionId: 's-1' });
    expect(runner.isRunning(input.taskId)).toBe(false);
    expect(r.sawInit).toBe(true);
  });

  it('el evento result incluye las denegaciones de permisos', async () => {
    const { store, runner, input } = setup({ FAKE_FIXTURES: fixture('stream-denied.jsonl') });
    await runner.run(input);
    const result = store.listEvents(input.taskId).find((e) => e.kind === 'result');
    expect((result?.payload as { permissionDenials: unknown[] }).permissionDenials).toHaveLength(1);
  });

  it('error registra un evento de error', async () => {
    const { store, runner, input } = setup({ FAKE_FIXTURES: fixture('stream-error.jsonl'), FAKE_EXIT: '1' });
    const r = await runner.run(input);
    expect(r.outcome).toBe('error');
    expect(store.listEvents(input.taskId).at(-1)?.kind).toBe('error');
  });

  it('límite de uso devuelve resetsAt', async () => {
    const { runner, input } = setup({ FAKE_FIXTURES: fixture('stream-rate-limited.jsonl'), FAKE_EXIT: '1' });
    const r = await runner.run(input);
    expect(r).toMatchObject({ outcome: 'rate_limited', resetsAt: 1792062600 });
  });

  it('corta por tiempo máximo', async () => {
    const { runner, input } = setup({ FAKE_HANG: '1' });
    const r = await runner.run({ ...input, profile: { ...input.profile, timeoutMinutes: 0.003 } });
    expect(r.outcome).toBe('timeout');
  });

  it('cancel interrumpe la ejecución', async () => {
    const { runner, input } = setup({ FAKE_HANG: '1' });
    const p = runner.run(input);
    await new Promise((res) => setTimeout(res, 100));
    expect(runner.isRunning(input.taskId)).toBe(true);
    runner.cancel(input.taskId);
    expect((await p).outcome).toBe('interrupted');
  });

  it('el agente recibe el entorno sin credenciales de push', async () => {
    const out = path.join(tmpDir(), 'env.jsonl');
    const { runner, input } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_ENV_OUT: out });
    await runner.run({ ...input, env: agentEnv('origin') });
    expect(JSON.parse(readFileSync(out, 'utf8').trim())).toEqual({ GIT_CONFIG_KEY_0: 'remote.origin.pushurl', GH_TOKEN: 'faro-sin-acceso' });
  });

  it('binario inexistente → error, sin colgarse', async () => {
    const store = new Store(':memory:');
    const runner = new Runner({ store, bus: new Bus(), claudeBin: '/no/existe/claude' });
    const task = store.createTask(project, { title: 'T', description: '', profileId: 'dev', level: 2 });
    const r = await runner.run({
      taskId: task.id, cwd: tmpDir(), sessionId: 's', resume: false, prompt: 'x', displayPrompt: null, systemPrompt: 'y', level: 2,
      profile: { id: 'dev', name: 'Dev', instructions: '', defaultLevel: 2, timeoutMinutes: 1 },
    });
    expect(r.outcome).toBe('error');
    expect(r.error).toMatch(/ENOENT/);
  });

  it('un suscriptor del bus que falla no tumba la ejecución ni pierde eventos', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, bus, runner, input } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl') });
    bus.subscribe(() => { throw new Error('suscriptor roto'); });
    const r = await runner.run(input);
    expect(r.outcome).toBe('done');
    expect(store.listEvents(input.taskId)).toHaveLength(5);
    expect(spy).toHaveBeenCalled();
  });

  it('si finishRun falla, run() se resuelve igualmente con error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, runner, input } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl') });
    vi.spyOn(store, 'finishRun').mockImplementationOnce(() => { throw new Error('disco lleno'); });
    const r = await runner.run(input);
    expect(r.outcome).toBe('error');
    expect(r.error).toContain('disco lleno');
    expect(runner.isRunning(input.taskId)).toBe(false);
  });

  it('un nieto que retiene stdout no cuelga la ejecución', async () => {
    const pidOut = path.join(tmpDir(), 'pids.txt');
    const { runner, input } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl'), FAKE_ORPHAN: '1', FAKE_ORPHAN_PID_OUT: pidOut });
    try {
      const r = await runner.run(input);
      expect(r.outcome).toBe('done');
    } finally {
      if (existsSync(pidOut)) strays.push(...readFileSync(pidOut, 'utf8').split('\n').filter(Boolean).map(Number));
    }
  }, 10_000);

  it('rechaza una segunda ejecución simultánea de la misma tarea', async () => {
    const { runner, input } = setup({ FAKE_HANG: '1' });
    const p = runner.run(input);
    expect(() => runner.run(input)).toThrow(/ya tiene una ejecución en curso/);
    runner.cancel(input.taskId);
    await p;
  });

  it('sawInit es false si claude falla antes de crear la sesión', async () => {
    const { runner, input } = setup({ FAKE_FAIL_FIRST: 'No arranca' });
    const r = await runner.run(input);
    expect(r.outcome).toBe('error');
    expect(r.sawInit).toBe(false);
  });

  it('displayPrompt se guarda como primer evento prompt; null no guarda nada', async () => {
    const a = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl') });
    await a.runner.run({ ...a.input, displayPrompt: 'Tarea X' });
    const evs = a.store.listEvents(a.input.taskId);
    expect(evs[0]).toMatchObject({ kind: 'prompt', payload: { text: 'Tarea X' } });
    expect(a.seen.find((m) => m.type === 'event')).toMatchObject({ event: { kind: 'prompt' } });
    const b = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl') });
    await b.runner.run(b.input);
    expect(b.store.listEvents(b.input.taskId).some((e) => e.kind === 'prompt')).toBe(false);
  });

  it('guarda modelo, contexto en vivo, coste y ventana; emite stats', async () => {
    const { store, runner, input, seen } = setup({ FAKE_FIXTURES: fixture('stream-done-usage.jsonl') });
    const r = await runner.run(input);
    expect(r.outcome).toBe('done');
    expect(store.getRun(r.runId)).toMatchObject({
      model: 'claude-opus-5-5', contextTokens: 57000, costUsd: 1.52, contextWindow: 1_000_000, inputTokens: 15, outputTokens: 130,
    });
    const stats = seen.filter((m): m is Extract<BusMessage, { type: 'stats' }> => m.type === 'stats');
    expect(stats.length).toBeGreaterThanOrEqual(2);
    expect(stats.every((m) => m.taskId === input.taskId)).toBe(true);
    // El primero llega tras init (aún sin contexto); el último, al terminar, con todo.
    expect(stats[0].stats).toMatchObject({ model: 'claude-opus-5-5', contextTokens: null });
    expect(stats.at(-1)!.stats).toMatchObject({ contextTokens: 57000, contextWindow: 1_000_000, costUsd: 1.52, turns: 1 });
    expect(stats.some((m) => m.stats.contextTokens === 21010)).toBe(true);
  });

  it('stats por uso: como mucho uno por segundo (init y final siempre)', async () => {
    const count = async (now: () => number) => {
      const { runner, input, seen } = setup({ FAKE_FIXTURES: fixture('stream-done-usage.jsonl') }, 100, 200, { now });
      await runner.run(input);
      return seen.filter((m) => m.type === 'stats').length;
    };
    // Reloj parado: init + primer usage + final; el segundo usage se descarta.
    expect(await count(() => 0)).toBe(3);
    // Reloj que avanza 2 s por llamada: también sale el segundo usage.
    let t = 0;
    expect(await count(() => (t += 2000))).toBe(4);
  });

  it('sin ventana en el resultado, stats usa defaultWindow', async () => {
    const { runner, input, seen } = setup({ FAKE_FIXTURES: fixture('stream-done.jsonl') }, 100, 200, { defaultWindow: () => 123456 });
    await runner.run(input);
    const last = seen.filter((m): m is Extract<BusMessage, { type: 'stats' }> => m.type === 'stats').at(-1);
    expect(last?.stats.contextWindow).toBe(123456);
  });

  it('total_cost_usd es acumulado por sesión: cada ejecución guarda su parte', async () => {
    const dir = tmpDir();
    const write = (name: string, cost: number) => {
      const f = path.join(dir, name);
      const lines = readFileSync(fixture('stream-done-usage.jsonl'), 'utf8').replace('"total_cost_usd":1.52', `"total_cost_usd":${cost}`);
      writeFileSync(f, lines);
      return f;
    };
    const counter = path.join(dir, 'n');
    const { store, runner, input } = setup({ FAKE_FIXTURES: [write('a.jsonl', 1.0), write('b.jsonl', 1.25), write('c.jsonl', 0.4)].join(','), FAKE_COUNTER: counter });
    const r1 = await runner.run(input);
    const r2 = await runner.run({ ...input, resume: true });
    expect(store.getRun(r1.runId).costUsd).toBeCloseTo(1.0);
    expect(store.getRun(r2.runId).costUsd).toBeCloseTo(0.25);
    expect(store.getRun(r2.runId).sessionTotalUsd).toBeCloseTo(1.25);
    expect(store.taskStats([input.taskId], () => 200000)[input.taskId].costUsd).toBeCloseTo(1.25);
    // Sesión nueva: su total no se reduce con lo gastado en otra sesión.
    const r3 = await runner.run({ ...input, sessionId: 's-2' });
    expect(store.getRun(r3.runId).costUsd).toBeCloseTo(0.4);
  });

  it('nunca guarda un coste negativo', async () => {
    const { store, runner, input } = setup({ FAKE_FIXTURES: fixture('stream-done-usage.jsonl') });
    const prev = store.startRun(input.taskId, input.sessionId);
    store.finishRun(prev.id, 'done', { input: 0, output: 0, costUsd: 9, sessionTotalUsd: 9 });
    const r = await runner.run(input);
    expect(store.getRun(r.runId).costUsd).toBe(0);
  });

  it('reanudar una sesión anterior a la migración no carga su total entero a hoy', async () => {
    const dir = tmpDir();
    const write = (name: string, cost: number) => {
      const f = path.join(dir, name);
      writeFileSync(f, readFileSync(fixture('stream-done-usage.jsonl'), 'utf8').replace('"total_cost_usd":1.52', `"total_cost_usd":${cost}`));
      return f;
    };
    const { store, runner, input } = setup({ FAKE_FIXTURES: [write('a.jsonl', 40), write('b.jsonl', 40.3)].join(','), FAKE_COUNTER: path.join(dir, 'n') });
    // Ejecución de antes del despliegue: sin coste ni total de sesión.
    const old = store.startRun(input.taskId, input.sessionId);
    store.finishRun(old.id, 'done', { input: 0, output: 0 });
    const r1 = await runner.run({ ...input, resume: true });
    expect(store.getRun(r1.runId)).toMatchObject({ costUsd: null, sessionTotalUsd: 40 });
    expect(store.spend(new Date()).today).toBe(0);
    expect(store.taskStats([input.taskId], () => 200000)[input.taskId]).toMatchObject({ costUsd: null, costPartial: true });
    const r2 = await runner.run({ ...input, resume: true });
    expect(store.getRun(r2.runId).costUsd).toBeCloseTo(0.3);
    expect(store.getRun(r2.runId).sessionTotalUsd).toBeCloseTo(40.3);
    expect(store.spend(new Date()).today).toBeCloseTo(0.3);
  });

  it('si finishRun falla, el reintento como error conserva el coste del resultado', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, runner, input } = setup({ FAKE_FIXTURES: fixture('stream-done-usage.jsonl') });
    vi.spyOn(store, 'finishRun').mockImplementationOnce(() => { throw new Error('disco lleno'); });
    const r = await runner.run(input);
    expect(r.outcome).toBe('error');
    expect(store.getRun(r.runId)).toMatchObject({ outcome: 'error', costUsd: 1.52 });
  });
});
