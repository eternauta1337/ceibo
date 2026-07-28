import { describe, expect, it } from "vitest";
import { saveRetryPlan } from "./saveRetry.ts";

// Presupuesto de ejemplo: 6 reintentos, backoff lineal de 800ms capeado a 3000ms.
const MAX = 6;
const BASE = 800;
const CAP = 3000;

describe("saveRetryPlan (reintento del autosave ante fallo transitorio)", () => {
  it("reintenta con backoff lineal en los primeros intentos", () => {
    expect(saveRetryPlan(1, MAX, BASE, CAP)).toEqual({ retry: true, delayMs: 800 });
    expect(saveRetryPlan(2, MAX, BASE, CAP)).toEqual({ retry: true, delayMs: 1600 });
    expect(saveRetryPlan(3, MAX, BASE, CAP)).toEqual({ retry: true, delayMs: 2400 });
  });

  it("capea el delay a capMs", () => {
    expect(saveRetryPlan(4, MAX, BASE, CAP).delayMs).toBe(3000); // 800*4=3200 -> cap 3000
    expect(saveRetryPlan(5, MAX, BASE, CAP).delayMs).toBe(3000);
    expect(saveRetryPlan(6, MAX, BASE, CAP).delayMs).toBe(3000);
  });

  it("se rinde (retry:false) al superar el presupuesto", () => {
    expect(saveRetryPlan(7, MAX, BASE, CAP)).toEqual({ retry: false, delayMs: 0 });
    expect(saveRetryPlan(100, MAX, BASE, CAP).retry).toBe(false);
  });

  it("el presupuesto total es holgado vs el read-after-write de GitHub (~13s > los ~5s de antes)", () => {
    let total = 0;
    for (let a = 1; a <= MAX; a++) total += saveRetryPlan(a, MAX, BASE, CAP).delayMs;
    expect(total).toBeGreaterThan(12000); // 800+1600+2400+3000+3000+3000 = 13800ms
  });
});
