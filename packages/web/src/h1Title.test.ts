import { describe, expect, it } from "vitest";
import { replaceOrInsertH1 } from "./h1Title.ts";

describe("replaceOrInsertH1", () => {
  it("reemplaza el primer H1 por el título nuevo, dejando el resto intacto", () => {
    const out = replaceOrInsertH1("# viejo\n\ncuerpo\n", "nuevo");
    expect(out).toBe("# nuevo\n\ncuerpo\n");
  });

  it("nunca duplica el H1 (regresión del bug de rename-por-título)", () => {
    // El bug: re-save tardío sobre contenido rotado dejaba "# nuevo\n# viejo". Acá el
    // reemplazo es idempotente: aplicarlo dos veces no agrega un segundo H1.
    const once = replaceOrInsertH1("# test-2\n\nhole\n", "test-2-hello");
    expect(once).toBe("# test-2-hello\n\nhole\n");
    const twice = replaceOrInsertH1(once, "test-2-hello");
    expect(twice).toBe(once);
    // Un solo `# ` en todo el contenido.
    expect((twice.match(/^# /gm) ?? []).length).toBe(1);
  });

  it("prepende un H1 si la primera línea no-vacía no es H1", () => {
    const out = replaceOrInsertH1("solo cuerpo\nmás\n", "título");
    expect(out).toBe("# título\n\nsolo cuerpo\nmás\n");
  });

  it("saltea líneas en blanco iniciales para encontrar el H1", () => {
    const out = replaceOrInsertH1("\n\n# viejo\ncuerpo", "nuevo");
    expect(out).toBe("\n\n# nuevo\ncuerpo");
  });

  it("contenido vacío → solo el H1 nuevo", () => {
    expect(replaceOrInsertH1("", "x")).toBe("# x\n\n");
  });

  it("preserva mayúsculas, tildes y espacios del título crudo", () => {
    const out = replaceOrInsertH1("# old\n", "Café del Día");
    expect(out).toBe("# Café del Día\n");
  });

  it("no confunde un heading de nivel >1 con el H1 (lo trata como no-H1 y prepende)", () => {
    // `## sub` no es H1: la primera línea no-vacía no matchea `# ` → prepende.
    const out = replaceOrInsertH1("## sub\ncuerpo", "t");
    expect(out).toBe("# t\n\n## sub\ncuerpo");
  });

  it("solo toca el PRIMER H1, no headings posteriores", () => {
    const out = replaceOrInsertH1("# uno\n\n# dos\n", "nuevo");
    expect(out).toBe("# nuevo\n\n# dos\n");
  });
});
