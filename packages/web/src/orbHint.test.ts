import { describe, expect, it } from "vitest";
import { computeOrbHint, subagentCountHint } from "./orbHint.ts";

// Valores neutros para parámetros que no importan en cada caso.
const noActivity = null;
const noSubagents = 0;
const notHandsfree = false;

describe("computeOrbHint (microcopy del hint bajo el orbe)", () => {
  describe("grabando (tap-to-toggle)", () => {
    it("muestra 'Tocá para terminar' cuando handsfree=true (sin importar status)", () => {
      expect(computeOrbHint("idle", noActivity, noSubagents, true)).toBe("Tocá para terminar");
      expect(computeOrbHint("recording", noActivity, noSubagents, true)).toBe("Tocá para terminar");
    });
  });

  describe("estado recording", () => {
    it("muestra 'Tocá para terminar' mientras grabás", () => {
      expect(computeOrbHint("recording", noActivity, noSubagents, notHandsfree)).toBe("Tocá para terminar");
    });
  });

  describe("estado idle sin subagentes", () => {
    it("muestra 'Tocá para hablar'", () => {
      const hint = computeOrbHint("idle", noActivity, noSubagents, notHandsfree);
      expect(hint).toBe("Tocá para hablar");
    });
  });

  describe("otros estados", () => {
    it("connecting → 'conectando…'", () => {
      expect(computeOrbHint("connecting", noActivity, noSubagents, notHandsfree)).toBe("conectando…");
    });

    it("thinking sin actividad → 'pensando…'", () => {
      expect(computeOrbHint("thinking", noActivity, noSubagents, notHandsfree)).toBe("pensando…");
    });

    it("thinking con actividad → muestra el label de la actividad", () => {
      expect(computeOrbHint("thinking", "buscando en la wiki", noSubagents, notHandsfree)).toBe(
        "buscando en la wiki",
      );
    });

    it("speaking sin actividad → 'hablando…'", () => {
      expect(computeOrbHint("speaking", noActivity, noSubagents, notHandsfree)).toBe("hablando…");
    });

    it("idle con subagentes activos → 'subagente creado'", () => {
      expect(computeOrbHint("idle", noActivity, 2, notHandsfree)).toBe("subagente creado");
    });

    it("idle con subagentes activos PERO el 2º underhint visible (hasSubHint) → NO duplica, vuelve al idle", () => {
      // El segundo underhint ya muestra "Corriendo N subagentes" → el principal no repite.
      expect(computeOrbHint("idle", noActivity, 2, notHandsfree, true)).toBe("Tocá para hablar");
    });
  });
});

describe("subagentCountHint (texto del 2º underhint: 'Corriendo N subagentes')", () => {
  it("N ≤ 0 → vacío (no se muestra)", () => {
    expect(subagentCountHint(0)).toBe("");
    expect(subagentCountHint(-1)).toBe("");
  });

  it("singular para N==1", () => {
    expect(subagentCountHint(1)).toBe("Corriendo 1 subagente");
  });

  it("plural para N>1", () => {
    expect(subagentCountHint(2)).toBe("Corriendo 2 subagentes");
    expect(subagentCountHint(5)).toBe("Corriendo 5 subagentes");
  });
});
