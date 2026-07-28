import { describe, expect, it } from "vitest";
import {
  type RemapTab,
  remapPath,
  remapTabsEntries,
  remapTabsEntriesCross,
  tabTitleFromPath,
} from "./tabRemap.ts";

describe("remapPath", () => {
  it("remapea un archivo por path exacto", () => {
    expect(remapPath("a/nota.md", "a/nota.md", "b/nota.md", false)).toBe("b/nota.md");
  });

  it("no toca un archivo distinto", () => {
    expect(remapPath("a/otra.md", "a/nota.md", "b/nota.md", false)).toBeNull();
  });

  it("no aplica prefijo cuando isFolder=false aunque sea un substring", () => {
    // "a/nota.md" NO debe matchear como prefijo de "a" si no es carpeta
    expect(remapPath("a/nota.md", "a", "b", false)).toBeNull();
  });

  it("remapea la carpeta misma y todo lo que cuelga", () => {
    expect(remapPath("proyectos", "proyectos", "trabajo", true)).toBe("trabajo");
    expect(remapPath("proyectos/x.md", "proyectos", "trabajo", true)).toBe("trabajo/x.md");
    expect(remapPath("proyectos/sub/y.md", "proyectos", "trabajo", true)).toBe("trabajo/sub/y.md");
  });

  it("carpeta: no matchea un hermano con prefijo parecido (proyectos2)", () => {
    expect(remapPath("proyectos2/x.md", "proyectos", "trabajo", true)).toBeNull();
  });
});

describe("tabTitleFromPath", () => {
  it("usa el último segmento sin .md", () => {
    expect(tabTitleFromPath("a/b/Mi Nota.md")).toBe("Mi Nota");
    expect(tabTitleFromPath("raiz.md")).toBe("raiz");
    expect(tabTitleFromPath("carpeta")).toBe("carpeta");
  });
});

const note = (id: string, repo: string, paths: string[], cursor = paths.length - 1): RemapTab => ({
  id,
  cursor,
  entries: paths.map((p) => ({ kind: "note" as const, repo, path: p, title: tabTitleFromPath(p) })),
});

describe("remapTabsEntries", () => {
  it("remapea la entrada actual de la pestaña activa (rename de archivo)", () => {
    const tabs = [note("t1", "r", ["a/nota.md"])];
    const out = remapTabsEntries(tabs, "r", "a/nota.md", "a/Nueva.md", false);
    expect(out[0]?.entries[0]).toEqual({ kind: "note", repo: "r", path: "a/Nueva.md", title: "Nueva" });
  });

  it("remapea una pestaña de FONDO (no activa) que apunta al path viejo", () => {
    const tabs = [note("activa", "r", ["x.md"]), note("fondo", "r", ["a/nota.md"])];
    const out = remapTabsEntries(tabs, "r", "a/nota.md", "b/nota.md", false);
    expect(out[1]?.entries[0]?.kind === "system" ? null : (out[1]?.entries[0] as { path: string }).path).toBe(
      "b/nota.md",
    );
    // la activa no se toca
    expect(out[0]).toBe(tabs[0]);
  });

  it("remapea entradas enterradas en el historial back/forward, no sólo la actual", () => {
    const tabs = [note("t1", "r", ["a/nota.md", "x.md"], 1)]; // cursor en x.md, nota.md en el historial
    const out = remapTabsEntries(tabs, "r", "a/nota.md", "b/nota.md", false);
    const e0 = out[0]?.entries[0];
    expect(e0 && e0.kind !== "system" ? e0.path : null).toBe("b/nota.md");
    expect(out[0]?.cursor).toBe(1); // cursor preservado
  });

  it("no toca entradas de sistema", () => {
    const tabs: RemapTab[] = [{ id: "sys", cursor: 0, entries: [{ kind: "system", page: "config" }] }];
    const out = remapTabsEntries(tabs, "r", "a/nota.md", "b/nota.md", false);
    expect(out).toBe(tabs); // identidad estable: nada cambió
  });

  it("no toca otro repo", () => {
    const tabs = [note("t1", "otro", ["a/nota.md"])];
    const out = remapTabsEntries(tabs, "r", "a/nota.md", "b/nota.md", false);
    expect(out).toBe(tabs);
  });

  it("rename de carpeta: remapea todos los archivos bajo el prefijo en todas las pestañas", () => {
    const tabs = [
      note("t1", "r", ["proyectos/a.md"]),
      note("t2", "r", ["proyectos/sub/b.md"]),
      note("t3", "r", ["otra/c.md"]),
    ];
    const out = remapTabsEntries(tabs, "r", "proyectos", "trabajo", true);
    const path = (i: number) => {
      const e = out[i]?.entries[0];
      return e && e.kind !== "system" ? e.path : null;
    };
    expect(path(0)).toBe("trabajo/a.md");
    expect(path(1)).toBe("trabajo/sub/b.md");
    expect(path(2)).toBe("otra/c.md"); // intacta
    expect(out[2]).toBe(tabs[2]);
  });

  it("devuelve identidad estable cuando nada matchea (evita re-render)", () => {
    const tabs = [note("t1", "r", ["x.md"])];
    const out = remapTabsEntries(tabs, "r", "a/nota.md", "b/nota.md", false);
    expect(out).toBe(tabs);
  });
});

describe("remapTabsEntriesCross", () => {
  it("reescribe repo Y path: la pestaña sigue la nota a la otra wiki", () => {
    const tabs = [note("t1", "wikiA", ["a/nota.md"])];
    const out = remapTabsEntriesCross(tabs, "wikiA", "a/nota.md", "wikiB", "dest/nota.md", false);
    expect(out[0]?.entries[0]).toEqual({
      kind: "note",
      repo: "wikiB",
      path: "dest/nota.md",
      title: "nota",
    });
  });

  it("matchea por (fromRepo, path) exacto — no toca el mismo path en OTRA wiki", () => {
    // Mismo path "a/nota.md" pero en wikiC (no es el origen) → no se toca.
    const tabs = [note("t1", "wikiA", ["a/nota.md"]), note("t2", "wikiC", ["a/nota.md"])];
    const out = remapTabsEntriesCross(tabs, "wikiA", "a/nota.md", "wikiB", "a/nota.md", false);
    expect(out[0]?.entries[0]).toEqual({ kind: "note", repo: "wikiB", path: "a/nota.md", title: "nota" });
    expect(out[1]).toBe(tabs[1]); // intacta
  });

  it("remapea pestañas de fondo y entradas enterradas en el historial", () => {
    const tabs = [
      note("activa", "wikiA", ["x.md"]),
      note("fondo", "wikiA", ["a/nota.md", "y.md"], 1), // nota.md en el historial
    ];
    const out = remapTabsEntriesCross(tabs, "wikiA", "a/nota.md", "wikiB", "a/nota.md", false);
    const e = out[1]?.entries[0];
    expect(e && e.kind !== "system" ? { repo: e.repo, path: e.path } : null).toEqual({
      repo: "wikiB",
      path: "a/nota.md",
    });
    expect(out[1]?.cursor).toBe(1); // cursor preservado
    expect(out[0]).toBe(tabs[0]); // la activa (otro path) no se toca
  });

  it("no toca entradas de sistema", () => {
    const tabs: RemapTab[] = [{ id: "sys", cursor: 0, entries: [{ kind: "system", page: "config" }] }];
    const out = remapTabsEntriesCross(tabs, "wikiA", "a/nota.md", "wikiB", "a/nota.md", false);
    expect(out).toBe(tabs);
  });

  it("identidad estable cuando nada matchea (evita re-render)", () => {
    const tabs = [note("t1", "wikiC", ["a/nota.md"])];
    const out = remapTabsEntriesCross(tabs, "wikiA", "a/nota.md", "wikiB", "a/nota.md", false);
    expect(out).toBe(tabs);
  });
});
