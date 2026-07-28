import { openDb, upsertIndexedNote } from "@ceibo/store";
import { describe, expect, it } from "vitest";
import { formatVerify, isClean, type VerifySubstrate, verifyRepo } from "./notes-verify.ts";

// Substrato git fake: un repo = map path→content.
const fakeGit = (repos: Record<string, Record<string, string>>): VerifySubstrate => ({
  async read(repo) {
    return {
      ref: `head-${repo}`,
      files: Object.entries(repos[repo] ?? {}).map(([path, content]) => ({ path, content })),
    };
  },
});

describe("verify byte-a-byte DB vs git (gate del cutover F3)", () => {
  it("limpio: DB representa git idéntico → flip seguro", async () => {
    const db = openDb(":memory:");
    upsertIndexedNote(db, { repo: "w", path: "a.md", content: "hola", blobSha: "1" });
    upsertIndexedNote(db, { repo: "w", path: "dir/b.md", content: "chau", blobSha: "2" });
    const git = fakeGit({ w: { "a.md": "hola", "dir/b.md": "chau", ".ceibo/emojis.json": "{}" } });

    const r = await verifyRepo(db, git, "w");
    expect(isClean(r)).toBe(true);
    expect(r.matched).toBe(2); // el sidecar no-.md se ignora
    db.close();
  });

  it("detecta mismatch de contenido, git-only y db-only (índice stale)", async () => {
    const db = openDb(":memory:");
    upsertIndexedNote(db, { repo: "w", path: "igual.md", content: "mismo", blobSha: "1" });
    upsertIndexedNote(db, { repo: "w", path: "difiere.md", content: "version DB", blobSha: "2" });
    upsertIndexedNote(db, { repo: "w", path: "fantasma.md", content: "solo en DB", blobSha: "3" });
    const git = fakeGit({
      w: { "igual.md": "mismo", "difiere.md": "version GIT", "nueva.md": "solo en git" },
    });

    const r = await verifyRepo(db, git, "w");
    expect(isClean(r)).toBe(false);
    expect(r.matched).toBe(1);
    expect(r.mismatch).toEqual(["difiere.md"]);
    expect(r.gitOnly).toEqual(["nueva.md"]);
    expect(r.dbOnly).toEqual(["fantasma.md"]);
    expect(formatVerify([r])).toContain("SUCIO");
    db.close();
  });

  it("formato: limpio dice flip seguro", async () => {
    const db = openDb(":memory:");
    upsertIndexedNote(db, { repo: "w", path: "a.md", content: "x", blobSha: "1" });
    const r = await verifyRepo(db, fakeGit({ w: { "a.md": "x" } }), "w");
    expect(formatVerify([r])).toContain("Flip SEGURO");
    db.close();
  });
});
