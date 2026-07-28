// Resolución NOMBRE→PATH para `viewer_open` (viewer.ts). El agente nombra una nota como
// la "ve" en su working copy, pero a veces inventa/aproxima un path que NO existe en la
// wiki (ej. pide "backlog" cuando la nota real es "backlog-ceibo.md"). Antes, viewer_open
// empujaba ese path crudo a la vista → la web mostraba "no encontré el archivo" y, como el
// path no coincidía con ninguna solapa abierta, tampoco enfocaba la que ya estaba. Acá
// resolvemos contra los archivos REALES del usuario: si hay match, abrimos el path real
// (que sí coincide con la solapa → enfoca); si no, devolvemos un error claro con las notas
// disponibles, en vez de abrir una nota vacía inexistente.
//
// Lógica PURA (sin red): recibe la lista de archivos por repo y decide. Testeable sola.

export interface RepoFiles {
  repo: string;
  /** Paths repo-relativos, ej. "projects/compras.md". */
  files: string[];
}

export interface NoteRef {
  repo: string;
  path: string;
}

export type NoteResolution =
  | { kind: "open"; repo: string; path: string }
  | { kind: "ambiguous"; candidates: NoteRef[] }
  | { kind: "none" };

/** Normaliza para comparación difusa: minúsculas, sin acentos, sin `.md`, y todo lo que no
 *  sea alfanumérico colapsado a UN espacio (los separadores `-`, `_`, ` `, `/` se vuelven
 *  equivalentes). Así "Backlog Save", "backlog-save" y "backlog_save.md" normalizan igual. */
function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // saca los acentos (combining marks) que dejó NFD
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** Tier de match entre la query (normalizada) y un archivo. Menor = mejor. 0 = sin match. */
function tierOf(qBase: string, qFull: string, file: string): number {
  const nBase = norm(basename(file));
  const nFull = norm(file);
  if (!qBase) return 0;
  // T1: nombre de nota exacto, o el path completo pedido coincide exacto.
  if (nBase === qBase || nFull === qFull) return 1;
  // T2: prefijo en cualquier dirección sobre el basename ("backlog" ↔ "backlog ceibo"),
  //     o el path real termina con lo pedido ("a/b/compras" cuando pedís "b/compras").
  if (nBase.startsWith(qBase) || qBase.startsWith(nBase) || nFull.endsWith(` ${qFull}`)) {
    return 2;
  }
  // T3: substring sobre el basename (último recurso).
  if (nBase.includes(qBase) || qBase.includes(nBase)) return 3;
  return 0;
}

function bestTierMatches(repos: RepoFiles[], qBase: string, qFull: string): NoteRef[] {
  let bestTier = Number.POSITIVE_INFINITY;
  let matches: NoteRef[] = [];
  for (const { repo, files } of repos) {
    for (const path of files) {
      const t = tierOf(qBase, qFull, path);
      if (t === 0) continue;
      if (t < bestTier) {
        bestTier = t;
        matches = [{ repo, path }];
      } else if (t === bestTier) {
        matches.push({ repo, path });
      }
    }
  }
  return matches;
}

/** Resuelve la nota que el agente quiere abrir contra los archivos reales del usuario.
 *
 *  - `requestedPath` vacío (el agente pasó sólo un nombre, que `parsePath` metió en `repo`):
 *    usamos `requestedRepo` como query y buscamos en TODAS las wikis.
 *  - `requestedPath` presente y `requestedRepo` es una wiki real: probamos exacto y luego
 *    fuzzy DENTRO de ese repo; si no hay match, caemos a todas las wikis (repo mal adivinado).
 *  - `requestedRepo` no es una wiki real: buscamos fuzzy en todas.
 *
 *  Devuelve `open` (1 match), `ambiguous` (varios en el mejor tier) o `none`. */
export function resolveNote(
  requestedRepo: string,
  requestedPath: string,
  repos: RepoFiles[],
): NoteResolution {
  const byName = new Map(repos.map((r) => [r.repo, r]));
  const named = byName.get(requestedRepo);

  // Match exacto del path crudo dentro del repo nombrado (con o sin `.md`).
  if (named && requestedPath) {
    const set = new Set(named.files);
    if (set.has(requestedPath)) return { kind: "open", repo: requestedRepo, path: requestedPath };
    const withMd = requestedPath.endsWith(".md") ? requestedPath : `${requestedPath}.md`;
    if (set.has(withMd)) return { kind: "open", repo: requestedRepo, path: withMd };
  }

  // Query difusa. Si no hubo path, el "nombre" vino en el repo (ej. parsePath("backlog")).
  const hasPath = requestedPath.length > 0;
  const qBase = norm(hasPath ? basename(requestedPath) : requestedRepo);
  const qFull = norm(hasPath ? requestedPath : requestedRepo);
  if (!qBase) return { kind: "none" };

  // Repos a buscar: primero el nombrado (si es real y hay path), luego todos.
  const searchOrder: RepoFiles[][] = hasPath && named ? [[named], repos] : [repos];
  for (const scope of searchOrder) {
    const matches = bestTierMatches(scope, qBase, qFull);
    if (matches.length === 1) {
      const m = matches[0];
      if (m) return { kind: "open", repo: m.repo, path: m.path };
    }
    if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
  }
  return { kind: "none" };
}
