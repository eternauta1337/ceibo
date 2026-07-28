import {
  addUser,
  createNote,
  deleteNote,
  moveNote,
  openDb,
  versionsPendingMirror,
  writeNote,
} from "@ceibo/store";
import type { Change, CommitResult } from "@ceibo/wikis";
import { describe, expect, it } from "vitest";
import { collapseToChanges, type MirrorSubstrate, startNotesMirror } from "./notes-mirror.ts";

/** Substrato fake: acumula commits; se le puede inyectar un conflicto por repo. */
function fakeGit() {
  const commits: {
    repo: string;
    base: string;
    changes: Change[];
    message: string;
    author?: { name: string; email: string };
  }[] = [];
  const conflictOnce = new Set<string>();
  let head = 0;
  // Estado git simulado por repo: set de paths presentes en HEAD (para tree()).
  const gitState: Record<string, Set<string>> = {};
  const applyToGit = (repo: string, changes: Change[]) => {
    let s = gitState[repo];
    if (!s) {
      s = new Set();
      gitState[repo] = s;
    }
    for (const c of changes) {
      if (c.op === "delete") s.delete(c.path);
      else s.add(c.path);
    }
  };
  return {
    commits,
    conflictOnce,
    gitState,
    substrate: {
      async headSha() {
        return `head-${head}`;
      },
      async tree(repo: string) {
        return { paths: [...(gitState[repo] ?? [])] };
      },
      async commit(repo, base, changes, message, author): Promise<CommitResult> {
        if (conflictOnce.has(repo)) {
          conflictOnce.delete(repo);
          return { ok: false, conflictPaths: changes.map((c) => c.path) };
        }
        head++;
        commits.push({ repo, base, changes, message, author });
        applyToGit(repo, changes);
        return { ok: true, ref: `ref-${head}` };
      },
    } satisfies MirrorSubstrate,
  };
}

describe("espejo git una-vía (feature db F3b)", () => {
  it("exporta writes del contrato colapsados por path, con autoría real, y marca el cursor", async () => {
    const db = openDb(":memory:");
    const ana = addUser(db, "ana", { name: "Ana" });
    createNote(db, "w", "a.md", "uno", { authorUid: ana.id, source: "web" });
    writeNote(db, "w", "a.md", "dos", 1, { authorUid: ana.id, source: "web" });
    createNote(db, "w", "b.md", "be", { authorUid: ana.id, source: "agent" });

    const git = fakeGit();
    const m = startNotesMirror({ db, wikis: git.substrate, pollMs: 0 });
    await m.tick();

    expect(git.commits).toHaveLength(1); // un commit por repo por tick
    const c = git.commits[0]!;
    expect(c.repo).toBe("w");
    // Colapsado: a.md una sola vez, con el ÚLTIMO contenido.
    expect(c.changes.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { op: "put", path: "a.md", content: "dos" },
      { op: "put", path: "b.md", content: "be" },
    ]);
    expect(c.author).toEqual({ name: "Ana", email: "ana@users.example.com" });
    expect(versionsPendingMirror(db)).toEqual([]); // cursor marcado

    await m.tick(); // sin pendientes → no-op
    expect(git.commits).toHaveLength(1);
    m.stop();
    db.close();
  });

  it("delete y move (mismo repo) se exportan como delete/put+delete", async () => {
    const db = openDb(":memory:");
    createNote(db, "w", "vieja.md", "x");
    createNote(db, "w", "muere.md", "y");
    const git = fakeGit();
    const m = startNotesMirror({ db, wikis: git.substrate, pollMs: 0 });
    await m.tick();
    git.commits.length = 0;

    moveNote(db, { repo: "w", path: "vieja.md" }, { repo: "w", path: "nueva.md" }, 1);
    deleteNote(db, "w", "muere.md", 1);
    await m.tick();

    const changes = git.commits[0]!.changes;
    expect(changes).toContainEqual({ op: "delete", path: "vieja.md" });
    expect(changes).toContainEqual({ op: "put", path: "nueva.md", content: "x" });
    expect(changes).toContainEqual({ op: "delete", path: "muere.md" });
    m.stop();
    db.close();
  });

  it("move CROSS-WIKI: put en el destino y delete en el repo de ORIGEN (dos commits)", async () => {
    const db = openDb(":memory:");
    createNote(db, "w1", "n.md", "contenido");
    const git = fakeGit();
    const m = startNotesMirror({ db, wikis: git.substrate, pollMs: 0 });
    await m.tick();
    git.commits.length = 0;

    moveNote(db, { repo: "w1", path: "n.md" }, { repo: "w2", path: "n.md" }, 1);
    await m.tick();

    const byRepo = Object.fromEntries(git.commits.map((c) => [c.repo, c.changes]));
    expect(byRepo.w2).toEqual([{ op: "put", path: "n.md", content: "contenido" }]);
    expect(byRepo.w1).toEqual([{ op: "delete", path: "n.md" }]);
    m.stop();
    db.close();
  });

  it("conflicto: NO marca el cursor y el tick siguiente lo exporta (la DB no pierde nada)", async () => {
    const db = openDb(":memory:");
    createNote(db, "w", "a.md", "x");
    const git = fakeGit();
    git.conflictOnce.add("w");
    const m = startNotesMirror({ db, wikis: git.substrate, pollMs: 0, log: () => {} });

    await m.tick();
    expect(git.commits).toHaveLength(0);
    expect(versionsPendingMirror(db)).toHaveLength(1); // sigue pendiente

    await m.tick(); // reintento con head fresco
    expect(git.commits).toHaveLength(1);
    expect(versionsPendingMirror(db)).toEqual([]);
    m.stop();
    db.close();
  });

  it("un repo que explota no frena a los demás", async () => {
    const db = openDb(":memory:");
    createNote(db, "roto", "a.md", "x");
    createNote(db, "sano", "b.md", "y");
    const git = fakeGit();
    const base = git.substrate.commit.bind(git.substrate);
    git.substrate.commit = async (repo, ...rest) => {
      if (repo === "roto") throw new Error("boom");
      return base(repo, ...rest);
    };
    const m = startNotesMirror({ db, wikis: git.substrate, pollMs: 0, log: () => {} });
    await m.tick();
    expect(git.commits.map((c) => c.repo)).toEqual(["sano"]);
    expect(versionsPendingMirror(db).map((v) => v.repo)).toEqual(["roto"]); // reintentable
    m.stop();
    db.close();
  });

  it("nota creada y borrada por el contrato antes de espejar = no-op git (no traba la cola)", async () => {
    const db = openDb(":memory:");
    // create → delete en el mismo lote, la nota NUNCA estuvo en git.
    createNote(db, "w", "efimera.md", "hola");
    deleteNote(db, "w", "efimera.md", 1);
    const git = fakeGit(); // git vacío para "w"
    const m = startNotesMirror({ db, wikis: git.substrate, pollMs: 0, log: () => {} });
    await m.tick();
    expect(git.commits).toHaveLength(0); // NO se manda un delete de path inexistente
    expect(versionsPendingMirror(db)).toEqual([]); // pero la cola queda limpia (no trabada)
    m.stop();
    db.close();
  });

  it("collapseToChanges: create+edit+delete del mismo path colapsa al último estado", () => {
    const vs = [
      {
        id: 1,
        repo: "w",
        path: "a.md",
        version: 1,
        content: "v1",
        op: "create",
        authorUid: null,
        movedFrom: null,
      },
      {
        id: 2,
        repo: "w",
        path: "a.md",
        version: 2,
        content: "v2",
        op: "edit",
        authorUid: null,
        movedFrom: null,
      },
      {
        id: 3,
        repo: "w",
        path: "a.md",
        version: 3,
        content: "",
        op: "delete",
        authorUid: null,
        movedFrom: null,
      },
    ];
    expect(collapseToChanges(vs)).toEqual([{ op: "delete", path: "a.md" }]);
  });
});
