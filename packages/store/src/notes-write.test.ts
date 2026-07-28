import { describe, expect, it } from "vitest";
import {
  batchNotes,
  createNote,
  deleteNote,
  getIndexedNote,
  markMirrored,
  moveNote,
  NoteConflictError,
  NoteExistsError,
  noteHistory,
  notesPendingEmbed,
  noteVersionContent,
  openDb,
  searchNotesLexical,
  upsertIndexedNote,
  versionsPendingMirror,
  writeNote,
} from "./index.ts";

const freshDb = () => openDb(":memory:");

describe("escritura versionada (feature db F3a)", () => {
  it("create → write → write: versiones 1,2,3 con historia completa y FTS al día", () => {
    const db = freshDb();
    expect(createNote(db, "w", "a.md", "# A\nuno", { authorUid: 7, source: "web" })).toEqual({ version: 1 });
    expect(writeNote(db, "w", "a.md", "# A\ndos", 1, { authorUid: 7, source: "web" })).toEqual({
      version: 2,
    });
    expect(writeNote(db, "w", "a.md", "# A\ntres", 2, { authorUid: 9, source: "agent" })).toEqual({
      version: 3,
    });

    const hist = noteHistory(db, "w", "a.md");
    expect(hist.map((h) => [h.version, h.op, h.authorUid])).toEqual([
      [3, "edit", 9],
      [2, "edit", 7],
      [1, "create", 7],
    ]);
    expect(noteVersionContent(db, "w", "a.md", 2)).toBe("# A\ndos");
    // El write reindexa FTS en la MISMA transacción (triggers) y re-encola vectores.
    expect(searchNotesLexical(db, ["w"], "tres")).toHaveLength(1);
    expect(searchNotesLexical(db, ["w"], "dos")).toHaveLength(0);
    expect(notesPendingEmbed(db, 10)).toHaveLength(1);
    db.close();
  });

  it("conflicto: versión vieja ⇒ NoteConflictError CON el estado actual (merge3 sin GET)", () => {
    const db = freshDb();
    createNote(db, "w", "a.md", "base");
    writeNote(db, "w", "a.md", "del otro", 1);
    try {
      writeNote(db, "w", "a.md", "mio", 1);
      expect.unreachable("debía conflictuar");
    } catch (e) {
      const c = e as NoteConflictError;
      expect(c).toBeInstanceOf(NoteConflictError);
      expect(c.currentContent).toBe("del otro");
      expect(c.currentVersion).toBe(2);
    }
    // Nada se escribió: sigue la versión 2 del otro.
    expect(getIndexedNote(db, "w", "a.md")?.content).toBe("del otro");
    db.close();
  });

  it("create sobre existente ⇒ NoteExistsError; write sobre inexistente ⇒ conflicto con current null", () => {
    const db = freshDb();
    createNote(db, "w", "a.md", "x");
    expect(() => createNote(db, "w", "a.md", "y")).toThrow(NoteExistsError);
    try {
      writeNote(db, "w", "borrada.md", "y", 1);
      expect.unreachable();
    } catch (e) {
      expect((e as NoteConflictError).currentContent).toBeNull();
    }
    db.close();
  });

  it("promoción de fila derivada (F1): el reconciliador la dejó en version 0 y el primer write la adopta", () => {
    const db = freshDb();
    upsertIndexedNote(db, { repo: "w", path: "vieja.md", content: "de git", blobSha: "sha" });
    expect(writeNote(db, "w", "vieja.md", "editada por contrato", 0)).toEqual({ version: 1 });
    expect(noteHistory(db, "w", "vieja.md")[0]?.op).toBe("edit");
    db.close();
  });

  it("delete deja rastro y la nota desaparece del índice; la historia sobrevive", () => {
    const db = freshDb();
    createNote(db, "w", "a.md", "contenido");
    deleteNote(db, "w", "a.md", 1, { authorUid: 7, source: "web" });
    expect(getIndexedNote(db, "w", "a.md")).toBeNull();
    expect(searchNotesLexical(db, ["w"], "contenido")).toHaveLength(0);
    const hist = noteHistory(db, "w", "a.md");
    expect(hist[0]?.op).toBe("delete");
    expect(noteVersionContent(db, "w", "a.md", 1)).toBe("contenido"); // recuperable (recall)
    db.close();
  });

  it("move conserva la identidad (historia y vectores) e impide pisar destino", () => {
    const db = freshDb();
    createNote(db, "w1", "vieja/ruta.md", "# T\ncuerpo");
    moveNote(db, { repo: "w1", path: "vieja/ruta.md" }, { repo: "w2", path: "nueva/ruta.md" }, 1, {
      source: "web",
    });

    expect(getIndexedNote(db, "w1", "vieja/ruta.md")).toBeNull();
    expect(getIndexedNote(db, "w2", "nueva/ruta.md")?.content).toBe("# T\ncuerpo");
    const hist = noteHistory(db, "w2", "nueva/ruta.md");
    expect(hist[0]?.movedFrom).toBe("w1/vieja/ruta.md");

    createNote(db, "w2", "ocupada.md", "x");
    expect(() =>
      moveNote(db, { repo: "w2", path: "nueva/ruta.md" }, { repo: "w2", path: "ocupada.md" }, 2),
    ).toThrow(NoteExistsError);
    db.close();
  });

  it("batch atómico: un conflicto revierte TODO y reporta todos los paths en conflicto", () => {
    const db = freshDb();
    createNote(db, "w", "a.md", "a1");
    createNote(db, "w", "b.md", "b1");

    const res = batchNotes(db, "w", [
      { op: "put", path: "nueva.md", content: "n" }, // válida
      { op: "put", path: "a.md", content: "a2", expectedVersion: 99 }, // conflicto
      { op: "delete", path: "b.md", expectedVersion: 99 }, // conflicto
    ]);
    expect(res).toEqual({ ok: false, conflictPaths: ["a.md", "b.md"] });
    // Rollback total: la válida tampoco entró.
    expect(getIndexedNote(db, "w", "nueva.md")).toBeNull();
    expect(getIndexedNote(db, "w", "a.md")?.content).toBe("a1");

    const ok = batchNotes(db, "w", [
      { op: "put", path: "nueva.md", content: "n" },
      { op: "put", path: "a.md", content: "a2", expectedVersion: 1 },
      { op: "move", path: "b.md", toPath: "c.md", expectedVersion: 1 },
    ]);
    expect(ok).toEqual({ ok: true });
    expect(getIndexedNote(db, "w", "c.md")?.content).toBe("b1");
    expect(noteHistory(db, "w", "a.md")[0]?.source).toBe("batch");
    db.close();
  });

  it("cursor del espejo (F3b): pendientes en orden, marcado idempotente", () => {
    const db = freshDb();
    createNote(db, "w", "a.md", "uno", { source: "web" });
    writeNote(db, "w", "a.md", "dos", 1, { source: "agent" });
    const pending = versionsPendingMirror(db);
    expect(pending.map((p) => [p.version, p.content])).toEqual([
      [1, "uno"],
      [2, "dos"],
    ]);
    markMirrored(
      db,
      pending.map((p) => p.id),
    );
    expect(versionsPendingMirror(db)).toEqual([]);
    db.close();
  });
});
