import { describe, expect, it } from "vitest";
import { disambiguateTabTitles } from "./tabTitles.ts";

describe("disambiguateTabTitles", () => {
  it("deja el nombre pelado cuando no hay colisión de basename", () => {
    const out = disambiguateTabTitles([
      { id: "a", title: "backlog", repo: "ceibo", path: "proyectos/backlog.md" },
      { id: "b", title: "notas", repo: "personal", path: "notas.md" },
    ]);
    expect(out.get("a")).toBe("backlog");
    expect(out.get("b")).toBe("notas");
  });

  it("desambigua por wiki cuando colisionan en repos distintos (con … por carpetas ocultas)", () => {
    const out = disambiguateTabTitles([
      { id: "a", title: "backlog", repo: "ceibo", path: "personal/notas/backlog.md" },
      { id: "b", title: "backlog", repo: "personal", path: "trabajo/backlog.md" },
    ]);
    // El prefijo distintivo es el repo (idx 0), que NO es el padre directo → se intercala `…`.
    expect(out.get("a")).toBe("ceibo/…/backlog");
    expect(out.get("b")).toBe("personal/…/backlog");
  });

  it("incluye el repo + carpeta cuando comparten repo (el prefijo mínimo único arranca en la raíz)", () => {
    const out = disambiguateTabTitles([
      { id: "a", title: "backlog", repo: "ceibo", path: "a/backlog.md" },
      { id: "b", title: "backlog", repo: "ceibo", path: "b/backlog.md" },
    ]);
    // [ceibo] solo no distingue (ambos `ceibo`); el prefijo único más corto es [ceibo,a]/[ceibo,b]
    // (= el padre directo) → sin `…`.
    expect(out.get("a")).toBe("ceibo/a/backlog");
    expect(out.get("b")).toBe("ceibo/b/backlog");
  });

  it("baja a la carpeta que difiere cuando comparten ancestros", () => {
    const out = disambiguateTabTitles([
      { id: "a", title: "backlog", repo: "ceibo", path: "x/y/backlog.md" },
      { id: "b", title: "backlog", repo: "ceibo", path: "x/z/backlog.md" },
    ]);
    // repo y `x` coinciden; el primer prefijo único es [ceibo,x,y] / [ceibo,x,z] (= el padre) → sin `…`.
    expect(out.get("a")).toBe("ceibo/x/y/backlog");
    expect(out.get("b")).toBe("ceibo/x/z/backlog");
  });

  it("archivos en la raíz de wikis distintas: repo + basename, sin …", () => {
    const out = disambiguateTabTitles([
      { id: "a", title: "backlog", repo: "ceibo", path: "backlog.md" },
      { id: "b", title: "backlog", repo: "personal", path: "backlog.md" },
    ]);
    expect(out.get("a")).toBe("ceibo/backlog");
    expect(out.get("b")).toBe("personal/backlog");
  });

  it("maneja colisión de tres con prefijos solapados", () => {
    const out = disambiguateTabTitles([
      { id: "a", title: "backlog", repo: "ceibo", path: "a/backlog.md" },
      { id: "b", title: "backlog", repo: "ceibo", path: "b/backlog.md" },
      { id: "c", title: "backlog", repo: "personal", path: "a/backlog.md" },
    ]);
    // c se distingue ya por el repo (idx 0, no es padre) → con `…`.
    expect(out.get("c")).toBe("personal/…/backlog");
    // a y b comparten repo `ceibo`; necesitan su carpeta para distinguirse (= el padre) → sin `…`.
    expect(out.get("a")).toBe("ceibo/a/backlog");
    expect(out.get("b")).toBe("ceibo/b/backlog");
  });

  it("paths idénticos (degenerado): cae al nombre pelado sin romper", () => {
    const out = disambiguateTabTitles([
      { id: "a", title: "backlog", repo: "ceibo", path: "x/backlog.md" },
      { id: "b", title: "backlog", repo: "ceibo", path: "x/backlog.md" },
    ]);
    expect(out.get("a")).toBe("backlog");
    expect(out.get("b")).toBe("backlog");
  });

  it("usa el ALIAS (display label) de la wiki en el prefijo, no el slug del repo", () => {
    const labels = new Map([
      ["demo-personal", "Personal"],
      ["ceibofamily-ceibo", "Ceibo"],
    ]);
    const out = disambiguateTabTitles(
      [
        { id: "a", title: "backlog", repo: "ceibofamily-ceibo", path: "backlog.md" },
        { id: "b", title: "backlog", repo: "demo-personal", path: "backlog.md" },
      ],
      (repo) => labels.get(repo) ?? repo,
    );
    // El ancestro más alto es el alias, no el slug (`Ceibo`/`Personal`, no `ceibofamily-ceibo`).
    expect(out.get("a")).toBe("Ceibo/backlog");
    expect(out.get("b")).toBe("Personal/backlog");
  });

  it("sin alias mapeado para un repo, cae al slug en el prefijo", () => {
    const out = disambiguateTabTitles(
      [
        { id: "a", title: "backlog", repo: "ceibo", path: "backlog.md" },
        { id: "b", title: "backlog", repo: "personal", path: "backlog.md" },
      ],
      (repo) => new Map([["ceibo", "Ceibo"]]).get(repo) ?? repo,
    );
    expect(out.get("a")).toBe("Ceibo/backlog");
    expect(out.get("b")).toBe("personal/backlog"); // sin alias → slug
  });
});
