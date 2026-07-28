import { describe, expect, it, vi } from "vitest";
import { isBareReadme, README_PATH, seedWelcomeNote, WELCOME_MARKDOWN, WELCOME_PATH } from "./welcome.ts";

describe("isBareReadme (predicado conservador: ¿es el auto-init pelado?)", () => {
  it("vacío → pelado", () => {
    expect(isBareReadme("")).toBe(true);
  });

  it("sólo espacios/saltos → pelado", () => {
    expect(isBareReadme("   \n\n  \t\n")).toBe(true);
  });

  it("un solo H1 con el nombre del repo (auto_init) → pelado", () => {
    expect(isBareReadme("# demo-personal")).toBe(true);
    expect(isBareReadme("# demo-personal\n")).toBe(true);
  });

  it("un solo H1 con cualquier texto → pelado (no nos atamos al nombre del repo)", () => {
    expect(isBareReadme("# Cualquier Cosa")).toBe(true);
  });

  it("H1 con comentario HTML de auto-init alrededor → pelado", () => {
    expect(isBareReadme("<!-- generado -->\n# demo-personal\n")).toBe(true);
  });

  it("template real de auto_init con description (H1 + `wiki ceibo: X`) → pelado", () => {
    // GitHub copia la `description` del repo como 2da línea del README cuando hay auto_init.
    expect(isBareReadme("# demo-gpuhost-testing123\nwiki ceibo: demo-gpuhost-testing123\n")).toBe(true);
  });

  it("template viejo con flavor managed-2 (H1 + `wiki managed-2: X`) → pelado", () => {
    expect(isBareReadme("# lula\nwiki managed-2: lula\n")).toBe(true);
  });

  it("H1 + 2da línea que NO es la descripción de auto_init → NO pelado (contenido real)", () => {
    expect(isBareReadme("# demo-personal\nMis cosas importantes acá.")).toBe(false);
  });

  it("H1 + párrafo de contenido → NO pelado (no tocar)", () => {
    expect(isBareReadme("# demo-personal\n\nMis notas personales.")).toBe(false);
  });

  it("H1 + lista → NO pelado", () => {
    expect(isBareReadme("# Notas\n\n- comprar pan\n- llamar a mamá")).toBe(false);
  });

  it("dos headings → NO pelado", () => {
    expect(isBareReadme("# Uno\n\n## Dos")).toBe(false);
  });

  it("contenido sin heading → NO pelado", () => {
    expect(isBareReadme("esto es una nota mía sin título")).toBe(false);
  });

  it("la bienvenida → NO pelado (no re-convertir)", () => {
    expect(isBareReadme(WELCOME_MARKDOWN)).toBe(false);
  });
});

describe("seedWelcomeNote (convierte el README pelado en Bienvenida.md)", () => {
  function fakeWikis(content: string) {
    const moveFile = vi.fn(async () => ({ sha: "new", path: WELCOME_PATH }));
    const getFile = vi.fn(async () => ({ content, sha: "abc123" }));
    return { getFile, moveFile };
  }

  it("mueve README.md → Bienvenida.md con el contenido si el README está pelado", async () => {
    const w = fakeWikis("# demo-personal");
    await seedWelcomeNote(w, "demo-personal", () => {});
    expect(w.moveFile).toHaveBeenCalledTimes(1);
    expect(w.moveFile).toHaveBeenCalledWith(
      "demo-personal",
      README_PATH,
      WELCOME_PATH,
      "abc123",
      expect.any(String),
      { newContent: WELCOME_MARKDOWN },
    );
  });

  it("NO toca un README con contenido real del usuario (ni crea Bienvenida)", async () => {
    const w = fakeWikis("# Notas\n\nMis cosas importantes.");
    await seedWelcomeNote(w, "demo-personal", () => {});
    expect(w.moveFile).not.toHaveBeenCalled();
  });

  it("best-effort: si getFile/moveFile fallan, loguea y NO propaga", async () => {
    const getFile = vi.fn(async () => {
      throw new Error("github caído");
    });
    const moveFile = vi.fn();
    const log = vi.fn();
    await expect(seedWelcomeNote({ getFile, moveFile }, "demo-personal", log)).resolves.toBeUndefined();
    expect(moveFile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
