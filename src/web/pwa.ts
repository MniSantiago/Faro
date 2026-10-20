export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('No se pudo registrar el service worker', err));
  });
}

/** El script principal que enlaza un index.html (`/assets/index-<hash>.js`), o null. */
export function mainScript(html: string): string | null {
  return html.match(/<script[^>]+src="(\/assets\/[^"]+\.js)"/)?.[1] ?? null;
}

/**
 * iOS no recarga una PWA al volver a ella: sigue con el JavaScript viejo tras un despliegue. Al volver a primer
 * plano (y cada 10 min) se compara el script de la versión servida con el cargado y, si cambió, se recarga,
 * salvo que haya algo escrito sin enviar (se reintenta en la siguiente vuelta).
 */
export function reloadOnNewVersion(): void {
  const current = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src');
  if (!current) return; // En desarrollo (Vite) no hay build que comparar.
  const check = async () => {
    try {
      const res = await fetch('/', { cache: 'no-store' });
      if (!res.ok) return;
      const served = mainScript(await res.text());
      const typing = [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input[type="text"]')].some((e) => e.value.trim());
      if (served && served !== current && !typing) location.reload();
    } catch { /* Sin conexión: se vuelve a mirar más tarde. */ }
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check(); });
  setInterval(() => { if (document.visibilityState === 'visible') void check(); }, 10 * 60_000);
}
