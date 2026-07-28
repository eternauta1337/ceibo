import type { WikiChange } from "@ceibo/store";
import { describe, expect, it } from "vitest";
import { changedPathsForUser, isRefreshable } from "./feed.ts";

// Helper: arma un WikiChange mínimo (los campos que la lógica del feed mira).
function change(p: Partial<WikiChange> & Pick<WikiChange, "repo">): WikiChange {
  return {
    id: 1,
    ref: "sha",
    paths: [],
    entries: [],
    source: null,
    userId: null,
    at: "2026-06-07T00:00:00Z",
    ...p,
  };
}

describe("isRefreshable (#33)", () => {
  it("la edición de contenido del AGENTE refresca (la nota abierta no la tiene)", () => {
    expect(
      isRefreshable(
        change({ repo: "demo-personal", source: "agent", entries: [{ path: "a.md", op: "edit" }] }),
      ),
    ).toBe(true);
  });

  it("la edición de contenido de la PROPIA web NO refresca (autosave → self-refresh)", () => {
    expect(
      isRefreshable(
        change({ repo: "demo-personal", source: "web", entries: [{ path: "a.md", op: "edit" }] }),
      ),
    ).toBe(false);
  });

  it("un cambio ESTRUCTURAL de la web SÍ refresca (cambia el explorer)", () => {
    expect(
      isRefreshable(
        change({ repo: "demo-personal", source: "web", entries: [{ path: "a.md", op: "create" }] }),
      ),
    ).toBe(true);
  });

  it.each(["create", "delete", "archive", "move"] as const)("op estructural '%s' refresca", (op) => {
    expect(isRefreshable(change({ repo: "r", source: "web", entries: [{ path: "a.md", op }] }))).toBe(true);
  });

  it("un cambio out-of-band (source null, sin entries) refresca", () => {
    expect(isRefreshable(change({ repo: "r", source: null, entries: [] }))).toBe(true);
  });

  it("la edición del REM (source 'rem') refresca", () => {
    expect(isRefreshable(change({ repo: "r", source: "rem", entries: [{ path: "a.md", op: "edit" }] }))).toBe(
      true,
    );
  });
});

describe("changedPathsForUser (#33)", () => {
  it("devuelve los paths cambiados de los repos del user, dedupeados", () => {
    const changes = [
      change({ repo: "demo-personal", source: "agent", entries: [{ path: "a.md", op: "edit" }] }),
      change({ repo: "demo-personal", source: "agent", entries: [{ path: "a.md", op: "edit" }] }), // dup
      change({ repo: "demo-personal", source: "agent", entries: [{ path: "b.md", op: "edit" }] }),
    ];
    expect(changedPathsForUser(changes, ["demo-personal"])).toEqual([
      { repo: "demo-personal", path: "a.md" },
      { repo: "demo-personal", path: "b.md" },
    ]);
  });

  it("ignora cambios de repos que el user no tiene", () => {
    const changes = [change({ repo: "otro-repo", source: "agent", entries: [{ path: "x.md", op: "edit" }] })];
    expect(changedPathsForUser(changes, ["demo-personal"])).toBe(null);
  });

  it("null cuando lo único que cambió es un autosave de la propia web", () => {
    const changes = [
      change({ repo: "demo-personal", source: "web", entries: [{ path: "a.md", op: "edit" }] }),
    ];
    expect(changedPathsForUser(changes, ["demo-personal"])).toBe(null);
  });

  it("array VACÍO (≠ null) para un cambio out-of-band sin paths: refrescá pero sin paths", () => {
    const changes = [change({ repo: "demo-personal", source: null, entries: [] })];
    expect(changedPathsForUser(changes, ["demo-personal"])).toEqual([]);
  });

  it("un cambio estructural de la web aporta su path", () => {
    const changes = [
      change({ repo: "demo-personal", source: "web", entries: [{ path: "n.md", op: "create" }] }),
    ];
    expect(changedPathsForUser(changes, ["demo-personal"])).toEqual([
      { repo: "demo-personal", path: "n.md" },
    ]);
  });
});
