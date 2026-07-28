// Índice DERIVADO de notas (feature db, F1 — ver wiki tecnico/features/db/plan.md).
//
// Estas tablas son un ÍNDICE, no fuente de verdad: git sigue mandando. Se pueden dropear
// y reconstruir en cualquier momento (rebuild = backfill desde el substrato). Por eso:
//   - `notes` guarda el contenido + el blob sha de git (para saltear trabajo sin cambio);
//   - `notes_fts` (FTS5, external content) da búsqueda léxica — hoy eso es grep en la VM;
//   - `note_chunks` guarda los vectores de embeddings (BLOB f32 little-endian);
//   - `notes_index_meta` es el guard por wiki: hasta qué ref se indexó, con qué modelo de
//     embeddings, y el flag de rebuild forzado. Mismatch de modelo ⇒ re-embed, no re-fetch.
//
// El reconciliador que las llena vive en web-server (notes-indexer.ts): único proceso que
// ya mantiene `wiki_heads`. Acá sólo el schema + las operaciones, ejercitables con una DB
// en memoria.

import type { Db } from "./index.ts";

export const NOTES_INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS notes_index_meta (
  repo TEXT PRIMARY KEY,         -- nombre del repo (mismo formato que wiki_heads.repo)
  head_ref TEXT NOT NULL,        -- último commit sha indexado
  model_id TEXT,                 -- modelo de embeddings de los chunks vivos (NULL = sin vectores)
  reindex INTEGER NOT NULL DEFAULT 0, -- 1 = rebuild forzado en el próximo tick
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,           -- primer H1, o el nombre de archivo sin .md
  content TEXT NOT NULL,
  blob_sha TEXT NOT NULL,        -- blob sha de git: contenido idéntico ⇒ upsert no-op
  embedded_at TEXT,              -- NULL = chunks/vectores pendientes de (re)calcular
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo, path)
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, content, path UNINDEXED, repo UNINDEXED,
  content='notes', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- Triggers del patrón external-content: notes_fts se mantiene solo, en la misma transacción.
CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, title, content, path, repo)
  VALUES (new.id, new.title, new.content, new.path, new.repo);
END;
CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, content, path, repo)
  VALUES ('delete', old.id, old.title, old.content, old.path, old.repo);
END;
CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, content, path, repo)
  VALUES ('delete', old.id, old.title, old.content, old.path, old.repo);
  INSERT INTO notes_fts (rowid, title, content, path, repo)
  VALUES (new.id, new.title, new.content, new.path, new.repo);
END;

CREATE TABLE IF NOT EXISTS note_chunks (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,            -- el texto EXACTO que se embebió (título + fragmento)
  vector BLOB,                   -- f32 little-endian × dim del modelo; NULL = pendiente
  PRIMARY KEY (note_id, seq)
);
`;

// --- Meta / guard ----------------------------------------------------------

export interface NotesIndexMeta {
  repo: string;
  headRef: string;
  modelId: string | null;
  reindex: boolean;
}

export function getNotesIndexMeta(db: Db, repo: string): NotesIndexMeta | null {
  const row = db
    .prepare("SELECT repo, head_ref, model_id, reindex FROM notes_index_meta WHERE repo = ?")
    .get(repo) as { repo: string; head_ref: string; model_id: string | null; reindex: number } | undefined;
  if (!row) return null;
  return { repo: row.repo, headRef: row.head_ref, modelId: row.model_id, reindex: row.reindex === 1 };
}

export function setNotesIndexHead(db: Db, repo: string, headRef: string): void {
  db.prepare(
    `INSERT INTO notes_index_meta (repo, head_ref) VALUES (?, ?)
     ON CONFLICT(repo) DO UPDATE SET head_ref = excluded.head_ref, reindex = 0,
       updated_at = datetime('now')`,
  ).run(repo, headRef);
}

/** Marca el rebuild forzado: el próximo tick del reconciliador tira todo y re-backfillea. */
export function flagNotesReindex(db: Db, repo: string): void {
  db.prepare("UPDATE notes_index_meta SET reindex = 1, updated_at = datetime('now') WHERE repo = ?").run(
    repo,
  );
}

/** Guard de modelo: si los chunks vivos se calcularon con OTRO modelo, se tiran los vectores
 *  (no el contenido) y todas las notas del repo vuelven a "pendiente de embed". */
export function ensureNotesEmbedModel(db: Db, repo: string, modelId: string): boolean {
  const meta = getNotesIndexMeta(db, repo);
  if (!meta || meta.modelId === modelId) return false;
  if (meta.modelId === null) {
    // Sin vectores previos: fijar el modelo no tira nada.
    db.prepare("UPDATE notes_index_meta SET model_id = ? WHERE repo = ?").run(modelId, repo);
    return false;
  }
  const swap = db.transaction(() => {
    db.prepare("DELETE FROM note_chunks WHERE note_id IN (SELECT id FROM notes WHERE repo = ?)").run(repo);
    db.prepare("UPDATE notes SET embedded_at = NULL WHERE repo = ?").run(repo);
    db.prepare("UPDATE notes_index_meta SET model_id = ?, updated_at = datetime('now') WHERE repo = ?").run(
      modelId,
      repo,
    );
  });
  swap();
  return true;
}

// --- Notas (upsert/delete del reconciliador) -------------------------------

export interface IndexedNoteInput {
  repo: string;
  path: string;
  content: string;
  blobSha: string;
}

export function noteTitleOf(path: string, content: string): string {
  const h1 = content.match(/^#\s+(.+?)\s*$/m);
  if (h1?.[1]) return h1[1];
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

/** Upsert idempotente por blob sha: mismo blob ⇒ no toca la fila (los vectores viven).
 *  Blob distinto pero contenido IDÉNTICO (ej. el roundtrip write-DB → espejo git →
 *  reconciliador, donde el blob nace en git pero el texto ya estaba) ⇒ actualiza el blob
 *  sin invalidar los vectores. Contenido distinto ⇒ vuelve la nota a "pendiente de embed". */
export function upsertIndexedNote(db: Db, note: IndexedNoteInput): { changed: boolean } {
  const title = noteTitleOf(note.path, note.content);
  const info = db
    .prepare(
      `INSERT INTO notes (repo, path, title, content, blob_sha)
       VALUES (@repo, @path, @title, @content, @blobSha)
       ON CONFLICT(repo, path) DO UPDATE SET
         title = excluded.title, content = excluded.content, blob_sha = excluded.blob_sha,
         embedded_at = CASE WHEN excluded.content = notes.content THEN notes.embedded_at ELSE NULL END,
         updated_at = CASE WHEN excluded.content = notes.content THEN notes.updated_at ELSE datetime('now') END
       WHERE excluded.blob_sha <> notes.blob_sha`,
    )
    .run({ ...note, title });
  return { changed: info.changes > 0 };
}

export function deleteIndexedNote(db: Db, repo: string, path: string): void {
  db.prepare("DELETE FROM notes WHERE repo = ? AND path = ?").run(repo, path);
}

/** Tira TODO lo indexado de un repo (notas + chunks por cascade + meta). Rebuild = backfill. */
export function deleteIndexedRepo(db: Db, repo: string): void {
  const wipe = db.transaction(() => {
    db.prepare("DELETE FROM notes WHERE repo = ?").run(repo);
    db.prepare("DELETE FROM notes_index_meta WHERE repo = ?").run(repo);
  });
  wipe();
}

export interface IndexedNote {
  repo: string;
  path: string;
  title: string;
  content: string;
  updatedAt: string;
}

/** Una nota del índice, contenido completo (para el `notes_read` del MCP). */
export function getIndexedNote(db: Db, repo: string, path: string): IndexedNote | null {
  const row = db
    .prepare(
      "SELECT repo, path, title, content, updated_at AS updatedAt FROM notes WHERE repo = ? AND path = ?",
    )
    .get(repo, path) as IndexedNote | undefined;
  return row ?? null;
}

/** Paths que contienen un término (para sugerir cuando `notes_read` no encuentra exacto). */
export function findIndexedPaths(
  db: Db,
  repos: string[],
  term: string,
  limit = 10,
): { repo: string; path: string }[] {
  if (repos.length === 0) return [];
  const marks = repos.map(() => "?").join(",");
  return db
    .prepare(`SELECT repo, path FROM notes WHERE repo IN (${marks}) AND path LIKE ? ORDER BY path LIMIT ?`)
    .all(...repos, `%${term}%`, limit) as { repo: string; path: string }[];
}

export interface IndexedNoteRef {
  path: string;
  blobSha: string;
}

/** Qué hay indexado de un repo (para reconciliar contra un snapshot completo). */
export function indexedNoteRefs(db: Db, repo: string): IndexedNoteRef[] {
  return (
    db.prepare("SELECT path, blob_sha AS blobSha FROM notes WHERE repo = ? ORDER BY path").all(repo) as {
      path: string;
      blobSha: string;
    }[]
  ).map((r) => ({ path: r.path, blobSha: r.blobSha }));
}

/** Repos activos (no soft-borrados) — el set que el reconciliador mantiene indexado. */
export function allActiveRepoNames(db: Db): string[] {
  return (
    db.prepare("SELECT name FROM repos WHERE deleted_at IS NULL ORDER BY name").all() as { name: string }[]
  ).map((r) => r.name);
}

// --- Embeddings (cola de pendientes + chunks) ------------------------------

export interface NotePendingEmbed {
  id: number;
  repo: string;
  path: string;
  title: string;
  content: string;
}

export function notesPendingEmbed(db: Db, limit: number): NotePendingEmbed[] {
  return db
    .prepare(
      "SELECT id, repo, path, title, content FROM notes WHERE embedded_at IS NULL ORDER BY updated_at LIMIT ?",
    )
    .all(limit) as NotePendingEmbed[];
}

export interface NoteChunkInput {
  seq: number;
  text: string;
  vector: Buffer | null;
}

/** Reemplaza los chunks de una nota y la marca embebida — una transacción. */
export function saveNoteChunks(db: Db, noteId: number, chunks: NoteChunkInput[]): void {
  const save = db.transaction(() => {
    db.prepare("DELETE FROM note_chunks WHERE note_id = ?").run(noteId);
    const ins = db.prepare("INSERT INTO note_chunks (note_id, seq, text, vector) VALUES (?, ?, ?, ?)");
    for (const c of chunks) ins.run(noteId, c.seq, c.text, c.vector);
    db.prepare("UPDATE notes SET embedded_at = datetime('now') WHERE id = ?").run(noteId);
  });
  save();
}

export interface NoteChunkRow {
  noteId: number;
  repo: string;
  path: string;
  title: string;
  seq: number;
  text: string;
  vector: Buffer;
}

/** Chunks CON vector de un set de repos (la búsqueda semántica barre esto en memoria).
 *  Volumen esperado: miles de chunks por usuario — un full scan en SQLite es ms. */
export function noteChunksWithVectors(db: Db, repos: string[]): NoteChunkRow[] {
  if (repos.length === 0) return [];
  const marks = repos.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT c.note_id AS noteId, n.repo, n.path, n.title, c.seq, c.text, c.vector
       FROM note_chunks c JOIN notes n ON n.id = c.note_id
       WHERE c.vector IS NOT NULL AND n.repo IN (${marks})`,
    )
    .all(...repos) as NoteChunkRow[];
}

// --- Búsqueda léxica (FTS5) -------------------------------------------------

/** Query cruda del usuario → query FTS5 segura: cada token entre comillas (los operadores
 *  y la sintaxis de FTS5 no se interpretan), unidos por OR. OR y no AND a propósito: las
 *  queries reales son paráfrasis ("cuánto le cobramos a la inmobiliaria") y exigir TODAS
 *  las palabras mata el recall (medido: 0% hit@5 con AND sobre queries reales); bm25 ya
 *  rankea arriba a los que matchean más términos raros. */
export function ftsQueryFor(raw: string): string {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean);
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export interface LexicalHit {
  repo: string;
  path: string;
  title: string;
  snippet: string;
  rank: number;
}

export function searchNotesLexical(db: Db, repos: string[], query: string, limit = 20): LexicalHit[] {
  const fts = ftsQueryFor(query);
  if (!fts || repos.length === 0) return [];
  const marks = repos.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT repo, path, title, snippet(notes_fts, 1, '[', ']', '…', 14) AS snippet, rank
       FROM notes_fts
       WHERE notes_fts MATCH ? AND repo IN (${marks})
       ORDER BY rank LIMIT ?`,
    )
    .all(fts, ...repos, limit) as LexicalHit[];
}
