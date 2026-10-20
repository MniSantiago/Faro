/** Solo enlaces http(s) en el Markdown de los mensajes; cualquier otro esquema (javascript:, data:…) se quita. */
export function safeUrl(url: string): string | null {
  return /^https?:\/\//i.test(url.trim()) ? url : null;
}
