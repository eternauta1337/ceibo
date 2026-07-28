import { describe, expect, it } from "vitest";
import { orbHintClass } from "./OrbHint.tsx";

// Test de la clase del underhint (componente <OrbHint>). El nombre del archivo NO es `OrbHint.test.ts`
// a propósito: en el FS case-insensitive de macOS colisionaría con `orbHint.test.ts` (el test de
// `computeOrbHint`). Por eso `orbHintClass.test.ts`, por el helper puro que prueba.
describe("orbHintClass (className de la píldora del underhint)", () => {
  it("arma look + status + phase del orbe principal (sin variante)", () => {
    expect(orbHintClass("idle", "in")).toBe("orb-hint orb-hint-idle orb-hint-in");
    expect(orbHintClass("thinking", "out")).toBe("orb-hint orb-hint-thinking orb-hint-out");
  });

  it("preserva el contrato exacto de clases del `<p>` inline que reemplazó", () => {
    // Mismo orden/forma que `orb-hint orb-hint-${status} orb-hint-${phase}` del App.tsx previo.
    expect(orbHintClass("recording", "in")).toBe("orb-hint orb-hint-recording orb-hint-in");
  });

  it("agrega el modificador `orb-hint-<variant>` al final cuando hay variante (ej. mini-orb)", () => {
    expect(orbHintClass("idle", "in", "sub")).toBe("orb-hint orb-hint-idle orb-hint-in orb-hint-sub");
  });

  it("sin variante NO agrega clase de variante de más (ni un espacio colgando)", () => {
    expect(orbHintClass("speaking", "out", undefined)).toBe("orb-hint orb-hint-speaking orb-hint-out");
    expect(orbHintClass("speaking", "out", "")).toBe("orb-hint orb-hint-speaking orb-hint-out");
  });
});
