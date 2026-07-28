// Formato del timing del turno en la línea de log `$ [uid] … ttft:Xs gen:Ys → $…`. El TTFT es
// la única señal warm/cold del prefill (el `cache:X/Y` es siempre 0/0 en backend local; ver
// quickboot/mediciones.md). Ver `fmtTurnTiming` en engine.ts.
import { describe, expect, it } from "vitest";
import { fmtTurnTiming } from "./engine.ts";

describe("fmtTurnTiming", () => {
  it("sin timing (MA / turno sin send) → string vacío", () => {
    expect(fmtTurnTiming(undefined)).toBe("");
    expect(fmtTurnTiming({})).toBe("");
  });

  it("ttft + turn → `ttft:Xs gen:Ys ` (gen = turn − ttft, con espacio final)", () => {
    expect(fmtTurnTiming({ ttftMs: 21400, turnMs: 22600 })).toBe("ttft:21.4s gen:1.2s ");
  });

  it("prefill caliente: ttft chico aunque el contexto sea grande", () => {
    expect(fmtTurnTiming({ ttftMs: 200, turnMs: 1700 })).toBe("ttft:0.2s gen:1.5s ");
  });

  it("solo turnMs (sin token de asistente) → `turn:Xs `", () => {
    expect(fmtTurnTiming({ turnMs: 900 })).toBe("turn:0.9s ");
  });

  it("gen nunca negativo (clamp a 0 si turn < ttft por jitter de reloj)", () => {
    expect(fmtTurnTiming({ ttftMs: 1000, turnMs: 900 })).toBe("ttft:1.0s gen:0.0s ");
  });
});
