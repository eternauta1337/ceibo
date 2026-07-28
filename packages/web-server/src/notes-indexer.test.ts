import {
  addRepo,
  blobToVector,
  type Embedder,
  flagNotesReindex,
  getNotesIndexMeta,
  indexedNoteRefs,
  noteChunksWithVectors,
  notesPendingEmbed,
  openDb,
  searchNotesLexical,
  setWikiHead,
} from "@ceibo/store";
import type { WikiDelta, WikiSnapshot } from "@ceibo/wikis";
import { describe, expect, it, vi } from "vitest";
import { isIndexablePath, type NotesIndexerSubstrate, startNotesIndexer } from "./notes-indexer.ts";

// Substrato fake en memoria: un "repo git" = map path→content, con ref y deltas armados a mano.
function fakeSubstrate(
  repos: Record<string, { ref: string; files: Record<string, string> }>,
): NotesIndexerSubstrate & {
  setDelta(repo: string, delta: WikiDelta): void;
  reads: string[];
} {
  const deltas = new Map<string, WikiDelta>();
  const reads: string[] = [];
  return {
    reads,
    setDelta: (repo, delta) => deltas.set(repo, delta),
    async read(repo): Promise<WikiSnapshot> {
      reads.push(repo);
      const r = repos[repo];
      if (!r) throw new Error(`repo ${repo} no existe`);
      return {
        ref: r.ref,
        files: Object.entries(r.files).map(([path, content]) => ({
          path,
          content,
          sha: `blob-${path}-${content.length}`,
        })),
      };
    },
    async changesSince(repo, baseRef): Promise<WikiDelta> {
      const d = deltas.get(repo);
      if (!d) throw new Error(`sin delta para ${repo} desde ${baseRef}`);
      return d;
    },
  };
}

const fakeEmbedder = (modelId = "model-A"): Embedder & { calls: string[][] } => {
  const calls: string[][] = [];
  return {
    modelId,
    calls,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((_, i) => Float32Array.from([i + 1, 0.5]));
    },
  };
};

const dbWithRepo = (...names: string[]) => {
  const db = openDb(":memory:");
  for (const n of names) addRepo(db, "org", n);
  return db;
};

describe("notes-indexer (reconciliador F1)", () => {
  it("backfill: repo sin meta se indexa entero desde el snapshot (sólo .md visibles)", async () => {
    const db = dbWithRepo("w1");
    const wk = fakeSubstrate({
      w1: {
        ref: "r1",
        files: { "a.md": "# A\nhola", "dir/b.md": "# B\nchau", ".ceibo/emojis.json": "{}", "img.png": "..." },
      },
    });
    const ix = startNotesIndexer({ db, wikis: wk, pollMs: 0 });
    await ix.tick();

    expect(indexedNoteRefs(db, "w1").map((r) => r.path)).toEqual(["a.md", "dir/b.md"]);
    expect(getNotesIndexMeta(db, "w1")).toMatchObject({ headRef: "r1" });
    expect(searchNotesLexical(db, ["w1"], "hola").map((h) => h.path)).toEqual(["a.md"]);
    ix.stop();
    db.close();
  });

  it("incremental: head nuevo aplica el delta (upsert + delete) sin re-leer todo", async () => {
    const db = dbWithRepo("w1");
    const wk = fakeSubstrate({ w1: { ref: "r1", files: { "a.md": "# A\nuno", "b.md": "# B\ndos" } } });
    const ix = startNotesIndexer({ db, wikis: wk, pollMs: 0 });
    await ix.tick(); // backfill @ r1
    expect(wk.reads).toEqual(["w1"]);

    setWikiHead(db, "w1", "r2");
    wk.setDelta("w1", {
      ref: "r2",
      changed: [{ path: "a.md", content: "# A\neditada", sha: "s2" }],
      deleted: ["b.md"],
    });
    await ix.tick();

    expect(wk.reads).toEqual(["w1"]); // no hubo segundo read completo
    expect(indexedNoteRefs(db, "w1").map((r) => r.path)).toEqual(["a.md"]);
    expect(searchNotesLexical(db, ["w1"], "editada")).toHaveLength(1);
    expect(getNotesIndexMeta(db, "w1")).toMatchObject({ headRef: "r2" });

    // Head sin cambios → tick no-op (sin delta seteado no tira error porque ni lo pide).
    await ix.tick();
    ix.stop();
    db.close();
  });

  it("delta imposible (force-push/base vieja) → flag reindex → rebuild al siguiente tick", async () => {
    const db = dbWithRepo("w1");
    const wk = fakeSubstrate({ w1: { ref: "r9", files: { "nuevo.md": "# N\nfresco" } } });
    const ix = startNotesIndexer({ db, wikis: wk, pollMs: 0, log: () => {} });
    await ix.tick(); // backfill @ r9

    setWikiHead(db, "w1", "r10"); // avanza, pero changesSince va a fallar (sin delta)
    await ix.tick();
    expect(getNotesIndexMeta(db, "w1")?.reindex).toBe(true);

    wk.reads.length = 0;
    await ix.tick(); // rebuild
    expect(wk.reads).toEqual(["w1"]);
    expect(getNotesIndexMeta(db, "w1")).toMatchObject({ headRef: "r9", reindex: false });
    ix.stop();
    db.close();
  });

  it("reindex manual (flagNotesReindex) fuerza rebuild", async () => {
    const db = dbWithRepo("w1");
    const wk = fakeSubstrate({ w1: { ref: "r1", files: { "a.md": "uno" } } });
    const ix = startNotesIndexer({ db, wikis: wk, pollMs: 0 });
    await ix.tick();
    flagNotesReindex(db, "w1");
    wk.reads.length = 0;
    await ix.tick();
    expect(wk.reads).toEqual(["w1"]);
    ix.stop();
    db.close();
  });

  it("embed: pendientes se chunkean con título, se vectorizan y quedan buscables por vector", async () => {
    const db = dbWithRepo("w1");
    const wk = fakeSubstrate({ w1: { ref: "r1", files: { "a.md": "# Ideas\ntexto de la nota" } } });
    const emb = fakeEmbedder();
    const ix = startNotesIndexer({ db, wikis: wk, embedder: emb, pollMs: 0 });
    await ix.tick();

    expect(notesPendingEmbed(db, 10)).toEqual([]); // todas embebidas
    const rows = noteChunksWithVectors(db, ["w1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toContain("Ideas"); // el chunk lleva el título como contexto
    expect(Array.from(blobToVector(rows[0]!.vector))).toEqual([1, 0.5]);
    expect(getNotesIndexMeta(db, "w1")?.modelId).toBe("model-A");
    ix.stop();
    db.close();
  });

  it("embedder caído: el índice FTS sigue, los vectores quedan pendientes y se reintentan", async () => {
    const db = dbWithRepo("w1");
    const wk = fakeSubstrate({ w1: { ref: "r1", files: { "a.md": "# A\nbuscable" } } });
    let fail = true;
    const emb: Embedder = {
      modelId: "m",
      embed: async (texts) => {
        if (fail) throw new Error("gpuhost caído");
        return texts.map(() => Float32Array.from([1]));
      },
    };
    const ix = startNotesIndexer({ db, wikis: wk, embedder: emb, pollMs: 0, log: () => {} });
    await ix.tick();
    expect(searchNotesLexical(db, ["w1"], "buscable")).toHaveLength(1); // léxico vive
    expect(notesPendingEmbed(db, 10)).toHaveLength(1); // vector pendiente

    fail = false;
    await ix.tick(); // reintento del próximo tick
    expect(notesPendingEmbed(db, 10)).toEqual([]);
    ix.stop();
    db.close();
  });

  it("cambio de modelo de embeddings → re-embed del repo (guard)", async () => {
    const db = dbWithRepo("w1");
    const wk = fakeSubstrate({ w1: { ref: "r1", files: { "a.md": "# A\nx" } } });
    const ixA = startNotesIndexer({ db, wikis: wk, embedder: fakeEmbedder("model-A"), pollMs: 0 });
    await ixA.tick();
    ixA.stop();
    expect(getNotesIndexMeta(db, "w1")?.modelId).toBe("model-A");

    // Reinicio con otro modelo y SIN cambios de contenido: el guard tira los vectores viejos
    // y el mismo tick re-embebe todo con el modelo nuevo.
    const embB = fakeEmbedder("model-B");
    const ixB = startNotesIndexer({ db, wikis: wk, embedder: embB, pollMs: 0, log: () => {} });
    await ixB.tick();
    expect(getNotesIndexMeta(db, "w1")?.modelId).toBe("model-B");
    expect(embB.calls.length).toBeGreaterThan(0); // re-embed real, no sólo el flag
    expect(notesPendingEmbed(db, 10)).toEqual([]);
    ixB.stop();
    db.close();
  });

  it("backfill budget: no más de N reads completos por tick", async () => {
    const db = dbWithRepo("w1", "w2", "w3");
    const wk = fakeSubstrate({
      w1: { ref: "r", files: { "a.md": "a" } },
      w2: { ref: "r", files: { "a.md": "a" } },
      w3: { ref: "r", files: { "a.md": "a" } },
    });
    const ix = startNotesIndexer({ db, wikis: wk, pollMs: 0, maxBackfillsPerTick: 2 });
    await ix.tick();
    expect(wk.reads).toHaveLength(2);
    await ix.tick(); // el resto cae en el tick siguiente
    expect(wk.reads).toHaveLength(3);
    ix.stop();
    db.close();
  });

  it("isIndexablePath: .md visibles sí; ocultos, sidecars y binarios no", () => {
    expect(isIndexablePath("nota.md")).toBe(true);
    expect(isIndexablePath("dir/sub/nota.md")).toBe(true);
    expect(isIndexablePath(".ceibo/emojis.json")).toBe(false);
    expect(isIndexablePath("dir/.oculto/x.md")).toBe(false);
    expect(isIndexablePath("img.png")).toBe(false);
    expect(isIndexablePath(".archived.md")).toBe(false);
  });

  it("repo borrado en GitHub (read falla) no rompe el tick de los demás", async () => {
    const db = dbWithRepo("roto", "sano");
    const wk = fakeSubstrate({ sano: { ref: "r", files: { "a.md": "ok" } } });
    const log = vi.fn();
    const ix = startNotesIndexer({ db, wikis: wk, pollMs: 0, log });
    await ix.tick();
    expect(indexedNoteRefs(db, "sano")).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("roto"));
    ix.stop();
    db.close();
  });
});
