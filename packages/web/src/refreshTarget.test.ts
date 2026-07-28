import { describe, expect, it } from "vitest";
import { refetchDelays, refreshHitsOpen } from "./refreshTarget.ts";

describe("refreshHitsOpen (#33: ¿la nota abierta cambió?)", () => {
  const open = { repo: "demo-personal", path: "notas/idea.md" };

  it("hit cuando la nota abierta está entre las cambiadas → refetch paciente", () => {
    expect(refreshHitsOpen(open, [{ repo: "demo-personal", path: "notas/idea.md" }])).toBe(true);
  });

  it("no es hit si cambió OTRA nota del mismo repo", () => {
    expect(refreshHitsOpen(open, [{ repo: "demo-personal", path: "otra.md" }])).toBe(false);
  });

  it("no es hit si el path coincide pero en OTRO repo", () => {
    expect(refreshHitsOpen(open, [{ repo: "demo-ceibo", path: "notas/idea.md" }])).toBe(false);
  });

  it("sin nota abierta no es hit", () => {
    expect(refreshHitsOpen(null, [{ repo: "demo-personal", path: "notas/idea.md" }])).toBe(false);
  });

  it("changed ausente (server viejo) o vacío (out-of-band) no es hit", () => {
    expect(refreshHitsOpen(open, undefined)).toBe(false);
    expect(refreshHitsOpen(open, [])).toBe(false);
  });
});

describe("refetchDelays (#33: escalera robusta al CDN)", () => {
  it("expectChange: escalera larga (>2.3s acumulado) para esperar la propagación del CDN", () => {
    const d = refetchDelays(true);
    expect(d[0]).toBe(0); // intento inmediato
    const total = d.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(2300); // más paciente que la corta
    expect(d.length).toBeGreaterThan(4);
  });

  it("sin expectChange: escalera corta de revalidación (~2.3s)", () => {
    expect(refetchDelays(false)).toEqual([0, 400, 700, 1200]);
  });
});
