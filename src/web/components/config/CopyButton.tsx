import { useState } from 'react';

/** Copia un texto al portapapeles; sin `navigator.clipboard` (HTTP fuera de localhost) usa un textarea temporal. */
async function copy(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* se prueba el plan B */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { ta.remove(); }
}

export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const click = async () => {
    setState((await copy(text)) ? 'ok' : 'fail');
    setTimeout(() => setState('idle'), 1500);
  };
  return <button type="button" className="btn small" onClick={() => void click()}>{state === 'ok' ? 'Copiado' : state === 'fail' ? 'No se pudo copiar' : 'Copiar'}</button>;
}
