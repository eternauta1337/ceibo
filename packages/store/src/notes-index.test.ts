import { describe, expect, it } from "vitest";
import {
  blobToVector,
  deleteIndexedNote,
  deleteIndexedRepo,
  ensureNotesEmbedModel,
  flagNotesReindex,
  ftsQueryFor,
  getNotesIndexMeta,
  indexedNoteRefs,
  noteChunksWithVectors,
  notesPendingEmbed,
  noteTitleOf,
  openDb,
  saveNoteChunks,
  searchNotesLexical,
  setNotesIndexHead,
  upsertIndexedNote,
  vectorToBlob,
} from "./index.ts";

// DB en memoria, sin mocks: el índice es SQLite puro (FTS5 incluido), lo ejercitamos de verdad.
const freshDb = () => openDb(":memory:");

describe("notes index (feature db F1)", () => {
  it("upsert idempotente por blob sha: mismo blob no toca, blob nuevo re-encola embed", () => {
    const db = freshDb();
    const r1 = upsertIndexedNote(db, { repo: "w", path: "a.md", content: "# Hola\ntexto", blobSha: "s1" });
    expect(r1.changed).toBe(true);

    const note = notesPendingEmbed(db, 10)[0];
    expect(note?.title).toBe("Hola");
    saveNoteChunks(db, note!.id, [{ seq: 0, text: "Hola\ntexto", vector: vectorToBlob([1, 0]) }]);
    expect(notesPendingEmbed(db, 10)).toEqual([]); // embebida

    // Mismo blob → no-op: sigue embebida.
    expect(
      upsertIndexedNote(db, { repo: "w", path: "a.md", content: "# Hola\ntexto", blobSha: "s1" }).changed,
    ).toBe(false);
    expect(notesPendingEmbed(db, 10)).toEqual([]);

    // Blob nuevo → contenido actualizado y vuelve a pendiente.
    expect(
      upsertIndexedNote(db, { repo: "w", path: "a.md", content: "# Chau\notro", blobSha: "s2" }).changed,
    ).toBe(true);
    expect(notesPendingEmbed(db, 10).map((n) => n.title)).toEqual(["Chau"]);
    db.close();
  });

  it("FTS: busca con acentos/case, filtra por repo, y el delete la saca del índice", () => {
    const db = freshDb();
    upsertIndexedNote(db, {
      repo: "w1",
      path: "recetas/pan.md",
      content: "# Pan casero\nmasa madre y fermentación",
      blobSha: "a",
    });
    upsertIndexedNote(db, {
      repo: "w2",
      path: "notas/pan2.md",
      content: "# Otro pan\nfermentación rápida",
      blobSha: "b",
    });

    // remove_diacritics: "fermentacion" sin tilde matchea.
    const hits = searchNotesLexical(db, ["w1", "w2"], "fermentacion");
    expect(hits.map((h) => h.repo).sort()).toEqual(["w1", "w2"]);
    expect(hits[0]?.snippet).toContain("[");

    // Scoping por repo: sólo w1.
    expect(searchNotesLexical(db, ["w1"], "fermentacion").map((h) => h.path)).toEqual(["recetas/pan.md"]);

    // Delete → fuera del FTS (triggers external-content).
    deleteIndexedNote(db, "w1", "recetas/pan.md");
    expect(searchNotesLexical(db, ["w1", "w2"], "masa madre")).toEqual([]);
    db.close();
  });

  it("ftsQueryFor neutraliza sintaxis FTS5 (operadores, comillas, columnas)", () => {
    const db = freshDb();
    upsertIndexedNote(db, { repo: "w", path: "a.md", content: "notas AND OR NOT near", blobSha: "x" });
    // Nada de esto debe tirar error de sintaxis de FTS5:
    for (const q of ["pan AND agua", '"comillas', "col:algo", "a*b (x)", "  ", "NEAR(a b)"]) {
      expect(() => searchNotesLexical(db, ["w"], q)).not.toThrow();
    }
    expect(ftsQueryFor('pan "agua')).toBe('"pan" OR "agua"');
    expect(ftsQueryFor("   ")).toBe("");
    db.close();
  });

  it("chunks: roundtrip de vectores f32, cascade al borrar la nota, scan por repos", () => {
    const db = freshDb();
    upsertIndexedNote(db, { repo: "w", path: "a.md", content: "algo", blobSha: "s" });
    const note = notesPendingEmbed(db, 1)[0]!;
    const vec = Float32Array.from({ length: 768 }, (_, i) => Math.sin(i));
    saveNoteChunks(db, note.id, [
      { seq: 0, text: "t0", vector: vectorToBlob(vec) },
      { seq: 1, text: "t1", vector: null }, // pendiente puntual
    ]);

    const rows = noteChunksWithVectors(db, ["w"]);
    expect(rows).toHaveLength(1); // sólo el chunk CON vector
    const back = blobToVector(rows[0]!.vector);
    expect(back).toHaveLength(768);
    expect(back[5]).toBeCloseTo(Math.sin(5), 6);

    deleteIndexedNote(db, "w", "a.md");
    expect(noteChunksWithVectors(db, ["w"])).toEqual([]); // FK cascade
    db.close();
  });

  it("meta: head/reindex/rebuild y guard de modelo de embeddings", () => {
    const db = freshDb();
    upsertIndexedNote(db, { repo: "w", path: "a.md", content: "algo", blobSha: "s" });
    setNotesIndexHead(db, "w", "head1");
    expect(getNotesIndexMeta(db, "w")).toMatchObject({ headRef: "head1", modelId: null, reindex: false });

    // Primer embed fija el modelo sin tirar nada.
    const note = notesPendingEmbed(db, 1)[0]!;
    expect(ensureNotesEmbedModel(db, "w", "model-A")).toBe(false);
    saveNoteChunks(db, note.id, [{ seq: 0, text: "t", vector: vectorToBlob([1]) }]);
    expect(getNotesIndexMeta(db, "w")?.modelId).toBe("model-A");

    // Mismo modelo → no-op. Modelo nuevo → tira vectores y re-encola.
    expect(ensureNotesEmbedModel(db, "w", "model-A")).toBe(false);
    expect(ensureNotesEmbedModel(db, "w", "model-B")).toBe(true);
    expect(noteChunksWithVectors(db, ["w"])).toEqual([]);
    expect(notesPendingEmbed(db, 10)).toHaveLength(1);
    expect(getNotesIndexMeta(db, "w")?.modelId).toBe("model-B");

    // Reindex flag + wipe total.
    flagNotesReindex(db, "w");
    expect(getNotesIndexMeta(db, "w")?.reindex).toBe(true);
    setNotesIndexHead(db, "w", "head2"); // reconciliar limpia el flag
    expect(getNotesIndexMeta(db, "w")).toMatchObject({ headRef: "head2", reindex: false });
    deleteIndexedRepo(db, "w");
    expect(getNotesIndexMeta(db, "w")).toBeNull();
    expect(indexedNoteRefs(db, "w")).toEqual([]);
    db.close();
  });

  it("noteTitleOf: H1 si hay, nombre de archivo si no", () => {
    expect(noteTitleOf("dir/nota.md", "# Título real\ncuerpo")).toBe("Título real");
    expect(noteTitleOf("dir/mi-nota.md", "sin heading")).toBe("mi-nota");
    expect(noteTitleOf("dir/x.md", "## no es h1\n# H1 tardío")).toBe("H1 tardío");
  });
});
