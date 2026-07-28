import type { IncomingMessage, ServerResponse } from "node:http";
import { openDb, signUserToken, wikiChangesSince } from "@ceibo/store";
import type { Change, GitAuthor, Wikis } from "@ceibo/wikis";
import { describe, expect, it } from "vitest";
import { makeWikiSyncHandler } from "./wiki-sync.ts";

// Test del endpoint de commit enfocado en la atribución create/edit/delete del change feed
// (lo consume el resumen de turno del gateway). DB SQLite real en memoria; Wikis fakeado.

const SECRET = "test-secret";
const USER = 7;
const REPO = "demo-personal";

/** Wikis fake: `commit` siempre ok con el ref dado; `tree` devuelve los paths configurados
 *  (o tira si `treeError`, para ejercitar el fallback a 'edit'). Captura el author del commit. */
function fakeWikis(opts: { existing: string[]; treeError?: boolean }): Wikis & { lastAuthor?: GitAuthor } {
  const stub = {
    lastAuthor: undefined as GitAuthor | undefined,
    async commit(_repo: string, _ref: string, _changes: Change[], _msg: string, author?: GitAuthor) {
      stub.lastAuthor = author;
      return { ok: true as const, ref: "newsha" };
    },
    async tree() {
      if (opts.treeError) throw new Error("ref inválido");
      return { ref: "base", paths: opts.existing };
    },
  };
  return stub as unknown as Wikis & { lastAuthor?: GitAuthor };
}

/** Respuesta HTTP fake: captura status + body JSON. */
function fakeRes() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(s?: string) {
      captured.body = s ? JSON.parse(s) : undefined;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function postCommit(wikis: Wikis, db: ReturnType<typeof openDb>, changes: Change[]) {
  const handler = makeWikiSyncHandler({
    secret: SECRET,
    wikis,
    userRepoNames: () => [REPO],
    db,
    readBody: async () => JSON.stringify({ repo: REPO, baseRef: "base", changes, message: "m" }),
  });
  const req = {
    method: "POST",
    url: "/api/sync/commit",
    headers: { authorization: `Bearer ${signUserToken(USER, SECRET)}` },
  } as unknown as IncomingMessage;
  const { res, captured } = fakeRes();
  await handler(req, res);
  return captured;
}

/** Igual que postCommit pero con userId real en la DB para verificar atribución git. */
async function postCommitWithUser(
  wikis: Wikis,
  db: ReturnType<typeof openDb>,
  changes: Change[],
  userOpts?: { handle: string; name?: string },
) {
  const u = userOpts ?? { handle: "demo", name: "Alicia" };
  // Insertamos el user con el id fijo USER (necesitamos el id concreto para el token).
  // addUser asigna ids autoincrement; hacemos un insert directo con el id esperado.
  db.prepare(
    "INSERT OR REPLACE INTO users (id, handle, name, status, lang) VALUES (?, ?, ?, 'active', 'es')",
  ).run(USER, u.handle, u.name ?? null);
  return postCommit(wikis, db, changes);
}

describe("wiki-sync commit: atribución create/edit/delete", () => {
  it("put de archivo NUEVO (no en baseRef) → op 'create'", async () => {
    const db = openDb(":memory:");
    const cap = await postCommit(fakeWikis({ existing: ["vieja.md"] }), db, [
      { op: "put", path: "nueva.md", content: "hola" },
    ]);
    expect(cap.status).toBe(200);
    const feed = wikiChangesSince(db, 0);
    expect(feed[0]?.entries).toEqual([{ path: "nueva.md", op: "create" }]);
    db.close();
  });

  it("put de archivo EXISTENTE (en baseRef) → op 'edit'", async () => {
    const db = openDb(":memory:");
    await postCommit(fakeWikis({ existing: ["nota.md"] }), db, [
      { op: "put", path: "nota.md", content: "actualizada" },
    ]);
    const feed = wikiChangesSince(db, 0);
    expect(feed[0]?.entries).toEqual([{ path: "nota.md", op: "edit" }]);
    db.close();
  });

  it("delete → op 'delete' (sin pedir el árbol)", async () => {
    const db = openDb(":memory:");
    // existing vacío y treeError: si pidiera el árbol para un delete, este test fallaría.
    const cap = await postCommit(fakeWikis({ existing: [], treeError: true }), db, [
      { op: "delete", path: "borrada.md" },
    ]);
    expect(cap.status).toBe(200);
    const feed = wikiChangesSince(db, 0);
    expect(feed[0]?.entries).toEqual([{ path: "borrada.md", op: "delete" }]);
    db.close();
  });

  it("baseRef ilegible (tree tira) → fallback a 'edit' para los puts, commit no rompe", async () => {
    const db = openDb(":memory:");
    const cap = await postCommit(fakeWikis({ existing: [], treeError: true }), db, [
      { op: "put", path: "nueva.md", content: "x" },
    ]);
    expect(cap.status).toBe(200);
    const feed = wikiChangesSince(db, 0);
    expect(feed[0]?.entries).toEqual([{ path: "nueva.md", op: "edit" }]);
    db.close();
  });

  it("commit mixto: create + edit + delete en un solo push", async () => {
    const db = openDb(":memory:");
    await postCommit(fakeWikis({ existing: ["vieja.md"] }), db, [
      { op: "put", path: "vieja.md", content: "v2" },
      { op: "put", path: "nueva.md", content: "n" },
      { op: "delete", path: "fuera.md" },
    ]);
    const feed = wikiChangesSince(db, 0);
    expect(feed[0]?.entries).toEqual([
      { path: "vieja.md", op: "edit" },
      { path: "nueva.md", op: "create" },
      { path: "fuera.md", op: "delete" },
    ]);
    db.close();
  });

  it("pasa el author git del usuario al commit (agente de X firma como X)", async () => {
    const db = openDb(":memory:");
    const wk = fakeWikis({ existing: [] });
    await postCommitWithUser(wk, db, [{ op: "put", path: "n.md", content: "x" }], {
      handle: "demo",
      name: "Alicia",
    });
    expect(wk.lastAuthor).toEqual({ name: "Alicia", email: "demo@users.example.com" });
    db.close();
  });

  it("usa el handle como name cuando el usuario no tiene display name", async () => {
    const db = openDb(":memory:");
    const wk = fakeWikis({ existing: [] });
    await postCommitWithUser(wk, db, [{ op: "put", path: "n.md", content: "x" }], {
      handle: "demo",
      name: undefined,
    });
    expect(wk.lastAuthor).toEqual({ name: "demo", email: "demo@users.example.com" });
    db.close();
  });
});
