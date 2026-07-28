// Deep-link a una nota como PATH REAL en la barra de direcciones (en vez de `?repo=&path=`).
//
// Esquema notas: `/<repo>/<path...>`
//   - el primer segmento es el repo;
//   - el resto (conservando los `/` de carpetas) es el path de la nota.
//   - cada segmento va `encodeURIComponent`, así espacios/acentos/`#`/`?` —y un `/` literal
//     dentro de un nombre, que queda como `%2F`— no rompen el split. Se decodifica por segmento.
//
// Esquema páginas de sistema: `/<slug>` (un solo segmento).
//   - NO colisiona con notas: parseNoteUrl exige ≥2 segmentos.
//   - parseSystemUrl lo resuelve ANTES que parseNoteUrl en el boot.
//
// Las funciones son puras (no tocan `window`/`history`) para poder testearlas y para que
// App.tsx (escribe) y useChannel.ts (lee en el boot) compartan exactamente el mismo formato.

import { pageFromSlug, type SystemPage } from "./systemPages.ts";

/** repo+path → pathname (`/<repo>/<seg>/<seg>…`). El caller le antepone el origin/agrega el query. */
export function noteUrl(repo: string, path: string): string {
  const encSegments = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  return `/${encodeURIComponent(repo)}/${encSegments(path)}`;
}

/** pathname → {repo, path}, o null si no es un deep-link de nota (raíz, un solo segmento, etc.). */
export function parseNoteUrl(pathname: string): { repo: string; path: string } | null {
  const segs = pathname.split("/").filter(Boolean);
  const [first, ...rest] = segs;
  if (!first || rest.length === 0) return null;
  try {
    const repo = decodeURIComponent(first);
    const path = rest.map(decodeURIComponent).join("/");
    if (!repo || !path) return null;
    return { repo, path };
  } catch {
    return null; // un `%xx` inválido en algún segmento → no es un deep-link válido
  }
}

/** SystemPage → pathname de un solo segmento (`/<slug>`). */
export function systemUrl(page: SystemPage): string {
  return `/${encodeURIComponent(page)}`;
}

/** pathname → SystemPage, o null si no es un deep-link de página de sistema.
 *  Solo resuelve rutas de un segmento que coincidan con un slug conocido.
 *  Llamar ANTES de parseNoteUrl (notas requieren ≥2 segmentos — no hay colisión,
 *  pero la cadena de prioridad queda clara). */
export function parseSystemUrl(pathname: string): SystemPage | null {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length !== 1) return null;
  try {
    const slug = decodeURIComponent(segs[0] ?? "");
    return pageFromSlug(slug);
  } catch {
    return null;
  }
}
