import { describe, expect, it } from "vitest";
import { pickDirection, pickRotationStep } from "./rotation.ts";

// rng determinista de secuencia: devuelve los valores dados en orden (loopea al final).
function seq(...vals: number[]): () => number {
  let i = 0;
  return () => vals[i++ % vals.length] as number;
}

describe("pickDirection (horario / anti-horario)", () => {
  it("rng < 0.5 → horario (-1); rng >= 0.5 → anti-horario (+1)", () => {
    expect(pickDirection(() => 0)).toBe(-1);
    expect(pickDirection(() => 0.49)).toBe(-1);
    expect(pickDirection(() => 0.5)).toBe(1);
    expect(pickDirection(() => 0.99)).toBe(1);
  });

  it("ambos sentidos son alcanzables", () => {
    const dirs = new Set([pickDirection(() => 0.1), pickDirection(() => 0.9)]);
    expect(dirs).toEqual(new Set([-1, 1]));
  });
});

describe("pickRotationStep (giro rápido a posición random)", () => {
  it("magnitud = base + random·spread, con signo del sentido elegido", () => {
    // 1er draw (dir): 0.9 → +1 ; 2º draw (mag): 0.5 → base + 0.5·spread
    expect(pickRotationStep(seq(0.9, 0.5), 0.8, 3.2)).toBeCloseTo(0.8 + 0.5 * 3.2);
    // dir horario: 0.1 → -1
    expect(pickRotationStep(seq(0.1, 0.5), 0.8, 3.2)).toBeCloseTo(-(0.8 + 0.5 * 3.2));
  });

  it("base/spread = 0 → step 0 (estados sin rotación, p.ej. idle, no giran)", () => {
    expect(pickRotationStep(seq(0.9, 0.7), 0, 0)).toBe(0);
    expect(pickRotationStep(seq(0.1, 0.7), 0, 0)).toBe(-0); // -1·0
  });

  it("el signo lo fija el sentido, no se invierte por 'el lado más corto' (delta acumulable)", () => {
    // spread alto: el step puede pasar de media vuelta y se respeta el signo (no se envuelve)
    const big = pickRotationStep(seq(0.9, 0.99), 0.8, 6.2); // +1 · (0.8 + ~6.14)
    expect(big).toBeGreaterThan(Math.PI); // > media vuelta, sin wrap al lado corto
  });

  it("base/spread negativos se clampean a 0 (un step no invierte su propio signo)", () => {
    expect(pickRotationStep(seq(0.9, 0.5), -1, -2)).toBe(0);
  });
});
