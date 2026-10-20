/** Contexto Markdown de la rutina ASO: ficha, keywords, candidatas, competidores y propuestas rechazadas. */
import type { Store } from '../store';
import type { ProjectConfig } from '../types';
import { fichaWords, inFicha, type CurrentFicha } from './ficha';
import { localDay, type AsoObservation } from './repo';

const DAY = 86_400_000;
const MAX_CANDIDATES = 50;
/** Una observación de referencia solo vale si cae a ±1,5 días de hace 7 días. */
const REF_TOLERANCE = 1.5 * DAY;

export const ASO_INSTRUCTIONS = `Instrucciones para esta rutina ASO:
- No escribas archivos: devuelve el resultado en tu mensaje final, en un bloque \`\`\`aso-json (antes del bloque faro-result). Si pones más de uno, cuenta el último.
- Forma del bloque: {"stores":{"<idTienda>":{"follow":[{"keyword":"…","why":"…"}],"unfollow":[{"keyword":"…","why":"…"}],"ficha":{"name":"…","subtitle":"…","keywords":"…","why":"…"}|null}},"competitors":[{"appId":"…","name":"…","why":"…"}]}
- El appId de un competidor es el número de su URL de la App Store (apps.apple.com/…/id<número>).
- Como mucho 10 \`follow\` por tienda. No repitas lo que ya se sigue ni lo rechazado; \`unfollow\` solo de keywords seguidas.
- Límites de la ficha: nombre 30, subtítulo 30 y keywords 100 caracteres. Las keywords van separadas por comas sin espacios y sin repetir palabras del nombre ni del subtítulo.
- Primera ejecución (una tienda sin keywords seguidas): parte de la ficha actual, de la documentación de marketing del repo y de los competidores que ya conozcas (propón solo los que puedas confirmar con su appId).
- Si no hay nada que proponer, dilo en el resumen y devuelve el bloque vacío: {"stores":{},"competitors":[]}`;

const cell = (v: number | null) => (v === null ? '—' : String(Math.round(v)));

function rankAround(obs: AsoObservation[], target: number): AsoObservation | null {
  let best: AsoObservation | null = null;
  for (const o of obs) {
    const d = Math.abs(Date.parse(o.takenAt) - target);
    if (d <= REF_TOLERANCE && (!best || d < Math.abs(Date.parse(best.takenAt) - target))) best = o;
  }
  return best;
}

export function asoContext(store: Store, project: ProjectConfig, fichas: Record<string, CurrentFicha>, now: Date): string {
  const aso = project.aso;
  if (!aso) return 'Este proyecto no tiene ASO configurado.';
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const parts: string[] = [`App de la App Store: ${aso.appId}`];

  for (const s of aso.stores) {
    const f = fichas[s.id];
    const lines: string[] = [`## Tienda ${s.id} (país ${s.country})`, '', '### Ficha actual'];
    if (!f) {
      lines.push('(ficha actual no disponible: no se pudo leer de la tienda ni del repo)');
    } else {
      const src = (v: string | null, o: string | null) => (v ? `${v} (${o ?? 'repo'})` : 'sin dato');
      lines.push(
        `- Nombre: ${src(f.name, f.sources.name)}`,
        `- Subtítulo: ${src(f.subtitle, f.sources.subtitle)}`,
        `- Keywords: ${src(f.keywords, f.sources.keywords)}`,
      );
    }

    lines.push('', '### Keywords seguidas');
    const kws = store.aso.listKeywords(project.id, s.id);
    if (kws.length === 0) {
      lines.push('No hay keywords seguidas: propón una lista inicial (ver «Primera ejecución» en las instrucciones).');
    } else {
      const words = f ? fichaWords(f) : null;
      lines.push('| keyword | popularidad | dificultad | puesto hoy | puesto hace 7 días | en la ficha |', '| --- | --- | --- | --- | --- | --- |');
      for (const k of kws) {
        const obs = store.aso.observations(k.id, new Date(now.getTime() - 9 * DAY).toISOString()).filter((o) => o.ok);
        const last = obs.at(-1) ?? null;
        const old = rankAround(obs, now.getTime() - 7 * DAY);
        const inF = words ? (inFicha(k.text, words) ? 'sí' : 'no') : '?';
        const today = last ? `${cell(last.rank)} (${localDay(last.takenAt)})` : '—';
        lines.push(`| ${k.text} | ${cell(last?.popularity ?? null)} | ${cell(last?.difficulty ?? null)} | ${today} | ${old && old !== last ? cell(old.rank) : '—'} | ${inF} |`);
      }
    }

    // Las 50 más nuevas (candidates viene de la más antigua a la más nueva).
    const cands = store.aso.candidates(project.id, s.id, weekAgo).slice(-MAX_CANDIDATES).reverse();
    lines.push('', '### Candidatas de los últimos 7 días');
    lines.push(...(cands.length ? cands.map((c) => `- ${c.text}`) : ['(ninguna)']));

    const rejected = store.aso.listProposals(project.id, 'rejected').filter((p) => p.storeId === s.id);
    lines.push('', '### Propuestas rechazadas (no las repitas)');
    lines.push(...(rejected.length ? rejected.map((p) => `- ${p.kind}: ${p.kind === 'ficha' ? JSON.stringify(p.payload) : String(p.payload.keyword ?? '')}`) : ['(ninguna)']));

    const changes: string[] = [];
    for (const c of store.aso.listCompetitors(project.id)) {
      const snaps = store.aso.competitorSnaps(c.id, s.id, 20);
      snaps.forEach((cur, i) => {
        const prev = snaps[i + 1];
        if (!prev || cur.takenAt < weekAgo) return;
        // Como en los avisos: un subtítulo null es «desconocido» y se compara con el último que sí se leyó.
        const prevSub = snaps.slice(i + 1).find((x) => x.subtitle !== null)?.subtitle ?? null;
        const diffs = [
          cur.name !== prev.name ? `nombre «${prev.name}» → «${cur.name}»` : null,
          cur.subtitle !== null && prevSub !== null && cur.subtitle !== prevSub ? `subtítulo «${prevSub}» → «${cur.subtitle}»` : null,
          cur.version !== prev.version && cur.version !== null && prev.version !== null ? `versión ${prev.version} → ${cur.version}` : null,
        ].filter(Boolean);
        if (diffs.length) changes.push(`- ${c.name} (${c.appId}), ${localDay(cur.takenAt)}: ${diffs.join('; ')}`);
      });
    }
    lines.push('', '### Cambios de competidores de los últimos 7 días');
    lines.push(...(changes.length ? changes : ['(ninguno)']));
    parts.push(lines.join('\n'));
  }

  const rejectedComps = store.aso.listProposals(project.id, 'rejected').filter((p) => p.storeId === null);
  parts.push(`## Competidores rechazados (no los repitas)\n${rejectedComps.length ? rejectedComps.map((p) => `- ${String(p.payload.name ?? '')} (${String(p.payload.appId ?? '')})`).join('\n') : '(ninguno)'}`);
  const comps = store.aso.listCompetitors(project.id);
  parts.push(`## Competidores vigilados\n${comps.length ? comps.map((c) => `- ${c.name} (${c.appId})`).join('\n') : '(ninguno)'}`);
  parts.push(ASO_INSTRUCTIONS);
  return parts.join('\n\n');
}
