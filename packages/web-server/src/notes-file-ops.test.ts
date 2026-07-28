import { createNote, noteHistory, openDb, upsertIndexedNote, wikiChangesSince } from "@ceibo/store";
import { describe, expect, it } from "vitest";
import { dbCreateFile, dbDeleteFile, dbMoveFile, dbPutFile, dbReadFile } from "./notes-file-ops.ts";

const freshDb = () => openDb(":memory:");

describe("file-ops en modo DB (feature db F3c) — el protocolo del editor, versión como sha opaco", () => {
  it("create → read → put → read: el sha viaja como versión stringificada", () => {
    const db = freshDb();
    const c = dbCreateFile(db, "w", "a.md", "hola", 7);
    expect(c).toEqual({ ok: true, value: { sha: "1", path: "a.md" } });

    const r1 = dbReadFile(db, "w", "a.md");
    expect(r1).toEqual({ ok: true, value: { repo: "w", content: "hola", sha: "1", path: "a.md" } });

    const p = dbPutFile(db, "w", "a.md", "hola v2", "1", 7);
    expect(p).toEqual({ ok: true, value: { sha: "2" } });
    expect(dbReadFile(db, "w", "a.md")).toMatchObject({ ok: true, value: { content: "hola v2", sha: "2" } });
    // Autoría real en la historia.
    expect(noteHistory(db, "w", "a.md")[0]).toMatchObject({ version: 2, authorUid: 7, source: "web" });
    db.close();
  });

  it("conflicto y exists → los MISMOS status/body que el path git (el front no distingue)", () => {
    const db = freshDb();
    dbCreateFile(db, "w", "a.md", "x", 1);
    dbPutFile(db, "w", "a.md", "y", "1", 1); // → v2
    expect(dbPutFile(db, "w", "a.md", "z", "1", 1)).toEqual({
      ok: false,
      status: 409,
      body: { error: "conflict" },
    });
    expect(dbCreateFile(db, "w", "a.md", "", 1)).toEqual({
      ok: false,
      status: 409,
      body: { error: "exists" },
    });
    expect(dbReadFile(db, "w", "nada.md")).toMatchObject({ ok: false, status: 404 });
    db.close();
  });

  it("transición: un draft con blob sha de git (no numérico) NO pisa nada — conflicto y a rebasear", () => {
    const db = freshDb();
    dbCreateFile(db, "w", "a.md", "x", 1);
    const r = dbPutFile(db, "w", "a.md", "pisada", "ab12cd34ef", 1);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(dbReadFile(db, "w", "a.md")).toMatchObject({ ok: true, value: { content: "x" } });
    db.close();
  });

  it("promoción suave: nota indexada por el reconciliador (version 0) se edita con baseSha '0'", () => {
    const db = freshDb();
    upsertIndexedNote(db, { repo: "w", path: "vieja.md", content: "de git", blobSha: "sha" });
    expect(dbReadFile(db, "w", "vieja.md")).toMatchObject({ ok: true, value: { sha: "0" } });
    expect(dbPutFile(db, "w", "vieja.md", "editada", "0", 7)).toEqual({ ok: true, value: { sha: "1" } });
    db.close();
  });

  it("delete y move alimentan el change-feed (refresh de pestañas) y respetan versión", () => {
    const db = freshDb();
    dbCreateFile(db, "w", "a.md", "x", 7);
    dbCreateFile(db, "w2", "b.md", "y", 7);
    const before = wikiChangesSince(db, 0).length;

    expect(dbMoveFile(db, { repo: "w", path: "a.md" }, { repo: "w2", path: "a2.md" }, "1", 7)).toMatchObject({
      ok: true,
      value: { path: "a2.md" },
    });
    expect(dbDeleteFile(db, "w2", "b.md", "1", 7)).toEqual({ ok: true, value: {} });
    expect(dbDeleteFile(db, "w2", "b.md", "1", 7)).toMatchObject({ ok: false, status: 409 }); // ya no está

    const feed = wikiChangesSince(db, 0).slice(before);
    expect(feed.length).toBeGreaterThanOrEqual(3); // move (destino) + delete (origen cross) + delete
    db.close();
  });

  it("el PUT registra la edición coalesced (una fila por ráfaga de autosave, no una por save)", () => {
    const db = freshDb();
    createNote(db, "w", "a.md", "v1", { authorUid: 7 });
    dbPutFile(db, "w", "a.md", "v2", "1", 7);
    dbPutFile(db, "w", "a.md", "v3", "2", 7);
    dbPutFile(db, "w", "a.md", "v4", "3", 7);
    const edits = wikiChangesSince(db, 0).filter((c) => c.source === "web");
    expect(edits).toHaveLength(1); // coalesced
    db.close();
  });
});
