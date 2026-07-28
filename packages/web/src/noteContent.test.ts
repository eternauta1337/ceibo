import { describe, expect, it } from "vitest";
import { withTrailingNewline } from "./noteContent.ts";

describe("withTrailingNewline", () => {
  it("appendea un `\\n` si falta (la causa del bug de blame)", () => {
    // Una nota de una sola línea sin Enter final: sin esto, el siguiente que appendea le
    // reescribe los bytes a esta línea y el blame le roba la autoría.
    expect(withTrailingNewline("línea 1")).toBe("línea 1\n");
  });

  it("no toca el contenido si ya termina en `\\n` (idempotente)", () => {
    expect(withTrailingNewline("línea 1\n")).toBe("línea 1\n");
    expect(withTrailingNewline(withTrailingNewline("x"))).toBe("x\n");
  });

  it("no colapsa newlines finales múltiples (sólo garantiza ≥1)", () => {
    // Sólo nos importa que la ÚLTIMA línea esté newline-terminada; las líneas en blanco
    // que el usuario tipeó a propósito se respetan.
    expect(withTrailingNewline("a\n\n\n")).toBe("a\n\n\n");
  });

  it("vacío queda vacío (no inventamos contenido)", () => {
    expect(withTrailingNewline("")).toBe("");
  });

  it("preserva el cuerpo intacto, sólo agrega el `\\n` final", () => {
    expect(withTrailingNewline("# Título\n\ncuerpo\nmás")).toBe("# Título\n\ncuerpo\nmás\n");
  });
});
