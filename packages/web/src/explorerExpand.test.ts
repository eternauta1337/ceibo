import { describe, expect, it } from "vitest";
import { addExpandKeys, folderKeyOf, neededExpandKeys } from "./explorerExpand.ts";

describe("neededExpandKeys", () => {
  it("archivo en la raíz de la wiki → solo la clave de la wiki", () => {
    expect(neededExpandKeys("repo", "nota.md")).toEqual(["repo"]);
  });

  it("archivo anidado → wiki + cada carpeta ancestro, raíz→hoja", () => {
    expect(neededExpandKeys("repo", "a/b/nota.md")).toEqual([
      "repo",
      folderKeyOf("repo", "a"),
      folderKeyOf("repo", "a/b"),
    ]);
  });

  it("no incluye el archivo en sí", () => {
    expect(neededExpandKeys("repo", "a/nota.md")).not.toContain(folderKeyOf("repo", "a/nota.md"));
  });
});

describe("addExpandKeys", () => {
  it("agrega las claves ancestro faltantes", () => {
    const next = addExpandKeys(new Set(), "repo", "a/b/nota.md");
    expect([...next].sort()).toEqual(["repo", "repo:a", "repo:a/b"].sort());
  });

  it("es aditivo: no quita lo que ya estaba expandido", () => {
    const prev = new Set(["repo", "repo:otra"]);
    const next = addExpandKeys(prev, "repo", "a/nota.md");
    expect(next.has("repo:otra")).toBe(true);
    expect(next.has("repo:a")).toBe(true);
  });

  it("identidad estable si ya están todas las claves (sin re-render)", () => {
    const prev = new Set(["repo", "repo:a"]);
    // Mismo archivo, todas las claves ya presentes → devuelve EL MISMO set.
    expect(addExpandKeys(prev, "repo", "a/nota.md")).toBe(prev);
  });

  it("una carpeta colapsada NO se re-expande si el archivo abierto sigue siendo el mismo (vía identidad estable)", () => {
    // Simula: el user colapsa `repo:a` (la saca del set). Re-aplicar la auto-expansión del MISMO
    // archivo la volvería a meter — por eso el efecto en Explorer depende de la IDENTIDAD del archivo
    // (repo+path), no de la referencia del objeto: con el archivo sin cambiar, el efecto NO corre.
    // Acá verificamos el caso opuesto (si corriera, sí re-expandiría) para documentar por qué la
    // defensa vive en las deps del efecto, no en esta función pura (que es deliberadamente aditiva).
    const collapsed = new Set(["repo"]); // el user colapsó repo:a
    const reExpanded = addExpandKeys(collapsed, "repo", "a/nota.md");
    expect(reExpanded.has("repo:a")).toBe(true); // la fn pura SÍ re-expande → el efecto NO debe re-correr
  });
});
