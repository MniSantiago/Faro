import { copyFileSync, existsSync, renameSync, rmSync, statSync, truncateSync } from 'node:fs';
import path from 'node:path';

/**
 * Rota out.log y err.log al arrancar. Se copia y se vacía (no se renombra) porque launchd ya tiene
 * el archivo abierto: renombrarlo haría que este proceso siguiera escribiendo en el viejo.
 */
export function rotateLogs(dir: string, opts: { maxBytes?: number; keep?: number } = {}): void {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 3;
  for (const name of ['out.log', 'err.log']) {
    const file = path.join(dir, name);
    try {
      if (!existsSync(file) || statSync(file).size <= maxBytes) continue;
      rmSync(`${file}.${keep}`, { force: true });
      for (let n = keep - 1; n >= 1; n--) if (existsSync(`${file}.${n}`)) renameSync(`${file}.${n}`, `${file}.${n + 1}`);
      copyFileSync(file, `${file}.1`);
      truncateSync(file, 0);
    } catch (e) {
      console.error(`[faro] no se pudo rotar ${file}`, e);
    }
  }
}
