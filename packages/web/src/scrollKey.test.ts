import { describe, expect, it } from "vitest";
import { scrollKey } from "./scrollKey";

describe("scrollKey", () => {
  it("misma nota en pestañas distintas → keys distintas (scroll independiente por pestaña)", () => {
    const a = scrollKey("tab-1", "demo", "notas/larga.md");
    const b = scrollKey("tab-2", "demo", "notas/larga.md");
    expect(a).not.toBe(b);
  });

  it("misma pestaña, paths distintos → keys distintas (historial back/forward)", () => {
    const a = scrollKey("tab-1", "demo", "notas/uno.md");
    const b = scrollKey("tab-1", "demo", "notas/dos.md");
    expect(a).not.toBe(b);
  });

  it("mismo tab+repo+path → misma key (estable entre activaciones; sobrevive al cambio de pestaña)", () => {
    const a = scrollKey("tab-1", "demo", "notas/larga.md");
    const b = scrollKey("tab-1", "demo", "notas/larga.md");
    expect(a).toBe(b);
  });

  it("mismo repo/path en repos distintos → keys distintas", () => {
    const a = scrollKey("tab-1", "demo", "notas/larga.md");
    const b = scrollKey("tab-1", "otro", "notas/larga.md");
    expect(a).not.toBe(b);
  });
});
