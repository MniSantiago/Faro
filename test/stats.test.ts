import { describe, expect, it } from 'vitest';
import { defaultWindow } from '../src/server/stats';
import { Store } from '../src/server/store';
import type { FaroConfig, ProjectConfig } from '../src/server/types';

const project = (over: Partial<ProjectConfig> = {}) => ({ id: 'demo', prefix: 'DEM', startNumber: 1, ...over }) as ProjectConfig;

describe('defaultWindow', () => {
  it('usa contextWindow del proyecto de la tarea o 200000', () => {
    const store = new Store(':memory:');
    const a = store.createTask(project(), { title: 'A', description: '', profileId: 'dev', level: 2 });
    const config = { projects: [project()] } as FaroConfig;
    expect(defaultWindow(config, a.id)).toBe(200000);
    config.projects[0].contextWindow = 1_000_000;
    expect(defaultWindow(config, a.id)).toBe(1_000_000);
  });

  it('proyecto desconocido → 200000', () => {
    expect(defaultWindow({ projects: [] as ProjectConfig[] } as FaroConfig, 'XYZ-3')).toBe(200000);
  });
});
