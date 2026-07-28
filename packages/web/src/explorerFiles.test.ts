import { describe, expect, it } from "vitest";
import { isVisibleWikiFile } from "./explorerFiles.ts";

describe("isVisibleWikiFile", () => {
  it("muestra el README.md de la raíz (es la bienvenida — ver welcome.ts)", () => {
    expect(isVisibleWikiFile("README.md")).toBe(true);
  });

  it("muestra un README.md dentro de una subcarpeta (nota del usuario)", () => {
    expect(isVisibleWikiFile("proyectos/README.md")).toBe(true);
    expect(isVisibleWikiFile("a/b/README.md")).toBe(true);
  });

  it("muestra las notas normales", () => {
    expect(isVisibleWikiFile("nota.md")).toBe(true);
    expect(isVisibleWikiFile("carpeta/sub/nota.md")).toBe(true);
  });

  it("deja pasar los anclajes de carpeta (se ocultan como nota en TreeNodes)", () => {
    expect(isVisibleWikiFile("carpeta/.gitkeep")).toBe(true); // ancla de carpeta vacía
    expect(isVisibleWikiFile("carpeta/_archivado.md")).toBe(true);
    expect(isVisibleWikiFile("carpeta/_index.md")).toBe(true); // legacy: ya no se crea, pero ancla
  });

  it("oculta CLAUDE.md en cualquier nivel", () => {
    expect(isVisibleWikiFile("CLAUDE.md")).toBe(false);
    expect(isVisibleWikiFile("carpeta/CLAUDE.md")).toBe(false);
  });

  it("oculta dotfiles (salvo .gitkeep, que ancla la carpeta)", () => {
    expect(isVisibleWikiFile(".DS_Store")).toBe(false);
    expect(isVisibleWikiFile("carpeta/.oculto.md")).toBe(false);
    expect(isVisibleWikiFile(".env")).toBe(false);
    expect(isVisibleWikiFile("carpeta/.gitkeep")).toBe(true);
  });

  it("oculta lo que no es .md", () => {
    expect(isVisibleWikiFile("archivo.txt")).toBe(false);
    expect(isVisibleWikiFile("imagen.png")).toBe(false);
    expect(isVisibleWikiFile("readme.md")).toBe(true); // case-sensitive: minúscula es nota real
  });
});
