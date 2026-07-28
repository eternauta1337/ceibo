// Operaciones de archivo del editor en MODO DB (feature db F3c) — la DB como fuente de
// verdad para el contenido de notas, detrás del flag NOTES_WRITE_MODE=db.
//
// El CORTE ES INVISIBLE PARA EL FRONT: el editor trata `sha` como un token opaco (lo
// guarda y lo devuelve en el próximo save), así que en modo DB ese token es la VERSIÓN
// entera stringificada. El 409 de conflicto y el GET de rebase funcionan igual que hoy
// — la saga draft/baseSha del front se borra después, en la limpieza, no acá.
//
// Transición suave: un draft viejo del front puede traer un blob sha de git como
// "versión esperada" → no parsea a entero → conflicto → el front re-GETea (recibe la
// versión real) y rebasea solo. Self-healing, sin migración de drafts.
//
// Pre-cutover (flag ON solo en dev): el reconciliador de F1 sigue corriendo y las
// escrituras EXTERNAS por git (push del editor local, worker) siguen entrando por él —
// convergen por contenido, pero NO dejan note_version (historia con huecos) y pueden
// pisar un write de DB más nuevo. Eso se cierra en el cutover (repo read-only). Es el
// costo aceptado de probar el modo en dev sin big-bang.

import {
  createNote,
  type Db,
  deleteNote,
  moveNote,
  NoteConflictError,
  NoteExistsError,
  recordWikiChange,
  recordWikiEdit,
  type WikiChangeEntry,
  writeNote,
} from "@ceibo/store";

export type FileOpResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 404 | 409; body: { error: string } };

const conflict = { ok: false as const, status: 409 as const, body: { error: "conflict" } };
const exists = { ok: false as const, status: 409 as const, body: { error: "exists" } };

/** El "sha" que viaja al front en modo DB = la versión entera stringificada. */
const shaOf = (version: number): string => String(version);
const versionOf = (sha: string): number | null => {
  const n = Number(sha);
  return Number.isInteger(n) && n >= 0 ? n : null; // un blob sha viejo no parsea → conflicto
};

function feed(db: Db, repo: string, version: number, entries: WikiChangeEntry[], userId: number): void {
  // El change-feed sigue alimentando el refresh de pestañas; `ref` pasa a ser la versión
  // (opaco para los consumidores del feed, que solo comparan/muestran).
  recordWikiChange(db, { repo, ref: `db-v${version}`, entries, source: "web", userId });
}

export function dbReadFile(
  db: Db,
  repo: string,
  path: string,
): FileOpResult<{ repo: string; content: string; sha: string; path: string }> {
  const row = db.prepare("SELECT content, version FROM notes WHERE repo = ? AND path = ?").get(repo, path) as
    | { content: string; version: number }
    | undefined;
  if (!row) return { ok: false, status: 404, body: { error: "not found" } };
  return { ok: true, value: { repo, content: row.content, sha: shaOf(row.version), path } };
}

export function dbPutFile(
  db: Db,
  repo: string,
  path: string,
  content: string,
  baseSha: string,
  userId: number,
): FileOpResult<{ sha: string }> {
  const expected = versionOf(baseSha);
  if (expected === null) return conflict; // sha de git legacy → el front re-GETea y rebasea
  try {
    const { version } = writeNote(db, repo, path, content, expected, { authorUid: userId, source: "web" });
    // Edición COALESCED al feed (misma semántica que recordWebEdit del path git).
    recordWikiEdit(db, { repo, ref: `db-v${version}`, path, userId, source: "web" });
    return { ok: true, value: { sha: shaOf(version) } };
  } catch (e) {
    if (e instanceof NoteConflictError) return conflict;
    throw e;
  }
}

export function dbCreateFile(
  db: Db,
  repo: string,
  path: string,
  content: string,
  userId: number,
): FileOpResult<{ sha: string; path: string }> {
  try {
    const { version } = createNote(db, repo, path, content, { authorUid: userId, source: "web" });
    feed(db, repo, version, [{ path, op: "create" }], userId);
    return { ok: true, value: { sha: shaOf(version), path } };
  } catch (e) {
    if (e instanceof NoteExistsError) return exists;
    throw e;
  }
}

export function dbDeleteFile(
  db: Db,
  repo: string,
  path: string,
  baseSha: string,
  userId: number,
): FileOpResult<Record<string, never>> {
  const expected = versionOf(baseSha);
  if (expected === null) return conflict;
  try {
    deleteNote(db, repo, path, expected, { authorUid: userId, source: "web" });
    feed(db, repo, expected + 1, [{ path, op: "delete" }], userId);
    return { ok: true, value: {} };
  } catch (e) {
    if (e instanceof NoteConflictError) return conflict;
    throw e;
  }
}

export function dbMoveFile(
  db: Db,
  from: { repo: string; path: string },
  to: { repo: string; path: string },
  baseSha: string,
  userId: number,
  newContent?: string,
): FileOpResult<{ sha: string; path: string }> {
  const expected = versionOf(baseSha);
  if (expected === null) return conflict;
  try {
    const { version } = moveNote(db, from, to, expected, { authorUid: userId, source: "web" }, newContent);
    feed(db, to.repo, version, [{ path: to.path, op: "move" }], userId);
    if (from.repo !== to.repo) feed(db, from.repo, version, [{ path: from.path, op: "delete" }], userId);
    return { ok: true, value: { sha: shaOf(version), path: to.path } };
  } catch (e) {
    if (e instanceof NoteConflictError) return conflict;
    if (e instanceof NoteExistsError) return exists;
    throw e;
  }
}
