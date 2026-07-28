// Reconciliador del índice derivado de notas (feature db F1).
//
// Mantiene las tablas notes/notes_fts/note_chunks (store) al día contra el substrato git,
// SIN engancharse a cada call-site de escritura: compara `wiki_heads` (que ya mantienen el
// watcher único + los saves que pasan por este server) contra `notes_index_meta.head_ref`
// y trae el delta de GitHub. Un solo camino de código cubre backfill (meta ausente ⇒
// snapshot completo) e incremental (changesSince) — y es self-healing: cualquier duda se
// resuelve con rebuild (el índice es derivado, git manda).
//
// Los embeddings van aparte, en el mismo tick: notas con embedded_at NULL se chunkean y
// se mandan al bi-encoder (gpuhost). Sin EMBED_URL, o con gpuhost caído, el índice FTS sigue
// andando y los vectores quedan pendientes — degradación a léxico, nunca bloqueo.

import {
  allActiveRepoNames,
  chunkNote,
  type Db,
  deleteIndexedNote,
  deleteIndexedRepo,
  type Embedder,
  ensureNotesEmbedModel,
  flagNotesReindex,
  getNotesIndexMeta,
  getWikiHead,
  indexedNoteRefs,
  notesPendingEmbed,
  saveNoteChunks,
  setNotesIndexHead,
  upsertIndexedNote,
  vectorToBlob,
} from "@ceibo/store";
import type { WikiDelta, WikiSnapshot } from "@ceibo/wikis";

/** Lo que el reconciliador necesita del substrato (subset de Wikis, fakeable en tests). */
export interface NotesIndexerSubstrate {
  read(repo: string, ref?: string): Promise<WikiSnapshot>;
  changesSince(repo: string, baseRef: string): Promise<WikiDelta>;
}

export interface NotesIndexerOpts {
  db: Db;
  wikis: NotesIndexerSubstrate;
  embedder?: Embedder | null;
  pollMs?: number;
  /** Backfills completos por tick (acota el costo de API en el primer arranque). */
  maxBackfillsPerTick?: number;
  /** Notas embebidas por tick (acota el trabajo del bi-encoder por pasada). */
  maxEmbedsPerTick?: number;
  log?: (msg: string) => void;
}

/** ¿Este path es una nota indexable? (mismo criterio que la vista de notas: .md visibles) */
export function isIndexablePath(path: string): boolean {
  return path.endsWith(".md") && !path.startsWith(".") && !path.includes("/.");
}

export interface NotesIndexer {
  /** Una pasada completa (reconcile + embed). Serializada: si hay una en vuelo, no-op. */
  tick(): Promise<void>;
  stop(): void;
}

export function startNotesIndexer(opts: NotesIndexerOpts): NotesIndexer {
  const log = opts.log ?? (() => {});
  const maxBackfills = opts.maxBackfillsPerTick ?? 3;
  const maxEmbeds = opts.maxEmbedsPerTick ?? 8;
  let busy = false;
  let stopped = false;

  async function reconcileRepo(repo: string, backfillBudget: { left: number }): Promise<void> {
    const meta0 = getNotesIndexMeta(opts.db, repo);
    if (meta0?.reindex) {
      deleteIndexedRepo(opts.db, repo);
      log(`notes-index: rebuild forzado de ${repo}`);
    }
    const meta = meta0?.reindex ? null : meta0;

    if (!meta) {
      // Backfill: snapshot completo del HEAD real (no dependemos de wiki_heads para nacer).
      if (backfillBudget.left <= 0) return; // el próximo tick sigue
      backfillBudget.left--;
      const snap = await opts.wikis.read(repo);
      applySnapshot(repo, snap);
      log(`notes-index: backfill de ${repo} @ ${snap.ref.slice(0, 7)} (${snap.files.length} archivos)`);
      return;
    }

    // Incremental: sólo si el HEAD conocido avanzó respecto de lo indexado. wiki_heads lo
    // mantienen el watcher (wikis activas) + todo write local — para una wiki fría sin
    // watcher el índice queda al último head conocido, que para un índice derivado alcanza.
    const head = getWikiHead(opts.db, repo);
    if (!head || head === meta.headRef) return;
    try {
      const delta = await opts.wikis.changesSince(repo, meta.headRef);
      for (const f of delta.changed) {
        if (isIndexablePath(f.path))
          upsertIndexedNote(opts.db, { repo, path: f.path, content: f.content, blobSha: f.sha });
      }
      for (const p of delta.deleted) deleteIndexedNote(opts.db, repo, p);
      setNotesIndexHead(opts.db, repo, delta.ref);
    } catch (e) {
      // Base demasiado vieja / force-push / lo que sea: el delta no se pudo armar. El índice
      // es derivado ⇒ la salida segura es siempre rebuild en el próximo tick.
      flagNotesReindex(opts.db, repo);
      log(`notes-index: delta de ${repo} falló (${(e as Error).message}) → rebuild flageado`);
    }
  }

  function applySnapshot(repo: string, snap: WikiSnapshot): void {
    const inSnap = new Map(snap.files.filter((f) => isIndexablePath(f.path)).map((f) => [f.path, f]));
    for (const ref of indexedNoteRefs(opts.db, repo)) {
      if (!inSnap.has(ref.path)) deleteIndexedNote(opts.db, repo, ref.path);
    }
    for (const f of inSnap.values()) {
      upsertIndexedNote(opts.db, { repo, path: f.path, content: f.content, blobSha: f.sha });
    }
    setNotesIndexHead(opts.db, repo, snap.ref);
  }

  async function embedStep(): Promise<void> {
    const embedder = opts.embedder;
    if (!embedder) return;
    const pending = notesPendingEmbed(opts.db, maxEmbeds);
    if (pending.length === 0) return;
    for (const note of pending) {
      const chunks = chunkNote(note.content).map((text, seq) => ({
        seq,
        text:
          text.startsWith(`# ${note.title}`) || text.startsWith(note.title) ? text : `${note.title}\n${text}`,
      }));
      try {
        const vectors = chunks.length
          ? await embedder.embed(
              chunks.map((c) => c.text),
              "passage",
            )
          : [];
        saveNoteChunks(
          opts.db,
          note.id,
          chunks.map((c, i) => ({
            seq: c.seq,
            text: c.text,
            vector: vectorToBlob(vectors[i] as Float32Array),
          })),
        );
      } catch (e) {
        // Bi-encoder caído: los pendientes quedan pendientes; el próximo tick reintenta.
        log(
          `notes-index: embed de ${note.repo}/${note.path} falló (${(e as Error).message}) — reintenta luego`,
        );
        return;
      }
    }
  }

  async function tick(): Promise<void> {
    if (busy || stopped) return;
    busy = true;
    try {
      const budget = { left: maxBackfills };
      for (const repo of allActiveRepoNames(opts.db)) {
        if (stopped) break;
        await reconcileRepo(repo, budget).catch((e) =>
          log(`notes-index: reconcile ${repo}: ${(e as Error).message}`),
        );
        // Guard de modelo: chunks calculados con OTRO modelo ⇒ se tiran y re-encolan, aunque
        // no haya habido cambios de contenido (ej. reinicio con EMBED_MODEL nuevo).
        if (opts.embedder && ensureNotesEmbedModel(opts.db, repo, opts.embedder.modelId)) {
          log(`notes-index: modelo de embeddings cambió → re-embed de ${repo}`);
        }
      }
      await embedStep();
    } finally {
      busy = false;
    }
  }

  const timer = opts.pollMs === 0 ? null : setInterval(() => void tick(), opts.pollMs ?? 30_000);
  timer?.unref?.();

  return {
    tick,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
