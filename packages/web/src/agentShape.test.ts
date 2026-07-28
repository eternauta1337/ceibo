import { describe, expect, it } from "vitest";
import { shapeForAgent } from "./agentShape.ts";

// rng determinista: devuelve `v` fijo → elige siempre el mismo índice del tier.
const fixed = (v: number) => () => v;

describe("shapeForAgent (estado del agente → forma del orbe)", () => {
  it("estados de I/O y no-pensando → círculo (la activity/sub-agente no importan fuera de thinking)", () => {
    for (const s of ["idle", "recording", "speaking", "connecting", "unauth"] as const) {
      expect(shapeForAgent(s, null, false, fixed(0))).toBe("circle");
      expect(shapeForAgent(s, "buscando en la wiki", true, fixed(0.99))).toBe("circle");
    }
  });

  it("pensando puro → tier 3–4 lados (triángulo/cuadrado)", () => {
    expect(shapeForAgent("thinking", null, false, fixed(0))).toBe("triangle");
    expect(shapeForAgent("thinking", null, false, fixed(0.99))).toBe("square");
  });

  it("pensando con un tool-call en curso → tier 5–6 lados (pentágono/hexágono)", () => {
    expect(shapeForAgent("thinking", "actualizando nota", false, fixed(0))).toBe("pentagon");
    expect(shapeForAgent("thinking", "actualizando nota", false, fixed(0.99))).toBe("hexagon");
  });

  it("delegando en un sub-agente → tier 7–8 lados (heptágono/octágono); gana sobre el tool-call", () => {
    expect(shapeForAgent("thinking", null, true, fixed(0))).toBe("heptagon");
    expect(shapeForAgent("thinking", "consultando a un especialista", true, fixed(0.99))).toBe("octagon");
  });

  it("precedencia: sub-agente > tool > pensar puro", () => {
    // mismo input que el tier 'tool' pero con sub-agente activo → tier sub-agente
    expect(shapeForAgent("thinking", "actualizando nota", true, fixed(0))).toBe("heptagon");
  });

  it("los tiers NO se solapan en nº de lados (pensar 3–4 < tool 5–6 < sub-agente 7–8)", () => {
    // recorre todo el rango de rng para cubrir ambas formas de cada tier
    for (const v of [0, 0.49, 0.5, 0.99]) {
      expect(["triangle", "square"]).toContain(shapeForAgent("thinking", null, false, fixed(v)));
      expect(["pentagon", "hexagon"]).toContain(shapeForAgent("thinking", "x", false, fixed(v)));
      expect(["heptagon", "octagon"]).toContain(shapeForAgent("thinking", null, true, fixed(v)));
    }
  });
});
