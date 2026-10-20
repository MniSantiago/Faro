/** Decodifica una clave pública VAPID (base64url, sin relleno) a bytes para `pushManager.subscribe`. */
export function urlBase64ToUint8Array(key: string): Uint8Array<ArrayBuffer> {
  const padded = key + '='.repeat((4 - (key.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** ¿Faro está abierto como app instalada (pantalla de inicio)? */
export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

/** Nombre por defecto del dispositivo según el navegador. */
export function defaultDeviceName(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  return 'Navegador';
}
