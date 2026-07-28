import { describe, expect, it } from "vitest";
import {
  latestWikiChangeId,
  openDb,
  pruneWikiChanges,
  recordWikiChange,
  recordWikiEdit,
  repoHasCommitSources,
  wikiChangesSince,
  wikiCommitSources,
} from "./index.ts";

// DB en memoria (sin mocks): el feed es SQLite puro, lo ejercitamos de verdad.
const freshDb = () => openDb(":memory:");

describe("wiki_changes feed (Fase 1b)", () => {
  it("registra y tailea por cursor ascendente", () => {
    const db = freshDb();
    const id1 = recordWikiChange(db, { repo: "demo-personal", ref: "sha1", paths: ["a.md"] });
    const id2 = recordWikiChange(db, { repo: "demo-ceibo", ref: "sha2", paths: ["b.md", "c.md"] });
    expect(id2).toBeGreaterThan(id1);

    const all = wikiChangesSince(db, 0);
    expect(all.map((c) => c.ref)).toEqual(["sha1", "sha2"]);
    expect(all[1]?.paths).toEqual(["b.md", "c.md"]); // paths round-trip por JSON

    // Tail desde id1 → sólo lo nuevo.
    expect(wikiChangesSince(db, id1).map((c) => c.ref)).toEqual(["sha2"]);
    expect(wikiChangesSince(db, id2)).toEqual([]);
    db.close();
  });

  it("filtra por repos", () => {
    const db = freshDb();
    recordWikiChange(db, { repo: "demo-personal", ref: "s1", paths: ["a.md"] });
    recordWikiChange(db, { repo: "demo-ceibo", ref: "s2", paths: ["b.md"] });
    recordWikiChange(db, { repo: "demo-personal", ref: "s3", paths: ["d.md"] });
    expect(wikiChangesSince(db, 0, ["demo-ceibo"]).map((c) => c.ref)).toEqual(["s2"]);
    expect(wikiChangesSince(db, 0, ["demo-personal"]).map((c) => c.ref)).toEqual(["s1", "s3"]);
    db.close();
  });

  it("latestWikiChangeId: 0 si vacío, último id si hay", () => {
    const db = freshDb();
    expect(latestWikiChangeId(db)).toBe(0);
    const id = recordWikiChange(db, { repo: "r", ref: "s", paths: [] });
    expect(latestWikiChangeId(db)).toBe(id);
    db.close();
  });

  it("guarda op por-path, source y userId; legacy (sólo paths) cae a op 'edit'", () => {
    const db = freshDb();
    recordWikiChange(db, {
      repo: "demo-personal",
      ref: "s1",
      entries: [
        { path: "recetas.md", op: "create" },
        { path: "viejo.md", op: "delete" },
      ],
      source: "web",
      userId: 7,
    });
    recordWikiChange(db, { repo: "demo-personal", ref: "s2", paths: ["legacy.md"] }); // forma legacy
    const all = wikiChangesSince(db, 0);
    expect(all[0]?.entries).toEqual([
      { path: "recetas.md", op: "create" },
      { path: "viejo.md", op: "delete" },
    ]);
    expect(all[0]?.source).toBe("web");
    expect(all[0]?.userId).toBe(7);
    expect(all[0]?.paths).toEqual(["recetas.md", "viejo.md"]); // compat: paths derivados
    // Legacy: sin entries explícitos → op 'edit', source/userId null.
    expect(all[1]?.entries).toEqual([{ path: "legacy.md", op: "edit" }]);
    expect(all[1]?.source).toBeNull();
    expect(all[1]?.userId).toBeNull();
    db.close();
  });

  describe("recordWikiEdit (coalescing del autosave)", () => {
    it("reusa la fila previa: misma nota, mismo user, dentro de la ventana", () => {
      const db = freshDb();
      const id1 = recordWikiEdit(db, { repo: "w", ref: "r1", path: "agenda.md", userId: 1 });
      const id2 = recordWikiEdit(db, { repo: "w", ref: "r2", path: "agenda.md", userId: 1 });
      expect(id2).toBe(id1); // mismo id → no insertó otra fila
      const all = wikiChangesSince(db, 0);
      expect(all).toHaveLength(1);
      expect(all[0]?.ref).toBe("r2"); // ref actualizado al último
      expect(all[0]?.entries).toEqual([{ path: "agenda.md", op: "edit" }]);
      db.close();
    });

    it("NO coalesce entre notas, usuarios distintos, o fuera de ventana", () => {
      const db = freshDb();
      const a = recordWikiEdit(db, { repo: "w", ref: "r1", path: "a.md", userId: 1 });
      const b = recordWikiEdit(db, { repo: "w", ref: "r2", path: "b.md", userId: 1 }); // otra nota
      const c = recordWikiEdit(db, { repo: "w", ref: "r3", path: "a.md", userId: 2 }); // otro user
      const d = recordWikiEdit(db, { repo: "w", ref: "r4", path: "a.md", userId: 1, windowSec: 0 }); // ventana 0
      expect(new Set([a, b, c, d]).size).toBe(4); // cuatro filas distintas
      expect(wikiChangesSince(db, 0)).toHaveLength(4);
      db.close();
    });

    it("no coalesce contra una fila que no sea una edición single-path", () => {
      const db = freshDb();
      // Un create previo sobre la misma nota NO debe ser reusado por una edición.
      recordWikiChange(db, {
        repo: "w",
        ref: "r1",
        entries: [{ path: "x.md", op: "create" }],
        userId: 1,
        source: "web",
      });
      const id = recordWikiEdit(db, { repo: "w", ref: "r2", path: "x.md", userId: 1 });
      const all = wikiChangesSince(db, 0);
      expect(all).toHaveLength(2);
      expect(all[1]?.id).toBe(id);
      expect(all[1]?.entries).toEqual([{ path: "x.md", op: "edit" }]);
      db.close();
    });
  });

  describe("wiki_commit_sources (sha → source permanente, lo consume el blame)", () => {
    it("recordWikiChange con source registra el sha; sin source no", () => {
      const db = freshDb();
      recordWikiChange(db, { repo: "w", ref: "s1", paths: ["a.md"], source: "agent", userId: 3 });
      recordWikiChange(db, { repo: "w", ref: "s2", paths: [] }); // watcher out-of-band: sin source
      const m = wikiCommitSources(db, "w", ["s1", "s2", "s3"]);
      expect(m.get("s1")).toBe("agent");
      expect(m.has("s2")).toBe(false); // origen desconocido → no aparece
      expect(m.has("s3")).toBe(false); // sha nunca visto
      expect(repoHasCommitSources(db, "w")).toBe(true);
      expect(repoHasCommitSources(db, "otra")).toBe(false);
      db.close();
    });

    it("recordWikiEdit coalesced: el feed reusa la fila pero CADA ref queda en sources", () => {
      const db = freshDb();
      recordWikiEdit(db, { repo: "w", ref: "r1", path: "agenda.md", userId: 1 });
      recordWikiEdit(db, { repo: "w", ref: "r2", path: "agenda.md", userId: 1 }); // coalesce (UPDATE ref)
      expect(wikiChangesSince(db, 0)).toHaveLength(1); // feed: una sola fila
      const m = wikiCommitSources(db, "w", ["r1", "r2"]);
      expect(m.get("r1")).toBe("web"); // el ref intermedio NO se pierde
      expect(m.get("r2")).toBe("web");
      db.close();
    });

    it("es por-repo y sobrevive al prune del feed", () => {
      const db = freshDb();
      recordWikiChange(db, { repo: "w", ref: "s1", paths: ["a.md"], source: "rem", userId: 1 });
      // Envejecer la fila del feed más allá de la ventana de 7 días y podar.
      db.prepare("UPDATE wiki_changes SET at = datetime('now', '-30 days')").run();
      pruneWikiChanges(db);
      expect(wikiChangesSince(db, 0)).toHaveLength(0); // el feed se podó
      expect(wikiCommitSources(db, "w", ["s1"]).get("s1")).toBe("rem"); // la fuente quedó
      expect(wikiCommitSources(db, "otra", ["s1"]).size).toBe(0); // otro repo no ve el sha
      db.close();
    });

    it("refs vacíos → Map vacío sin pegarle a la DB", () => {
      const db = freshDb();
      expect(wikiCommitSources(db, "w", []).size).toBe(0);
      db.close();
    });
  });
});
