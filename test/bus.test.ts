import { describe, expect, it, vi } from 'vitest';
import { Bus } from '../src/server/bus';
import type { QueueState } from '../src/server/types';

describe('Bus', () => {
  it('un suscriptor que falla no impide los demás ni lanza', () => {
    const bus = new Bus();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got = vi.fn();
    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe(got);
    const queue: QueueState = { paused: false, reason: null, until: null, running: [] };
    expect(() => bus.emitQueue(queue)).not.toThrow();
    expect(got).toHaveBeenCalledWith({ type: 'queue', queue });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
