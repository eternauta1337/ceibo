// Escritura versionada de notas (feature db F3a — ver wiki tecnico/features/db/contrato.md).
//
// Estas son las primitivas del CONTRATO de notas: escritura con optimistic concurrency por
// VERSIÓN ENTERA (reemplaza al blob sha de git) + historial canónico en `note_versions`
// (una fila por save, con autor y origen). En F3 los escritores (editor web, agente, REM)
// migran a esto y git pasa a ser un espejo de UNA vía.
//
// Diseño:
//   - `version` vive en `notes` (el índice de F1 se PROMUEVE a fuente de verdad: misma
//     tabla, ahora con historia). El reindex FTS va en la MISMA transacción (los triggers
//     external-content de F1 ya lo hacen); los vectores quedan dirty (embedded_at NULL) y
//     los levanta el loop async de siempre.
//   - Conflicto ⇒ el error lleva el estado ACTUAL (contenido + versión): el cliente hace
//     merge3 y reintenta sin un GET extra (misma UX que el rebase del editor, menos piezas).
//   - `note_versions` guarda la versión NUEVA en cada write (la historia completa queda
//     consultable; la fila 1 es la creación). Borrar/mover también dejan rastro (op).
//   - El espejo git (F3b) consume `note_versions.id` como cursor (mirrored_at NULL).

import type { Db } from "./index.ts";
import { noteTitleOf } from "./notes-index.ts";

export const NOTES_WRITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS note_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,            -- desnormalizado: la historia sobrevive al borrado de la nota
  path TEXT NOT NULL,            -- path al momento del write (un move deja el path nuevo)
  note_id INTEGER,               -- id de la fila en notes; NULL tras un delete (FK suelta a propósito)
  version INTEGER NOT NULL,      -- la versión que este write DEJÓ
  content TEXT NOT NULL,         -- contenido completo de esa versión ('' en delete)
  op TEXT NOT NULL CHECK (op IN ('create','edit','delete','move','archive','unarchive','import')),
  author_uid INTEGER,            -- quién (users.id); NULL = sistema (import/backfill)
  source TEXT,                   -- 'web' | 'agent' | 'rem' | 'batch' | 'import'
  moved_from TEXT,               -- op='move': el path anterior
  at TEXT NOT NULL DEFAULT (datetime('now')),
  mirrored_at TEXT               -- NULL = pendiente de exportar al espejo git (F3b)
);
CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions (repo, path, id);
CREATE INDEX IF NOT EXISTS idx_note_versions_pending ON note_versions (mirrored_at) WHERE mirrored_at IS NULL;
`;

/** Migración aditiva: la tabla `notes` nació en F1 (índice derivado) sin `version`.
 *  version=0 = "fila del reconciliador, sin historia todavía" — el primer write versionado
 *  la promueve (0 → 1). Idempotente; corre en openDb. */
export function ensureNotesVersionColumn(db: Db): void {
  const cols = db.prepare("PRAGMA table_info(notes)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "version")) {
    db.exec("ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
  }
}

/** Conflicto de escritura: lleva el estado actual para que el cliente haga merge3 y
 *  reintente — el contrato promete esto en vez de un 409 pelado. */
export class NoteConflictError extends Error {
  readonly currentContent: string | null; // null = la nota no existe (borrada en el medio)
  readonly currentVersion: number | null;
  constructor(repo: string, path: string, current: { content: string; version: number } | null) {
    super(
      current
        ? `conflicto en ${repo}/${path}: la nota va por la versión ${current.version}`
        : `conflicto en ${repo}/${path}: la nota ya no existe`,
    );
    this.name = "NoteConflictError";
    this.currentContent = current?.content ?? null;
    this.currentVersion = current?.version ?? null;
  }
}

export class NoteExistsError extends Error {
  constructor(repo: string, path: string) {
    super(`ya existe ${repo}/${path}`);
    this.name = "NoteExistsError";
  }
}

export interface WriteMeta {
  authorUid?: number;
  source?: "web" | "agent" | "rem" | "batch" | "import";
}

interface NoteRow {
  id: number;
  content: string;
  version: number;
}

function rowOf(db: Db, repo: string, path: string): NoteRow | undefined {
  return db.prepare("SELECT id, content, version FROM notes WHERE repo = ? AND path = ?").get(repo, path) as
    | NoteRow
    | undefined;
}

function recordVersion(
  db: Db,
  v: {
    repo: string;
    path: string;
    noteId: number | null;
    version: number;
    content: string;
    op: string;
    meta: WriteMeta;
    movedFrom?: string;
  },
): void {
  db.prepare(
    `INSERT INTO note_versions (repo, path, note_id, version, content, op, author_uid, source, moved_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    v.repo,
    v.path,
    v.noteId,
    v.version,
    v.content,
    v.op,
    v.meta.authorUid ?? null,
    v.meta.source ?? null,
    v.movedFrom ?? null,
  );
}

/** Crea una nota (falla NoteExistsError si ya está). Versión inicial = 1. */
export function createNote(
  db: Db,
  repo: string,
  path: string,
  content: string,
  meta: WriteMeta = {},
): { version: number } {
  const tx = db.transaction(() => {
    if (rowOf(db, repo, path)) throw new NoteExistsError(repo, path);
    const title = noteTitleOf(path, content);
    const info = db
      .prepare(
        `INSERT INTO notes (repo, path, title, content, blob_sha, version, embedded_at)
         VALUES (?, ?, ?, ?, '', 1, NULL)`,
      )
      .run(repo, path, title, content);
    recordVersion(db, {
      repo,
      path,
      noteId: Number(info.lastInsertRowid),
      version: 1,
      content,
      op: "create",
      meta,
    });
    return { version: 1 };
  });
  return tx();
}

/** Escribe una nota existente con check de versión. Conflicto ⇒ NoteConflictError con el
 *  estado actual (el cliente mergea y reintenta). `expectedVersion` es OBLIGATORIA: el
 *  contrato no tiene "pisá lo que haya" — eso fue la clase de bug que venimos a matar. */
export function writeNote(
  db: Db,
  repo: string,
  path: string,
  content: string,
  expectedVersion: number,
  meta: WriteMeta = {},
): { version: number } {
  const tx = db.transaction(() => {
    const row = rowOf(db, repo, path);
    if (!row) throw new NoteConflictError(repo, path, null);
    if (row.version !== expectedVersion) {
      throw new NoteConflictError(repo, path, { content: row.content, version: row.version });
    }
    const version = row.version + 1;
    db.prepare(
      `UPDATE notes SET content = ?, title = ?, version = ?, embedded_at = NULL,
       updated_at = datetime('now') WHERE id = ?`,
    ).run(content, noteTitleOf(path, content), version, row.id);
    recordVersion(db, { repo, path, noteId: row.id, version, content, op: "edit", meta });
    return { version };
  });
  return tx();
}

/** Borra con check de versión (misma semántica de conflicto que writeNote). La historia
 *  queda: note_versions conserva todas las versiones + la fila op='delete'. */
export function deleteNote(
  db: Db,
  repo: string,
  path: string,
  expectedVersion: number,
  meta: WriteMeta = {},
): void {
  const tx = db.transaction(() => {
    const row = rowOf(db, repo, path);
    if (!row) throw new NoteConflictError(repo, path, null);
    if (row.version !== expectedVersion) {
      throw new NoteConflictError(repo, path, { content: row.content, version: row.version });
    }
    db.prepare("UPDATE note_versions SET note_id = NULL WHERE note_id = ?").run(row.id);
    db.prepare("DELETE FROM notes WHERE id = ?").run(row.id); // chunks caen por cascade; FTS por trigger
    recordVersion(db, {
      repo,
      path,
      noteId: null,
      version: row.version + 1,
      content: "",
      op: "delete",
      meta,
    });
  });
  tx();
}

/** Mueve/renombra (incl. cross-wiki con permiso ya validado por el caller). Conserva la
 *  fila (note_id) ⇒ la historia y los vectores sobreviven; `newContent` opcional pisa el
 *  contenido en el mismo movimiento (rename de H1). */
export function moveNote(
  db: Db,
  from: { repo: string; path: string },
  to: { repo: string; path: string },
  expectedVersion: number,
  meta: WriteMeta = {},
  newContent?: string,
): { version: number } {
  const tx = db.transaction(() => {
    const row = rowOf(db, from.repo, from.path);
    if (!row) throw new NoteConflictError(from.repo, from.path, null);
    if (row.version !== expectedVersion) {
      throw new NoteConflictError(from.repo, from.path, { content: row.content, version: row.version });
    }
    if (rowOf(db, to.repo, to.path)) throw new NoteExistsError(to.repo, to.path);
    const content = newContent ?? row.content;
    const version = row.version + 1;
    db.prepare(
      `UPDATE notes SET repo = ?, path = ?, content = ?, title = ?, version = ?,
       embedded_at = CASE WHEN ? THEN NULL ELSE embedded_at END, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      to.repo,
      to.path,
      content,
      noteTitleOf(to.path, content),
      version,
      newContent !== undefined ? 1 : 0,
      row.id,
    );
    recordVersion(db, {
      repo: to.repo,
      path: to.path,
      noteId: row.id,
      version,
      content,
      op: "move",
      meta,
      movedFrom: `${from.repo}/${from.path}`,
    });
    // Move CROSS-WIKI: el repo ORIGEN también necesita su rastro (el espejo git de F3b
    // exporta por-repo; sin esta fila, el archivo viejo quedaría vivo en el git de origen).
    if (from.repo !== to.repo) {
      recordVersion(db, {
        repo: from.repo,
        path: from.path,
        noteId: null,
        version: row.version + 1,
        content: "",
        op: "delete",
        meta,
        movedFrom: `${from.repo}/${from.path}`,
      });
    }
    return { version };
  });
  return tx();
}

// --- Batch (cambios masivos del agente/REM) ---------------------------------

export type NoteBatchChange =
  | { op: "put"; path: string; content: string; expectedVersion?: number } // sin expectedVersion = create
  | { op: "delete"; path: string; expectedVersion: number }
  | { op: "move"; path: string; toPath: string; expectedVersion: number; newContent?: string };

export type NoteBatchResult = { ok: true } | { ok: false; conflictPaths: string[] };

/** Aplica un lote de cambios a UNA wiki, atómico: o entra todo o no entra nada (misma
 *  semántica que el commit(Change[]) del substrato git, con versiones en vez de shas).
 *  Los conflictos se juntan por-path y se devuelven TODOS (el cliente re-lee esos). */
export function batchNotes(
  db: Db,
  repo: string,
  changes: NoteBatchChange[],
  meta: WriteMeta = {},
): NoteBatchResult {
  const batchMeta: WriteMeta = { ...meta, source: meta.source ?? "batch" };
  const conflictPaths: string[] = [];
  const tx = db.transaction(() => {
    for (const c of changes) {
      try {
        if (c.op === "put") {
          if (c.expectedVersion === undefined) createNote(db, repo, c.path, c.content, batchMeta);
          else writeNote(db, repo, c.path, c.content, c.expectedVersion, batchMeta);
        } else if (c.op === "delete") {
          deleteNote(db, repo, c.path, c.expectedVersion, batchMeta);
        } else {
          moveNote(
            db,
            { repo, path: c.path },
            { repo, path: c.toPath },
            c.expectedVersion,
            batchMeta,
            c.newContent,
          );
        }
      } catch (e) {
        if (e instanceof NoteConflictError || e instanceof NoteExistsError) {
          conflictPaths.push(c.path);
        } else {
          throw e;
        }
      }
    }
    // Atómico: CUALQUIER conflicto revierte el lote entero (throw ⇒ rollback de la tx).
    if (conflictPaths.length > 0) throw new NoteConflictError(repo, conflictPaths.join(","), null);
  });
  try {
    tx();
    return { ok: true };
  } catch (e) {
    if (conflictPaths.length > 0) return { ok: false, conflictPaths };
    throw e;
  }
}

// --- Historia ----------------------------------------------------------------

export interface NoteVersionRow {
  id: number;
  version: number;
  op: string;
  authorUid: number | null;
  source: string | null;
  movedFrom: string | null;
  at: string;
}

export function noteHistory(db: Db, repo: string, path: string, limit = 50): NoteVersionRow[] {
  return db
    .prepare(
      `SELECT id, version, op, author_uid AS authorUid, source, moved_from AS movedFrom, at
       FROM note_versions WHERE repo = ? AND path = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(repo, path, limit) as NoteVersionRow[];
}

export function noteVersionContent(db: Db, repo: string, path: string, version: number): string | null {
  const row = db
    .prepare(
      "SELECT content FROM note_versions WHERE repo = ? AND path = ? AND version = ? ORDER BY id DESC LIMIT 1",
    )
    .get(repo, path, version) as { content: string } | undefined;
  return row?.content ?? null;
}

/** Versiones aún no exportadas al espejo git (F3b), en orden. El exporter las marca. */
export function versionsPendingMirror(
  db: Db,
  limit = 100,
): (NoteVersionRow & { repo: string; path: string; content: string })[] {
  return db
    .prepare(
      `SELECT id, repo, path, version, content, op, author_uid AS authorUid, source,
              moved_from AS movedFrom, at
       FROM note_versions WHERE mirrored_at IS NULL ORDER BY id LIMIT ?`,
    )
    .all(limit) as (NoteVersionRow & { repo: string; path: string; content: string })[];
}

export function markMirrored(db: Db, versionIds: number[]): void {
  const mark = db.prepare("UPDATE note_versions SET mirrored_at = datetime('now') WHERE id = ?");
  const tx = db.transaction(() => {
    for (const id of versionIds) mark.run(id);
  });
  tx();
}
