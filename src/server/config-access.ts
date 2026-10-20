import type { OverrideKind } from './overrides';
import type { FaroConfig } from './types';

/** Quién pide el cambio: `local` = el Mac (`faroLocal`); si no, un dispositivo vinculado. */
export type Actor = { local: boolean };
/** `before` null = crear; `after` null = borrar o volver a la config. Ambos son el elemento entero. */
export type Change = {
  kind: OverrideKind; id: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
};
export type Access = { ok: true } | { ok: false; reason: string };

const OK: Access = { ok: true };
const no = (reason: string): Access => ({ ok: false, reason });

const highLevel = (v: unknown) => typeof v === 'number' && v >= 3;
const publishes = (e: Record<string, unknown> | null) => !!e && e.release !== undefined && e.release !== 'none';

/**
 * Qué se puede cambiar y desde dónde. Lo comprueba el servidor; la web solo deshabilita los controles.
 * - Para todos: `release` de una rutina y `mcpConfig` de un perfil se editan en faro.config.ts.
 * - Desde un vinculado: solo rutinas y perfiles de nivel ≤ 2, sin tocar nada que ya sea de nivel 3-4,
 *   el perfil coordinador, perfiles usados por rutinas de nivel 3-4, ni rutinas con `release`.
 */
export function canChange(actor: Actor, change: Change, config: FaroConfig): Access {
  const { kind, id, before, after } = change;
  if (kind === 'routine' && after && publishes(after)) return no('Se edita en faro.config.ts');
  if (kind === 'profile' && after && after.mcpConfig !== before?.mcpConfig) return no('Se edita en faro.config.ts');
  if (actor.local) return OK;

  if (kind === 'project' || kind === 'general') return no('Solo desde el Mac');

  if (kind === 'routine') {
    if (highLevel(after?.level)) return no('Desde un dispositivo vinculado solo se pueden usar los niveles 1 y 2');
    if (highLevel(before?.level)) return no('Desde un dispositivo vinculado no se puede editar una rutina de nivel 3 o 4');
    if (publishes(before) || publishes(after)) {
      return no('Desde un dispositivo vinculado no se pueden editar rutinas que publican en la tienda');
    }
    return OK;
  }

  // profile
  if (highLevel(after?.defaultLevel)) return no('Desde un dispositivo vinculado solo se pueden usar los niveles 1 y 2');
  if (highLevel(before?.defaultLevel)) return no('Desde un dispositivo vinculado no se puede editar un perfil de nivel 3 o 4');
  if (id === (config.coordinatorProfile ?? 'coordinador')) {
    return no('Desde un dispositivo vinculado no se puede editar el perfil coordinador');
  }
  const usado = config.projects.some(p => (p.routines ?? []).some(r => r.profileId === id && r.level >= 3));
  if (usado) return no('Desde un dispositivo vinculado no se puede editar un perfil que usa una rutina de nivel 3 o 4');
  return OK;
}

/** Para que la web sepa qué deshabilitar: ¿puede este actor editar (o borrar) el elemento tal como está ahora? */
export function editableBy(actor: Actor, kind: OverrideKind, id: string, config: FaroConfig): Access {
  let before: Record<string, unknown> | null = null;
  if (kind === 'routine') {
    for (const p of config.projects) {
      const r = (p.routines ?? []).find(x => x.id === id);
      if (r) { before = { ...r }; break; }
    }
  } else if (kind === 'profile') {
    const p = config.profiles.find(x => x.id === id);
    if (p) before = { ...p };
  }
  // Un elemento que no existe se trata como nuevo: sin `after` no hay nada que impida crearlo (salvo proyecto/generales).
  return canChange(actor, { kind, id, before, after: null }, config);
}
