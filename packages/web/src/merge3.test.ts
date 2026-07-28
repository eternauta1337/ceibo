// Tests del merge a 3 vías por líneas (Fase B): la pieza pura del rebase transparente
// ante un 409 del autosave. Sin solapamiento → merge limpio (el caso común: REM toca una
// sección que no estás editando); solapamiento real → conflicto, nunca un merge mentiroso.

import { describe, expect, it } from "vitest";
import { changedRegions, collapseDiff, diffLines, merge3, splitLines } from "./merge3.ts";

/** Nota de juguete con secciones, como las reales que consolida el REM. */
const NOTE = `# nota

## sección A
línea a1
línea a2

## sección B
línea b1
línea b2

## sección C
línea c1
línea c2
`;

function expectClean(base: string, mine: string, theirs: string): string {
  const r = merge3(base, mine, theirs);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("unreachable");
  return r.merged;
}

function expectConflict(base: string, mine: string, theirs: string): void {
  const r = merge3(base, mine, theirs);
  expect(r.ok).toBe(false);
}

describe("merge3 — casos degenerados", () => {
  it("los tres iguales → base", () => {
    expect(expectClean(NOTE, NOTE, NOTE)).toBe(NOTE);
  });
  it("solo yo cambié → lo mío", () => {
    const mine = NOTE.replace("línea a1", "línea a1 mía");
    expect(expectClean(NOTE, mine, NOTE)).toBe(mine);
  });
  it("solo ellos cambiaron → lo de ellos", () => {
    const theirs = NOTE.replace("línea b1", "línea b1 de ellos");
    expect(expectClean(NOTE, NOTE, theirs)).toBe(theirs);
  });
  it("ambos hicieron exactamente el mismo cambio → una sola copia", () => {
    const both = NOTE.replace("línea a1", "línea a1 igual");
    expect(expectClean(NOTE, both, both)).toBe(both);
  });
  it("base vacía: yo escribí, ellos no → lo mío", () => {
    expect(expectClean("", "hola\n", "")).toBe("hola\n");
  });
  it("base vacía: ambos escribieron distinto → conflicto", () => {
    expectConflict("", "hola\n", "chau\n");
  });
});

describe("merge3 — el caso común (secciones distintas)", () => {
  it("yo edito la sección A, el REM agrega una sección al final → limpio, conviven", () => {
    const mine = NOTE.replace("línea a1", "línea a1 EDITADA por mí");
    const theirs = `${NOTE}\n## sección nueva (REM)\nconsolidado del día\n`;
    const merged = expectClean(NOTE, mine, theirs);
    expect(merged).toContain("línea a1 EDITADA por mí");
    expect(merged).toContain("## sección nueva (REM)");
  });

  it("yo edito la sección A, el REM reescribe la C → limpio", () => {
    const mine = NOTE.replace("línea a2", "línea a2 con más texto mío\ny una línea nueva mía");
    const theirs = NOTE.replace("línea c1\nlínea c2", "línea c1 consolidada");
    const merged = expectClean(NOTE, mine, theirs);
    expect(merged).toContain("línea a2 con más texto mío");
    expect(merged).toContain("y una línea nueva mía");
    expect(merged).toContain("línea c1 consolidada");
    expect(merged).not.toContain("línea c2");
  });

  it("yo agrego al medio, ellos borran una sección entera lejos → limpio", () => {
    const mine = NOTE.replace("línea a2", "línea a2\nlínea a3 nueva mía");
    const theirs = NOTE.replace("\n## sección C\nlínea c1\nlínea c2\n", "\n");
    const merged = expectClean(NOTE, mine, theirs);
    expect(merged).toContain("línea a3 nueva mía");
    expect(merged).not.toContain("sección C");
  });

  it("edito la ÚLTIMA línea y ellos agregan después del final (adyacente) → limpio", () => {
    const base = "uno\ndos\ntres\n";
    const mine = "uno\ndos\ntres bis\n";
    const theirs = "uno\ndos\ntres\ncuatro\n";
    expect(expectClean(base, mine, theirs)).toBe("uno\ndos\ntres bis\ncuatro\n");
  });

  it("cambios en líneas consecutivas pero DISTINTAS (adyacentes) → limpio", () => {
    const base = "uno\ndos\ntres\ncuatro\n";
    const mine = "uno\nDOS mío\ntres\ncuatro\n";
    const theirs = "uno\ndos\nTRES de ellos\ncuatro\n";
    expect(expectClean(base, mine, theirs)).toBe("uno\nDOS mío\nTRES de ellos\ncuatro\n");
  });

  it("sin \\n final en mi lado (tipeo en la última línea) sigue mergeando", () => {
    const base = "uno\ndos";
    const mine = "uno\ndos y sigo tipeando";
    const theirs = "UNO de ellos\ndos";
    expect(expectClean(base, mine, theirs)).toBe("UNO de ellos\ndos y sigo tipeando");
  });
});

describe("merge3 — solapamiento real (conflicto)", () => {
  it("ambos editaron la MISMA línea distinto → conflicto", () => {
    const mine = NOTE.replace("línea b1", "línea b1 mía");
    const theirs = NOTE.replace("línea b1", "línea b1 de ellos");
    expectConflict(NOTE, mine, theirs);
  });

  it("yo edité una línea que ellos borraron → conflicto", () => {
    const mine = NOTE.replace("línea c1", "línea c1 retocada");
    const theirs = NOTE.replace("línea c1\n", "");
    expectConflict(NOTE, mine, theirs);
  });

  it("ambos insertaron DISTINTO en el mismo punto → conflicto", () => {
    const base = "uno\ndos\n";
    const mine = "uno\nmío\ndos\n";
    const theirs = "uno\nde ellos\ndos\n";
    expectConflict(base, mine, theirs);
  });

  it("ambos insertaron LO MISMO en el mismo punto → limpio, sin duplicar", () => {
    const base = "uno\ndos\n";
    const mine = "uno\nnuevo\ndos\n";
    const theirs = "uno\nnuevo\ndos\n";
    expect(expectClean(base, mine, theirs)).toBe("uno\nnuevo\ndos\n");
  });

  it("conflicto en una sección NO contagia al resto (sigue siendo conflicto, pero detectado)", () => {
    // Dos cambios míos: uno limpio (sección A) y uno pisado (sección B). El resultado es
    // conflicto (no hay merge parcial silencioso) — la UI decide.
    const mine = NOTE.replace("línea a1", "línea a1 mía").replace("línea b1", "línea b1 mía");
    const theirs = NOTE.replace("línea b1", "línea b1 de ellos");
    expectConflict(NOTE, mine, theirs);
  });
});

describe("merge3 — resolve (los botones del conflicto)", () => {
  it("resolve='mine' conserva mi línea pisada PERO trae los cambios limpios de ellos", () => {
    const mine = NOTE.replace("línea b1", "línea b1 mía");
    const theirs = NOTE.replace("línea b1", "línea b1 de ellos").replace(
      "línea c1",
      "línea c1 consolidada por REM",
    );
    const r = merge3(NOTE, mine, theirs, "mine");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.merged).toContain("línea b1 mía");
    expect(r.merged).not.toContain("línea b1 de ellos");
    expect(r.merged).toContain("línea c1 consolidada por REM");
  });

  it("resolve='theirs' trae su línea PERO conserva mis cambios limpios", () => {
    const mine = NOTE.replace("línea b1", "línea b1 mía").replace("línea a1", "línea a1 mía limpia");
    const theirs = NOTE.replace("línea b1", "línea b1 de ellos");
    const r = merge3(NOTE, mine, theirs, "theirs");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.merged).toContain("línea b1 de ellos");
    expect(r.merged).not.toContain("línea b1 mía");
    expect(r.merged).toContain("línea a1 mía limpia");
  });
});

describe("merge3 — docs grandes (fallback del LCS)", () => {
  it("por encima del tope, ambos lados tocados → conflicto (conservador, nunca mentiroso)", () => {
    const big = Array.from({ length: 600 }, (_, k) => `línea ${k}`).join("\n");
    const mine = `${big}\nmía al final`;
    const theirs = `${big.replace("línea 0", "línea 0 bis")}`;
    // 600×600 = 360k > 250k celdas tras pelar… acá el prefijo/sufijo comunes reducen el
    // medio, así que el fallback no salta; forzamos lados sin prefijo común:
    const bigA = Array.from({ length: 600 }, (_, k) => `A ${k}`).join("\n");
    const bigB = Array.from({ length: 600 }, (_, k) => `B ${k}`).join("\n");
    const bigO = Array.from({ length: 600 }, (_, k) => `O ${k}`).join("\n");
    expectConflict(bigO, bigA, bigB);
    // y el caso chico de control sigue limpio
    expect(expectClean(big, mine, theirs)).toContain("línea 0 bis");
  });
});

describe("splitLines / changedRegions", () => {
  it("splitLines conserva el \\n y la última línea sin terminador", () => {
    expect(splitLines("a\nb")).toEqual(["a\n", "b"]);
    expect(splitLines("a\nb\n")).toEqual(["a\n", "b\n"]);
    expect(splitLines("")).toEqual([]);
  });

  it("changedRegions: un insert puro queda como región vacía en base", () => {
    const r = changedRegions(["a\n", "c\n"], ["a\n", "b\n", "c\n"]);
    expect(r).toEqual([{ aS: 1, aE: 1, bS: 1, bE: 2 }]);
  });

  it("changedRegions: cambio + borrado → regiones separadas y ordenadas", () => {
    const r = changedRegions(["a\n", "b\n", "c\n", "d\n"], ["a\n", "B\n", "d\n"]);
    expect(r.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < r.length; i++) {
      expect((r[i] as { aS: number }).aS).toBeGreaterThanOrEqual((r[i - 1] as { aE: number }).aE);
    }
  });
});

describe("diffLines (vista del conflicto)", () => {
  it("marca lo mío, lo de ellos y lo común", () => {
    const d = diffLines("uno\nmía\ntres\n", "uno\nde ellos\ntres\n");
    expect(d).toEqual([
      { t: "same", line: "uno" },
      { t: "mine", line: "mía" },
      { t: "theirs", line: "de ellos" },
      { t: "same", line: "tres" },
    ]);
  });

  it("collapseDiff pliega las corridas largas de líneas iguales con contexto de 2", () => {
    const mine = `cambio mío\n${Array.from({ length: 10 }, (_, k) => `igual ${k}`).join("\n")}\nfinal mío\n`;
    const theirs = `cambio de ellos\n${Array.from({ length: 10 }, (_, k) => `igual ${k}`).join("\n")}\nfinal de ellos\n`;
    const v = collapseDiff(diffLines(mine, theirs));
    const skip = v.find((l) => l.t === "skip");
    expect(skip).toEqual({ t: "skip", count: 6 }); // 10 iguales − 2 de contexto por lado
    // los cambios y el contexto siguen presentes
    expect(v.some((l) => l.t === "mine" && l.line === "cambio mío")).toBe(true);
    expect(v.some((l) => l.t === "theirs" && l.line === "final de ellos")).toBe(true);
    expect(v.some((l) => l.t === "same" && l.line === "igual 0")).toBe(true);
    expect(v.some((l) => l.t === "same" && l.line === "igual 9")).toBe(true);
  });

  it("collapseDiff no pliega corridas cortas", () => {
    const v = collapseDiff(diffLines("a\nb\nmía\n", "a\nb\nde ellos\n"));
    expect(v.every((l) => l.t !== "skip")).toBe(true);
  });
});
