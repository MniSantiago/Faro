import type { EventRow } from '../../server/types';

function line(e: EventRow): { cls: string; text: string } {
  const p = e.payload as Record<string, unknown>;
  switch (e.kind) {
    case 'message': return { cls: 'msg', text: String(p.text ?? '') };
    case 'tool':
      return p.name
        ? { cls: 'tool', text: `▸ ${p.name} ${JSON.stringify(p.input ?? {}).slice(0, 300)}` }
        : { cls: p.isError ? 'tool err' : 'tool', text: `  ↳ ${String(p.result ?? '').slice(0, 300)}` };
    case 'result': return { cls: p.isError ? 'err' : 'result', text: String(p.text ?? '') };
    case 'error': return { cls: 'err', text: `⚠ ${String(p.message ?? '')}` };
    default: return { cls: 'sys', text: `· sesión ${String(p.sessionId ?? '')}` };
  }
}

export function LogView({ events }: { events: EventRow[] }) {
  if (events.length === 0) return <p className="muted">Sin actividad todavía.</p>;
  return (
    <div className="log">
      {events.map((e) => {
        const l = line(e);
        return <pre key={e.id} className={l.cls}>{l.text}</pre>;
      })}
    </div>
  );
}
