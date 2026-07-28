// Archivar una nota desde la web (Explorer): la BORRA de la wiki y la indexa en el
// `_archivado.md` de su carpeta, en UN commit. Mismo modelo que usa el agente (archivado por
// historia): el contenido sale de la working copy pero vive en la historia de git, recuperable
// con `recall` / `search-archived`. Reemplaza el viejo "mover a una carpeta archivado/".

import type { Change, GitAuthor, Wikis } from "@ceibo/wikis";
import { ARCHIVE_MANIFEST, isArchiveManifest } from "@ceibo/wikis";

// Nombre con el que ESCRIBIMOS manifests nuevos (`.archived.md`). En DETECCIÓN (al escanear una
// carpeta que se archiva) reconocemos también el legacy `_archivado.md` vía `isArchiveManifest`.
const MANIFEST = ARCHIVE_MANIFEST;
const HEADER =
  "# Archivado\n\n<!-- Índice de notas archivadas de este workspace. Las notas viven en la historia de git (recuperables con el agente: `recall` / `search-archived`). -->\n";

function dirOf(p: string): string {
  const clean = p.replace(/^\/+/, "");
  const slash = clean.lastIndexOf("/");
  return slash === -1 ? "" : clean.slice(0, slash);
}

/** Manifest de archivado VIGENTE en `dir`: prefiere el `.archived.md` nuevo, si no el legacy
 *  `_archivado.md`, así seguimos agregando al que ya existe (no partimos el índice en dos durante
 *  la transición). Si no hay ninguno, devuelve el path nuevo con `content:null` (lo crea el caller
 *  con HEADER). Los archivos viejos se consolidan con `ceibo repo migrate-archive`. */
async function resolveManifest(
  wikis: Wikis,
  repo: string,
  dir: string,
): Promise<{ path: string; content: string | null }> {
  const newPath = dir ? `${dir}/${ARCHIVE_MANIFEST}` : ARCHIVE_MANIFEST;
  for (const path of [newPath, dir ? `${dir}/_archivado.md` : "_archivado.md"]) {
    try {
      const f = await wikis.getFile(repo, path);
      return { path, content: f.content };
    } catch {
      /* no existe ese nombre — probamos el siguiente */
    }
  }
  return { path: newPath, content: null };
}

function stripFront(c: string): string {
  if (c.startsWith("---")) {
    const end = c.indexOf("\n---", 3);
    if (end !== -1) {
      const nl = c.indexOf("\n", end + 1);
      return nl === -1 ? "" : c.slice(nl + 1);
    }
  }
  return c;
}

function preview(content: string): string {
  for (const ln of stripFront(content).split("\n")) {
    const t = ln.trim();
    if (!t || /^#/.test(t) || /^[-*_]{3,}$/.test(t) || /^!\[/.test(t)) continue;
    return t.replace(/[[\]]/g, "").replace(/\s+/g, " ").slice(0, 80);
  }
  return "";
}

/** Línea de índice para una nota archivada. `link` es relativo a la carpeta del manifest
 *  (searchArchived resuelve `dir(manifest)/link`), puede tener subcarpetas. */
function entryLine(link: string, content: string): string {
  const basename = link.split("/").pop() ?? link;
  const title = basename.replace(/\.md$/, "");
  const p = preview(content);
  return `- [${title}](${link})${p ? ` — ${p}` : ""}`;
}

/** El `_archivado.md` de la carpeta de la nota + la línea a agregarle. El link es el basename
 *  (la nota vivía en la misma carpeta que su manifest), así resuelve al path borrado que
 *  `recall`/`search-archived` buscan en la historia. */
export function archiveEntry(path: string, content: string): { manifestPath: string; line: string } {
  const clean = path.replace(/^\/+/, "");
  const slash = clean.lastIndexOf("/");
  const dir = slash === -1 ? "" : clean.slice(0, slash);
  const basename = slash === -1 ? clean : clean.slice(slash + 1);
  const manifestPath = dir ? `${dir}/${MANIFEST}` : MANIFEST;
  return { manifestPath, line: entryLine(basename, content) };
}

export type ArchiveResult = { ok: true; manifestPath: string } | { ok: false; conflict: true };

/** Archiva una nota: borra la nota + agrega/crea su entrada en el `_archivado.md` de la carpeta,
 *  en un commit. `baseSha` es el blob sha que el cliente cree estar archivando (no se pisa una
 *  edición concurrente). Devuelve conflict si la nota cambió desde `baseSha`. */
export async function archiveNote(
  wikis: Wikis,
  repo: string,
  path: string,
  baseSha: string,
  handle: string,
  author?: GitAuthor,
): Promise<ArchiveResult> {
  const note = await wikis.getFile(repo, path);
  if (note.sha !== baseSha) return { ok: false, conflict: true };
  const { line } = archiveEntry(note.path, note.content);
  // Manifest VIGENTE de la carpeta (nuevo o legacy) → le agregamos; si no hay, lo creamos `.archived.md`.
  const m = await resolveManifest(wikis, repo, dirOf(note.path));
  const manifestPath = m.path;
  const manifest =
    m.content !== null ? `${m.content.replace(/\n+$/, "")}\n${line}\n` : `${HEADER}\n${line}\n`;
  const head = await wikis.headSha(repo);
  const changes: Change[] = [
    { op: "delete", path: note.path },
    { op: "put", path: manifestPath, content: manifest },
  ];
  const r = await wikis.commit(repo, head, changes, `🗃️ archivar ${note.path} — ${handle} (web)`, author);
  return r.ok ? { ok: true, manifestPath } : { ok: false, conflict: true };
}

export type ArchiveFolderResult =
  | { ok: true; manifestPath: string; archived: string[] }
  | { ok: false; conflict: true };

/** Archiva una carpeta ENTERA en un commit: borra TODO lo que vive bajo su prefijo (notas,
 *  `_index.md`, `_archivado.md`, assets) y agrega las entradas de índice al `_archivado.md`
 *  de la carpeta PADRE — nunca adentro de la carpeta que se está borrando.
 *
 *  Esto arregla el zombie del archivado por-nota: archivar nota-a-nota escribía el manifest
 *  ADENTRO de la carpeta, así que la carpeta "borrada" renacía anclada por su `_archivado.md`
 *  (y como los índices se saltean al archivar, nunca más se podía borrar).
 *
 *  Las entradas de manifests que ya vivían adentro (incl. subcarpetas) se migran al manifest
 *  del padre re-prefijando el link (`nota.md` → `carpeta/nota.md`), así `recall` /
 *  `search-archived` — que resuelven links relativos a la carpeta del manifest — siguen
 *  encontrando los paths borrados en la historia. */
export async function archiveFolder(
  wikis: Wikis,
  repo: string,
  folder: string,
  handle: string,
  author?: GitAuthor,
): Promise<ArchiveFolderResult> {
  const clean = folder.replace(/^\/+/, "").replace(/\/+$/, "");
  const slash = clean.lastIndexOf("/");
  const parentDir = slash === -1 ? "" : clean.slice(0, slash);
  const manifestPath = parentDir ? `${parentDir}/${MANIFEST}` : MANIFEST;
  const prefix = `${clean}/`;
  const inside = (await wikis.listFiles(repo)).filter((f) => f.startsWith(prefix));
  if (inside.length === 0) return { ok: true, manifestPath, archived: [] }; // ya no existe
  const baseOf = (p: string) => p.split("/").pop() ?? p;
  const notes = inside.filter(
    (p) => p.endsWith(".md") && baseOf(p) !== "_index.md" && !isArchiveManifest(baseOf(p)),
  );
  const innerManifests = inside.filter((p) => isArchiveManifest(baseOf(p)));
  // Path → link relativo a la carpeta del manifest del padre (`tecnico/x/n.md` → `x/n.md`).
  const rel = (p: string) => (parentDir ? p.slice(parentDir.length + 1) : p);
  // Contenidos (previews + entradas a migrar) en una sola pasada.
  const snap = await wikis.read(repo, undefined, [...notes, ...innerManifests]);
  const byPath = new Map(snap.files.map((f) => [f.path, f.content]));
  const lines: string[] = notes.map((p) => entryLine(rel(p), byPath.get(p) ?? ""));
  for (const m of innerManifests) {
    const mdir = m.slice(0, m.lastIndexOf("/"));
    for (const ln of (byPath.get(m) ?? "").split("\n")) {
      const link = ln.match(/^\s*- \[[^\]]*\]\(([^)]+\.md)\)/)?.[1];
      if (!link) continue;
      const target = link.replace(/^\.\//, "");
      lines.push(ln.trim().replace(`(${link})`, `(${rel(`${mdir}/${target}`)})`));
    }
  }
  const changes: Change[] = inside.map((p) => ({ op: "delete", path: p }));
  // Manifest del PADRE vigente (nuevo o legacy) → le agregamos; si no hay, lo crea `.archived.md`.
  let writeManifestPath = manifestPath;
  if (lines.length > 0) {
    const m = await resolveManifest(wikis, repo, parentDir);
    writeManifestPath = m.path;
    const manifest =
      m.content !== null
        ? `${m.content.replace(/\n+$/, "")}\n${lines.join("\n")}\n`
        : `${HEADER}\n${lines.join("\n")}\n`;
    changes.push({ op: "put", path: writeManifestPath, content: manifest });
  }
  const head = await wikis.headSha(repo);
  const r = await wikis.commit(repo, head, changes, `🗃️ archivar carpeta ${clean}/ — ${handle} (web)`, author);
  return r.ok
    ? { ok: true, manifestPath: writeManifestPath, archived: notes }
    : { ok: false, conflict: true };
}
