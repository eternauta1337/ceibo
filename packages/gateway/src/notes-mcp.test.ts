import {
  addRepo,
  addUser,
  type Embedder,
  grantAccess,
  notesPendingEmbed,
  openDb,
  saveNoteChunks,
  signUserToken,
  upsertIndexedNote,
  vectorToBlob,
} from "@ceibo/store";
import { describe, expect, it } from "vitest";
import { makeNotesServer } from "./notes-mcp.ts";

const HMAC = "k".repeat(32);

// Vectores sintéticos normalizados en R³.
const v = (x: number, y: number, z: number) => {
  const n = Math.hypot(x, y, z);
  return Float32Array.from([x / n, y / n, z / n]);
};

// Embedder fake: mapea términos conocidos a direcciones fijas (la "semántica" es un lookup).
const fakeEmbedder = (map: Record<string, Float32Array>): Embedder => ({
  modelId: "fake",
  embed: async (texts) => texts.map((t) => map[t] ?? v(0, 0, 1)),
});

/** Arma DB con dos usuarios y sus wikis + una nota indexada (con vector) en cada una. */
function seed() {
  const db = openDb(":memory:");
  const ana = addUser(db, "ana");
  const beto = addUser(db, "beto");
  const wikiAna = addRepo(db, "org", "ana-personal");
  const wikiBeto = addRepo(db, "org", "beto-personal");
  grantAccess(db, wikiAna.id, ana.id, "owner");
  grantAccess(db, wikiBeto.id, beto.id, "owner");

  upsertIndexedNote(db, {
    repo: "ana-personal",
    path: "recetas/asado.md",
    content: "# Asado\ncostillar a la parrilla con los primos el domingo",
    blobSha: "a1",
  });
  upsertIndexedNote(db, {
    repo: "beto-personal",
    path: "privado/sueldo.md",
    content: "# Sueldo\nmi sueldo es 999999",
    blobSha: "b1",
  });
  for (const n of notesPendingEmbed(db, 10)) {
    const vec = n.repo === "ana-personal" ? v(1, 0, 0) : v(0, 1, 0);
    saveNoteChunks(db, n.id, [{ seq: 0, text: n.content, vector: vectorToBlob(vec) }]);
  }
  return { db, ana, beto };
}

const tokenFor = (userId: number) => signUserToken(userId, HMAC);

describe("MCP notes (feature db F2)", () => {
  it("search híbrida: encuentra por significado (sin el literal) y devuelve path+snippet", async () => {
    const { db, ana } = seed();
    const embedder = fakeEmbedder({ "comida con la familia": v(1, 0.1, 0) });
    const srv = makeNotesServer(HMAC, db, embedder);

    const out = (await srv.callTool(tokenFor(ana.id), "search", { query: "comida con la familia" })) as {
      results: { wiki: string; path: string; snippet: string }[];
      degraded?: string;
    };
    expect(out.results.map((r) => r.path)).toContain("recetas/asado.md");
    expect(out.degraded).toBeUndefined();
    db.close();
  });

  it("NO CONTAMINACIÓN: un usuario jamás ve notas de otro, ni por búsqueda ni por scope explícito", async () => {
    const { db, ana, beto } = seed();
    // Embedder que apunta la query de ana EXACTO al vector de la nota privada de beto:
    // si el scoping fallara, el sueldo de beto aparecería primero.
    const embedder = fakeEmbedder({ sueldo: v(0, 1, 0) });
    const srv = makeNotesServer(HMAC, db, embedder);

    const out = (await srv.callTool(tokenFor(ana.id), "search", { query: "sueldo" })) as {
      results: { wiki: string }[];
    };
    expect(out.results.every((r) => r.wiki === "ana-personal")).toBe(true);
    expect(JSON.stringify(out)).not.toContain("999999");

    // Scope explícito a la wiki ajena → error, indistinguible de inexistente.
    await expect(
      srv.callTool(tokenFor(ana.id), "search", { query: "x", wiki: "beto-personal" }),
    ).rejects.toThrow(/no tenés/);
    await expect(srv.callTool(tokenFor(ana.id), "read", { path: "privado/sueldo.md" })).rejects.toThrow(
      /no existe/,
    );
    // beto sí lee lo suyo.
    const nota = (await srv.callTool(tokenFor(beto.id), "read", { path: "privado/sueldo.md" })) as {
      content: string;
    };
    expect(nota.content).toContain("999999");
    db.close();
  });

  it("token inválido o de otra HMAC key → rechazado", async () => {
    const { db, ana } = seed();
    const srv = makeNotesServer(HMAC, db, null);
    await expect(srv.callTool("basura", "search", { query: "x" })).rejects.toThrow(/token/);
    await expect(
      srv.callTool(signUserToken(ana.id, "otra-key-distinta-32-chars-....."), "search", { query: "x" }),
    ).rejects.toThrow(/token/);
    db.close();
  });

  it("degradación: sin embedder o con gpuhost caído, responde léxico y lo avisa", async () => {
    const { db, ana } = seed();
    const sinEmbedder = makeNotesServer(HMAC, db, null);
    const out1 = (await sinEmbedder.callTool(tokenFor(ana.id), "search", { query: "costillar" })) as {
      results: unknown[];
      degraded?: string;
    };
    expect(out1.results).toHaveLength(1); // léxico encuentra el literal
    expect(out1.degraded).toContain("léxic");

    const caido: Embedder = {
      modelId: "m",
      embed: async () => {
        throw new Error("timeout");
      },
    };
    const srv2 = makeNotesServer(HMAC, db, caido);
    const out2 = (await srv2.callTool(tokenFor(ana.id), "search", { query: "costillar" })) as {
      results: unknown[];
      degraded?: string;
    };
    expect(out2.results).toHaveLength(1);
    expect(out2.degraded).toContain("no disponible");
    db.close();
  });

  it("read con path inexistente sugiere parecidos; list scopea por wiki", async () => {
    const { db, ana } = seed();
    const srv = makeNotesServer(HMAC, db, null);
    await expect(srv.callTool(tokenFor(ana.id), "read", { path: "asado.md" })).rejects.toThrow(
      /recetas\/asado\.md/,
    );

    const ls = (await srv.callTool(tokenFor(ana.id), "list", {})) as {
      wikis: { wiki: string; paths: string[] }[];
    };
    expect(ls.wikis).toEqual([{ wiki: "ana-personal", paths: ["recetas/asado.md"] }]);
    db.close();
  });

  it("mode lexical no llama al embedder; semantic sin embedder degrada", async () => {
    const { db, ana } = seed();
    let called = 0;
    const spy: Embedder = {
      modelId: "m",
      embed: async (texts) => {
        called++;
        return texts.map(() => v(1, 0, 0));
      },
    };
    const srv = makeNotesServer(HMAC, db, spy);
    await srv.callTool(tokenFor(ana.id), "search", { query: "costillar", mode: "lexical" });
    expect(called).toBe(0);
    await srv.callTool(tokenFor(ana.id), "search", { query: "costillar", mode: "hybrid" });
    expect(called).toBe(1);
    db.close();
  });
});

describe("MCP notes — tools de escritura (feature db F3c, writeMode=db)", () => {
  const dbServer = (db: ReturnType<typeof openDb>) => makeNotesServer(HMAC, db, null, { writeMode: "db" });

  it("en modo git las tools de escritura NO existen (ni en el listado ni en callTool)", async () => {
    const { db, ana } = seed();
    const srv = makeNotesServer(HMAC, db, null);
    expect(srv.tools.map((t) => t.name)).toEqual(["search", "read", "list"]);
    await expect(
      srv.callTool(tokenFor(ana.id), "write", {
        wiki: "ana-personal",
        path: "x.md",
        content: "x",
        expected_version: 0,
      }),
    ).rejects.toThrow(/desconocida/);
    db.close();
  });

  it("create → write con conflicto COMO DATO → merge y reintento", async () => {
    const { db, ana } = seed();
    const srv = dbServer(db);
    const t = tokenFor(ana.id);
    expect(await srv.callTool(t, "create", { wiki: "ana-personal", path: "n.md", content: "v1" })).toEqual({
      version: 1,
    });
    expect(
      await srv.callTool(t, "write", {
        wiki: "ana-personal",
        path: "n.md",
        content: "v2",
        expected_version: 1,
      }),
    ).toEqual({ version: 2 });
    const conflicted = (await srv.callTool(t, "write", {
      wiki: "ana-personal",
      path: "n.md",
      content: "pisada",
      expected_version: 1,
    })) as Record<string, unknown>;
    expect(conflicted).toMatchObject({ conflict: true, current_version: 2, current_content: "v2" });
    expect(await srv.callTool(t, "create", { wiki: "ana-personal", path: "n.md" })).toEqual({ exists: true });
    db.close();
  });

  it("NO CONTAMINACIÓN en escritura: wiki ajena rechazada en write/move/batch", async () => {
    const { db, ana } = seed();
    const srv = dbServer(db);
    const t = tokenFor(ana.id);
    await expect(
      srv.callTool(t, "write", {
        wiki: "beto-personal",
        path: "privado/sueldo.md",
        content: "hackeada",
        expected_version: 0,
      }),
    ).rejects.toThrow(/no tenés/);
    await expect(srv.callTool(t, "batch", { wiki: "beto-personal", changes: [] })).rejects.toThrow(
      /no tenés/,
    );
    // move con destino ajeno también.
    await srv.callTool(t, "create", { wiki: "ana-personal", path: "mia.md", content: "x" });
    await expect(
      srv.callTool(t, "move", {
        wiki: "ana-personal",
        path: "mia.md",
        to_wiki: "beto-personal",
        to_path: "mia.md",
        expected_version: 1,
      }),
    ).rejects.toThrow(/no tenés/);
    db.close();
  });

  it("batch atómico vía MCP: conflicto reporta paths y no aplica nada", async () => {
    const { db, ana } = seed();
    const srv = dbServer(db);
    const t = tokenFor(ana.id);
    await srv.callTool(t, "create", { wiki: "ana-personal", path: "a.md", content: "a1" });
    const bad = (await srv.callTool(t, "batch", {
      wiki: "ana-personal",
      changes: [
        { op: "put", path: "nueva.md", content: "n" },
        { op: "put", path: "a.md", content: "a2", expected_version: 99 },
      ],
    })) as Record<string, unknown>;
    expect(bad).toEqual({ conflict_paths: ["a.md"] });
    await expect(srv.callTool(t, "read", { path: "nueva.md" })).rejects.toThrow(/no existe/);
    const ok = await srv.callTool(t, "batch", {
      wiki: "ana-personal",
      changes: [
        { op: "put", path: "nueva.md", content: "n" },
        { op: "move", path: "a.md", to_path: "b.md", expected_version: 1 },
      ],
    });
    expect(ok).toEqual({ ok: true });
    db.close();
  });
});
