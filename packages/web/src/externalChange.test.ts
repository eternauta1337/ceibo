// Tests de la parte PURA de los cambios externos (Fase C): la decisión
// transacción-vs-banner según dirty/shas conocidos, y el diff por líneas que arma los
// hunks de la transacción CM6. La aplicación sobre un EditorView real se valida en
// browser (notelab.html) — headless no ejercita el stack montado del atomic.

import { describe, expect, it } from "vitest";
import { decideExternal, diffHunks, type Hunk } from "./externalChange.ts";

const base = {
  prevIncomingContent: "viejo",
  bufferContent: "viejo",
  dirty: false,
  knownShas: new Set<string>(),
};

describe("decideExternal", () => {
  it("ignora un sha conocido (eco de un save propio), aunque el contenido difiera", () => {
    expect(
      decideExternal({
        ...base,
        incomingContent: "otra cosa",
        incomingSha: "s1",
        knownShas: new Set(["s1"]),
      }),
    ).toBe("ignore");
  });

  it("ignora un eco STALE de un save propio anterior (no adopta el sha viejo)", () => {
    // El CDN re-sirve un blob nuestro de hace 2 saves: si lo adoptáramos como baseSha,
    // el próximo autosave caería en 409 fantasma; si lo aplicáramos, la nota "retrocede".
    expect(
      decideExternal({
        ...base,
        incomingContent: "contenido viejo nuestro",
        incomingSha: "s-viejo",
        bufferContent: "contenido actual",
        prevIncomingContent: "contenido actual",
        knownShas: new Set(["s-viejo", "s-actual"]),
      }),
    ).toBe("ignore");
  });

  it("adopta el sha cuando el contenido ya es el del buffer (escritura idéntica afuera)", () => {
    expect(
      decideExternal({
        ...base,
        incomingContent: "viejo",
        incomingSha: "s2",
      }),
    ).toBe("adopt");
  });

  it("adopta cuando solo cambió el sha (rename/move propio: contenido == prop anterior)", () => {
    expect(
      decideExternal({
        ...base,
        incomingContent: "viejo",
        incomingSha: "s3",
        bufferContent: "viejo + tipeo en curso", // tipeando durante el rename
        dirty: true,
      }),
    ).toBe("adopt");
  });

  it("aplica como transacción cuando hay contenido nuevo y el buffer está limpio", () => {
    expect(
      decideExternal({
        ...base,
        incomingContent: "nuevo del agente",
        incomingSha: "s4",
      }),
    ).toBe("apply");
  });

  it("difiere a banner cuando hay contenido nuevo y el buffer está dirty", () => {
    expect(
      decideExternal({
        ...base,
        incomingContent: "nuevo del agente",
        incomingSha: "s4",
        bufferContent: "viejo + mi tipeo sin guardar",
        dirty: true,
      }),
    ).toBe("defer");
  });

  it("decide igual sin sha (server viejo sin el campo): por contenido", () => {
    expect(decideExternal({ ...base, incomingContent: "viejo" })).toBe("adopt");
    expect(decideExternal({ ...base, incomingContent: "nuevo" })).toBe("apply");
    expect(decideExternal({ ...base, incomingContent: "nuevo", dirty: true })).toBe("defer");
  });
});

/** Aplica los hunks a `oldText` (los hunks vienen ordenados y sin solaparse). */
function applyHunks(oldText: string, hunks: Hunk[]): string {
  let out = "";
  let pos = 0;
  for (const h of hunks) {
    out += oldText.slice(pos, h.from) + h.insert;
    pos = h.to;
  }
  return out + oldText.slice(pos);
}

/** Invariante de todos los tests de diff: aplicar los hunks reproduce el texto nuevo. */
function roundtrip(oldText: string, newText: string): Hunk[] {
  const hunks = diffHunks(oldText, newText);
  expect(applyHunks(oldText, hunks)).toBe(newText);
  return hunks;
}

describe("diffHunks", () => {
  it("textos iguales → sin hunks", () => {
    expect(diffHunks("hola\nmundo", "hola\nmundo")).toEqual([]);
    expect(diffHunks("", "")).toEqual([]);
  });

  it("cambio de una línea en el medio → un hunk acotado (no toca el resto)", () => {
    const oldT = "# título\n\nuno\ndos\ntres\n";
    const newT = "# título\n\nuno\nDOS!\ntres\n";
    const hunks = roundtrip(oldT, newT);
    expect(hunks).toHaveLength(1);
    const h = hunks[0] as Hunk;
    // El hunk vive dentro de la línea "dos" (el trim de chars lo afina aún más).
    expect(h.from).toBeGreaterThanOrEqual(oldT.indexOf("dos"));
    expect(h.to).toBeLessThanOrEqual(oldT.indexOf("dos") + "dos\n".length);
  });

  it("cambio de una palabra dentro de una línea → hunk a nivel de caracteres", () => {
    const oldT = "una línea con la palabra vieja en el medio\n";
    const newT = "una línea con la palabra nueva en el medio\n";
    const hunks = roundtrip(oldT, newT);
    expect(hunks).toHaveLength(1);
    const h = hunks[0] as Hunk;
    expect(oldT.slice(h.from, h.to)).toBe("viej");
    expect(h.insert).toBe("nuev");
  });

  it("cambios en DOS secciones separadas → dos hunks (lo de entre medio queda intacto)", () => {
    const oldT = "## A\nuno\n\n## B\nestable\n\n## C\ntres\n";
    const newT = "## A\nuno bis\n\n## B\nestable\n\n## C\ntres bis\n";
    const hunks = roundtrip(oldT, newT);
    expect(hunks).toHaveLength(2);
  });

  it("inserción de una sección nueva al final", () => {
    const oldT = "## A\nuno\n";
    const newT = "## A\nuno\n\n## B\ndos\n";
    const hunks = roundtrip(oldT, newT);
    expect(hunks).toHaveLength(1);
  });

  it("borrado de la última línea (sin \\n final): el hunk se come el salto anterior", () => {
    roundtrip("a\nb", "a");
    roundtrip("a\nb\n", "a\n");
    roundtrip("a", "a\nb");
  });

  it("agregar/sacar el \\n final", () => {
    roundtrip("a\nb", "a\nb\n");
    roundtrip("a\nb\n", "a\nb");
  });

  it("texto vacío ↔ con contenido", () => {
    roundtrip("", "hola\n");
    roundtrip("hola\n", "");
  });

  it("reemplazo completo sin nada en común", () => {
    const hunks = roundtrip("xxx\nyyy\n", "aaa\nbbb\nccc\n");
    expect(hunks.length).toBeGreaterThanOrEqual(1);
  });

  it("doc grande (fallback a hunk único por encima del tope de LCS) sigue siendo correcto", () => {
    const oldLines = Array.from({ length: 900 }, (_, k) => `línea vieja ${k}`);
    const newLines = Array.from({ length: 900 }, (_, k) => `línea nueva ${k}`);
    roundtrip(`${oldLines.join("\n")}\n`, `${newLines.join("\n")}\n`);
  });

  it("muchas líneas iguales repetidas (listas): el roundtrip no se confunde", () => {
    const oldT = "- item\n- item\n- otro\n- item\n";
    const newT = "- item\n- otro\n- item\n- item\nnueva\n";
    roundtrip(oldT, newT);
  });
});
