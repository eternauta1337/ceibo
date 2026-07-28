import { describe, expect, it } from "vitest";
import { isSameNote, isStaleNote } from "./noteIdentity.ts";

describe("isSameNote", () => {
  it("misma nota = mismo repo y path", () => {
    expect(isSameNote({ repo: "r", path: "a.md" }, { repo: "r", path: "a.md" })).toBe(true);
  });
  it("distinto path = distinta nota", () => {
    expect(isSameNote({ repo: "r", path: "a.md" }, { repo: "r", path: "b.md" })).toBe(false);
  });
  it("distinto repo = distinta nota (mismo path en otra wiki)", () => {
    expect(isSameNote({ repo: "r1", path: "a.md" }, { repo: "r2", path: "a.md" })).toBe(false);
  });
  it("null/undefined nunca coincide (sin nota abierta)", () => {
    expect(isSameNote(null, { repo: "r", path: "a.md" })).toBe(false);
    expect(isSameNote({ repo: "r", path: "a.md" }, undefined)).toBe(false);
    expect(isSameNote(null, null)).toBe(false);
  });
});

describe("isStaleNote — guard anti-contaminación", () => {
  it("NO es stale mientras la nota abierta sea la misma → se aplica el resultado", () => {
    const live = { repo: "r", path: "A.md" };
    expect(isStaleNote(live, { repo: "r", path: "A.md" })).toBe(false);
  });

  it("ES stale cuando el usuario cambió a OTRA nota mid-flight → se descarta el eco", () => {
    // op disparada para A; cuando resuelve, la activa ya es B → el resultado de A NO se aplica.
    const live = { repo: "r", path: "B.md" };
    expect(isStaleNote(live, { repo: "r", path: "A.md" })).toBe(true);
  });

  it("ES stale cuando se cerró la nota (no hay activa)", () => {
    expect(isStaleNote(null, { repo: "r", path: "A.md" })).toBe(true);
  });
});
