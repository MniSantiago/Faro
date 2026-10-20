import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** Un pendiente del backlog compartido con el plugin `pendientes` de Claude Code (mismo archivo y formato). */
export interface BacklogItem { id: number; text: string; isDone: boolean; createdAt: number }
interface Board { key: string; items: BacklogItem[]; nextId: number }

/**
 * Backlog de un proyecto en el archivo del plugin `pendientes` (clave `pend:<repo>`). Cada cambio relee el
 * archivo justo antes de escribir y lo reemplaza de forma atómica, conservando las demás claves.
 */
export class Backlog {
  constructor(private file: string, private repoPath: string) {}

  private get key(): string { return `pend:${this.repoPath}`; }

  private readAll(): Record<string, unknown> {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
  }

  private board(all: Record<string, unknown>): Board {
    const b = all[this.key] as Partial<Board> | undefined;
    const items = Array.isArray(b?.items) ? b!.items : [];
    const maxId = items.reduce((m, i) => Math.max(m, i.id), 0);
    return { key: this.repoPath, items, nextId: Math.max(b?.nextId ?? 1, maxId + 1) };
  }

  private write(all: Record<string, unknown>, board: Board): void {
    const tmp = `${this.file}.faro-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...all, [this.key]: board }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  list(): BacklogItem[] {
    return this.board(this.readAll()).items;
  }

  add(text: string, now = Date.now()): BacklogItem {
    const clean = text.trim().replace(/\s+/g, ' ').slice(0, 240);
    if (!clean) throw new Error('El pendiente está vacío');
    const all = this.readAll();
    const b = this.board(all);
    const item: BacklogItem = { id: b.nextId, text: clean, isDone: false, createdAt: now };
    this.write(all, { ...b, items: [...b.items, item], nextId: b.nextId + 1 });
    return item;
  }

  setDone(id: number, isDone: boolean): BacklogItem {
    const all = this.readAll();
    const b = this.board(all);
    const item = b.items.find((i) => i.id === id);
    if (!item) throw new Error(`No existe el pendiente #${id}`);
    const next = { ...item, isDone };
    this.write(all, { ...b, items: b.items.map((i) => (i.id === id ? next : i)) });
    return next;
  }
}
