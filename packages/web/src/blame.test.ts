import { describe, expect, it } from "vitest";
import {
  avatarAnchors,
  BLAME_AI_COLOR,
  BLAME_HISTORIC_COLOR,
  type BlameRangeWire,
  blameColor,
  blameTipLines,
  identityKey,
  lineBlame,
  rangeIdentity,
} from "./blame.ts";

const range = (
  start: number,
  end: number,
  handle: string | null = "anni",
  source: "web" | "agent" | null = null,
): BlameRangeWire => ({
  start,
  end,
  handle,
  name: handle ? "Anni" : null,
  date: "2026-06-09T12:00:00Z",
  sha: "c1",
  source,
});

describe("blameColor", () => {
  it("es estable: mismo handle → mismo color, siempre", () => {
    expect(blameColor("anni")).toBe(blameColor("anni"));
    expect(blameColor("demo")).toBe(blameColor("demo"));
  });
  it("devuelve un color hex de la paleta", () => {
    expect(blameColor("cualquiera")).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("handles distintos suelen diferir (no garantizado, pero estos sí)", () => {
    // Tres handles reales del producto: si colisionaran todos, la paleta/hash está rota.
    const colors = new Set([blameColor("demo"), blameColor("anni"), blameColor("azul")]);
    expect(colors.size).toBeGreaterThan(1);
  });
  it("el gris histórico NO está en la paleta de autores (no se confunde con una persona)", () => {
    for (const h of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]) {
      expect(blameColor(h)).not.toBe(BLAME_HISTORIC_COLOR);
    }
  });
});

describe("rangeIdentity (quién se muestra como autor)", () => {
  it("compartida: handle → user con su color, da igual el source", () => {
    for (const source of ["web", "agent", null] as const) {
      const id = rangeIdentity(range(1, 1, "anni", source), true);
      expect(id).toEqual({
        kind: "user",
        handle: "anni",
        name: "Anni",
        color: blameColor("anni"),
        hasAvatar: false,
      });
    }
  });
  it("hasAvatar viaja a la identidad (gating del chip con foto, como el explorer)", () => {
    const id = rangeIdentity({ ...range(1, 1, "anni", "web"), hasAvatar: true }, true);
    expect(id.kind === "user" && id.hasAvatar).toBe(true);
  });
  it("compartida: handle null → histórico", () => {
    expect(rangeIdentity(range(1, 1, null), true).kind).toBe("historic");
  });
  it("personal: source 'agent' → ceibo (IA), aunque el commit lleve el handle del dueño", () => {
    const id = rangeIdentity(range(1, 1, "demo", "agent"), false);
    expect(id).toEqual({ kind: "ai", color: BLAME_AI_COLOR });
  });
  it("personal: source 'web' → el usuario (edición humana)", () => {
    expect(rangeIdentity(range(1, 1, "demo", "web"), false).kind).toBe("user");
  });
  it("personal: source desconocido → histórico (humano/IA no reconstruible)", () => {
    expect(rangeIdentity(range(1, 1, "demo", null), false).kind).toBe("historic");
  });
  it("identityKey agrupa por autor visual, no por range", () => {
    expect(identityKey(rangeIdentity(range(1, 1, "anni", "web"), true))).toBe(
      identityKey(rangeIdentity(range(5, 9, "anni", "agent"), true)),
    );
    expect(identityKey(rangeIdentity(range(1, 1, "demo", "agent"), false))).toBe("ai");
    expect(identityKey(rangeIdentity(range(1, 1, null), true))).toBe("historic");
  });
});

describe("blameTipLines (contenido del tooltip)", () => {
  it("autor real → nombre, @handle y fecha (día ISO)", () => {
    expect(blameTipLines(range(1, 1), true)).toEqual(["Anni", "@anni", "2026-06-09"]);
  });
  it("sin name → cae al handle", () => {
    expect(blameTipLines({ ...range(1, 1), name: null }, true)[0]).toBe("anni");
  });
  it("el viewer ve sus propias líneas como '(vos)'", () => {
    expect(blameTipLines(range(1, 1, "anni"), true, "anni")[0]).toBe("Anni (vos)");
    expect(blameTipLines(range(1, 1, "anni"), true, "demo")[0]).toBe("Anni");
  });
  it("source conocido → 'vía web' / 'por ceibo (IA)' junto a la fecha", () => {
    expect(blameTipLines(range(1, 1, "anni", "web"), true)[2]).toBe("2026-06-09 · vía web");
    expect(blameTipLines(range(1, 1, "anni", "agent"), true)[2]).toBe("2026-06-09 · por ceibo (IA)");
    expect(blameTipLines(range(1, 1, "anni", null), true)[2]).toBe("2026-06-09");
  });
  it("personal + source 'agent' → identidad ceibo (IA) con fecha", () => {
    expect(blameTipLines(range(1, 1, "demo", "agent"), false)).toEqual(["ceibo (IA)", "2026-06-09"]);
  });
  it("histórico → etiqueta fija, sin nombre ni fecha", () => {
    expect(blameTipLines(range(1, 1, null), true)).toEqual(["histórico", "anterior al registro de autoría"]);
  });
});

describe("lineBlame (mapeo archivo → editor con offset del H1 oculto)", () => {
  it("sin offset: cada línea del rango apunta a su range", () => {
    const m = lineBlame([range(1, 2), range(3, 3, null)], 0, 10);
    expect(m.get(1)?.handle).toBe("anni");
    expect(m.get(2)?.handle).toBe("anni");
    expect(m.get(3)?.handle).toBeNull();
    expect(m.has(4)).toBe(false);
  });
  it("offset del prefijo oculto: la línea N del archivo es la N-offset del editor", () => {
    // Archivo: "# titulo\n\ncuerpo1\ncuerpo2" → prefijo de 2 líneas ocultas (offset 2).
    const m = lineBlame([range(1, 2), range(3, 4)], 2, 10);
    expect(m.has(1)).toBe(true); // archivo 3 → editor 1
    expect(m.get(1)?.start).toBe(3);
    expect(m.get(2)?.start).toBe(3); // archivo 4 → editor 2
    // El rango 1-2 (el H1 oculto) cae fuera del editor (líneas <1) → no aparece.
    expect([...m.keys()].every((k) => k >= 1)).toBe(true);
  });
  it("acota a lineCount: rangos más largos que el doc no generan líneas fantasma", () => {
    const m = lineBlame([range(1, 100)], 0, 3);
    expect([...m.keys()].sort()).toEqual([1, 2, 3]);
  });
  it("vacío → mapa vacío", () => {
    expect(lineBlame([], 0, 5).size).toBe(0);
  });
});

describe("avatarAnchors (un avatar por tramo contiguo, no por línea)", () => {
  it("dos ranges seguidos del MISMO autor comparten un solo avatar", () => {
    // anni 1-3 (sha A) y anni 4-5 (sha B): contiguos → un solo anchor en 1.
    const m = lineBlame([range(1, 3, "anni"), range(4, 5, "anni")], 0, 10);
    expect(avatarAnchors(m, true)).toEqual([1]);
  });
  it("cambio de autor o hueco → anchor nuevo", () => {
    const m = lineBlame([range(1, 2, "anni"), range(3, 4, "demo"), range(8, 9, "anni")], 0, 10);
    expect(avatarAnchors(m, true)).toEqual([1, 3, 8]);
  });
  it("histórico no lleva avatar, pero corta el tramo", () => {
    const m = lineBlame([range(1, 2, "anni"), range(3, 3, null), range(4, 5, "anni")], 0, 10);
    expect(avatarAnchors(m, true)).toEqual([1, 4]);
  });
  it("personal: tramos del usuario y de la IA alternados → anchor por cada cambio", () => {
    const m = lineBlame(
      [range(1, 2, "demo", "web"), range(3, 4, "demo", "agent"), range(5, 6, "demo", "web")],
      0,
      10,
    );
    expect(avatarAnchors(m, false)).toEqual([1, 3, 5]);
  });
  it("personal: source desconocido es histórico → sin avatar", () => {
    const m = lineBlame([range(1, 4, "demo", null)], 0, 10);
    expect(avatarAnchors(m, false)).toEqual([]);
  });
});
