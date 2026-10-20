import { useEffect, useState } from 'react';
import { api } from '../api';

function cls(l: string): string {
  if (l.startsWith('diff --git')) return 'file';
  if (l.startsWith('@@')) return 'hunk';
  if (l.startsWith('+') && !l.startsWith('+++')) return 'add';
  if (l.startsWith('-') && !l.startsWith('---')) return 'del';
  return '';
}

export function DiffView({ artifactId }: { artifactId: number }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let ignore = false;
    setText(null);
    setError(null);
    api.artifactText(artifactId)
      .then((t) => { if (!ignore) setText(t); })
      .catch((e: Error) => { if (!ignore) setError(e.message); });
    return () => { ignore = true; };
  }, [artifactId]);
  if (error) return <p className="error" role="alert">No se pudo cargar el diff: {error}</p>;
  if (text === null) return <p className="muted">Cargando diff…</p>;
  if (!text.trim()) return <p className="muted">Sin cambios en el código.</p>;
  return (
    <div className="diff">
      {text.split('\n').map((l, i) => <pre key={i} className={cls(l)}>{l || ' '}</pre>)}
    </div>
  );
}
