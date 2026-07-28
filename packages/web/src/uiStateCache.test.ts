import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushScrollCache,
  readScrollCache,
  saveScrollDebounced,
  scrollCacheKey,
  writeScrollCache,
} from "./uiStateCache";

// --- localStorage stub (node no tiene localStorage) --------------------------------

const _store: Record<string, string> = {};
const localStorageMock = {
  getItem: (k: string) => _store[k] ?? null,
  setItem: (k: string, v: string) => {
    _store[k] = v;
  },
  removeItem: (k: string) => {
    delete _store[k];
  },
  clear: () => {
    for (const k of Object.keys(_store)) delete _store[k];
  },
};

beforeEach(() => {
  localStorageMock.clear();
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorageMock,
    writable: true,
    configurable: true,
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// --- scrollCacheKey ----------------------------------------------------------------

describe("scrollCacheKey", () => {
  it("combina repo y path con /", () => {
    expect(scrollCacheKey("demo", "notas/larga.md")).toBe("demo/notas/larga.md");
  });

  it("repos distintos → keys distintas", () => {
    const a = scrollCacheKey("demo", "nota.md");
    const b = scrollCacheKey("otro", "nota.md");
    expect(a).not.toBe(b);
  });

  it("paths distintos → keys distintas", () => {
    const a = scrollCacheKey("demo", "uno.md");
    const b = scrollCacheKey("demo", "dos.md");
    expect(a).not.toBe(b);
  });
});

// --- readScrollCache ---------------------------------------------------------------

describe("readScrollCache", () => {
  it("handle undefined → objeto vacío", () => {
    expect(readScrollCache(undefined)).toEqual({});
  });

  it("key ausente → objeto vacío", () => {
    expect(readScrollCache("demo")).toEqual({});
  });

  it("JSON corrupto → objeto vacío (no lanza)", () => {
    localStorage.setItem("ceibo_scroll:demo", "{invalid json");
    expect(readScrollCache("demo")).toEqual({});
  });

  it("formato inesperado (array) → objeto vacío", () => {
    localStorage.setItem("ceibo_scroll:demo", JSON.stringify([1, 2, 3]));
    expect(readScrollCache("demo")).toEqual({});
  });

  it("filtra valores no-numéricos sin tirar", () => {
    localStorage.setItem(
      "ceibo_scroll:demo",
      JSON.stringify({ "demo/nota.md": 120, "demo/otra.md": "bad", "demo/tercera.md": null }),
    );
    const result = readScrollCache("demo");
    expect(result["demo/nota.md"]).toBe(120);
    expect("demo/otra.md" in result).toBe(false);
    expect("demo/tercera.md" in result).toBe(false);
  });

  it("filtra valores negativos o no finitos", () => {
    localStorage.setItem("ceibo_scroll:demo", JSON.stringify({ "demo/a.md": -5, "demo/b.md": Infinity }));
    const result = readScrollCache("demo");
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("lee un cache válido correctamente", () => {
    localStorage.setItem("ceibo_scroll:demo", JSON.stringify({ "demo/nota.md": 350, "wiki/doc.md": 120 }));
    expect(readScrollCache("demo")).toEqual({ "demo/nota.md": 350, "wiki/doc.md": 120 });
  });

  it("aísla handles distintos", () => {
    localStorage.setItem("ceibo_scroll:demo", JSON.stringify({ "demo/nota.md": 200 }));
    expect(readScrollCache("otro")).toEqual({});
  });
});

// --- writeScrollCache --------------------------------------------------------------

describe("writeScrollCache", () => {
  it("handle undefined → no-op", () => {
    writeScrollCache(undefined, { "demo/nota.md": 100 });
    expect(Object.keys(_store)).toHaveLength(0);
  });

  it("persiste las posiciones correctamente", () => {
    writeScrollCache("demo", { "demo/nota.md": 200, "wiki/doc.md": 50 });
    const back = readScrollCache("demo");
    expect(back).toEqual({ "demo/nota.md": 200, "wiki/doc.md": 50 });
  });

  it("aplica cap LRU: guarda sólo las últimas SCROLL_MAX (100) entradas", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 110; i++) big[`demo/nota-${i}.md`] = i * 10;
    writeScrollCache("demo", big);
    const back = readScrollCache("demo");
    expect(Object.keys(back)).toHaveLength(100);
    // Las 100 últimas (índices 10..109)
    expect(back["demo/nota-10.md"]).toBe(100);
    expect(back["demo/nota-109.md"]).toBe(1090);
    // Las 10 primeras deben haber caído
    expect("demo/nota-0.md" in back).toBe(false);
    expect("demo/nota-9.md" in back).toBe(false);
  });
});

// --- saveScrollDebounced -----------------------------------------------------------

describe("saveScrollDebounced", () => {
  it("handle undefined → no-op", () => {
    const positions: Record<string, number> = {};
    saveScrollDebounced(undefined, positions, "demo", "nota.md", 100);
    vi.runAllTimers();
    expect(Object.keys(_store)).toHaveLength(0);
  });

  it("escribe al localStorage después del debounce", () => {
    const positions: Record<string, number> = {};
    saveScrollDebounced("demo", positions, "demo", "nota.md", 200);
    expect(Object.keys(_store)).toHaveLength(0); // todavía no
    vi.runAllTimers();
    const back = readScrollCache("demo");
    expect(back["demo/nota.md"]).toBe(200);
  });

  it("actualiza positions in-place inmediatamente (sin esperar el timer)", () => {
    const positions: Record<string, number> = {};
    saveScrollDebounced("demo", positions, "demo", "nota.md", 150);
    expect(positions["demo/nota.md"]).toBe(150); // in-place inmediato
  });

  it("colapsa llamadas múltiples: solo la última llega al localStorage", () => {
    const positions: Record<string, number> = {};
    saveScrollDebounced("demo", positions, "demo", "nota.md", 100, 300);
    saveScrollDebounced("demo", positions, "demo", "nota.md", 200, 300);
    saveScrollDebounced("demo", positions, "demo", "nota.md", 300, 300);
    vi.runAllTimers();
    expect(readScrollCache("demo")["demo/nota.md"]).toBe(300);
  });

  it("distintos handles no comparten timer", () => {
    const posA: Record<string, number> = {};
    const posB: Record<string, number> = {};
    saveScrollDebounced("demo", posA, "demo", "nota.md", 100, 300);
    saveScrollDebounced("otro", posB, "otro", "nota.md", 200, 300);
    vi.runAllTimers();
    expect(readScrollCache("demo")["demo/nota.md"]).toBe(100);
    expect(readScrollCache("otro")["otro/nota.md"]).toBe(200);
  });
});

// --- flushScrollCache --------------------------------------------------------------

describe("flushScrollCache", () => {
  it("handle undefined → no-op", () => {
    flushScrollCache(undefined, { "demo/nota.md": 100 });
    expect(Object.keys(_store)).toHaveLength(0);
  });

  it("escribe inmediatamente sin esperar el timer", () => {
    const positions: Record<string, number> = {};
    saveScrollDebounced("demo", positions, "demo", "nota.md", 400, 300);
    // Todavía no se escribió (timer pendiente)
    expect(Object.keys(_store)).toHaveLength(0);
    flushScrollCache("demo", positions);
    // Ahora sí
    expect(readScrollCache("demo")["demo/nota.md"]).toBe(400);
  });

  it("cancela el timer pendiente (no doble escritura al correr los timers)", () => {
    const positions: Record<string, number> = {};
    saveScrollDebounced("demo", positions, "demo", "nota.md", 500, 300);
    flushScrollCache("demo", positions);
    // Actualizar posición después del flush
    positions["demo/nota.md"] = 999;
    vi.runAllTimers(); // el timer viejo fue cancelado → no escribe 999
    // El flush ya escribió 500; no debe haber timer pendiente que pisara con 999
    expect(readScrollCache("demo")["demo/nota.md"]).toBe(500);
  });
});
