import type { BroadcastRow, DailyRow, ModelUsageRow, SpendRow } from "@ceibo/store";
import { describe, expect, it } from "vitest";
import {
  BAR_WIDTH,
  bar,
  broadcastLine,
  fmtInt,
  isYes,
  label,
  renderDaily,
  renderModelUsage,
  renderSpendReport,
} from "./format.ts";

describe("label", () => {
  it("con nombre → 'handle (nombre)'", () => {
    expect(label({ handle: "owner", name: "Alicia" })).toBe("owner (Alicia)");
  });
  it("sin nombre → handle pelado", () => {
    expect(label({ handle: "owner", name: null })).toBe("owner");
  });
});

describe("fmtInt", () => {
  it("separador de miles en-US", () => {
    expect(fmtInt(1234567)).toBe("1,234,567");
    expect(fmtInt(0)).toBe("0");
  });
});

describe("bar", () => {
  it("ancho fijo siempre (lleno + vacío = BAR_WIDTH)", () => {
    const b = bar(3, 10);
    expect([...b].length).toBe(BAR_WIDTH);
  });
  it("value 0 → todo vacío", () => {
    expect(bar(0, 10)).toBe("░".repeat(BAR_WIDTH));
  });
  it("value == max → todo lleno", () => {
    expect(bar(10, 10)).toBe("█".repeat(BAR_WIDTH));
  });
  it("max 0 → todo vacío (sin división por cero)", () => {
    expect(bar(5, 0)).toBe("░".repeat(BAR_WIDTH));
  });
  it("redondea la proporción", () => {
    // 5/10 * 30 = 15 llenos
    expect(bar(5, 10).startsWith("█".repeat(15))).toBe(true);
    expect([...bar(5, 10)].filter((c) => c === "█").length).toBe(15);
  });
});

const row = (over: Partial<DailyRow>): DailyRow =>
  ({ handle: "owner", day: "2026-06-01", cost_usd: 1, turns: 1, ...over }) as DailyRow;

describe("renderDaily", () => {
  it("sin filas → aviso", () => {
    expect(renderDaily([], false)).toBe("(sin consumo registrado)");
  });

  it("single: encabezado por usuario, una fila por día y TOTAL sumado", () => {
    const rows = [
      row({ day: "2026-06-01", cost_usd: 2, turns: 3 }),
      row({ day: "2026-06-02", cost_usd: 4, turns: 5 }),
    ];
    const out = renderDaily(rows, true);
    expect(out).toContain("Consumo diario · owner");
    expect(out).toContain("BA, 2026-06-01 → 2026-06-02");
    expect(out).toContain("TOTAL: $6.0000");
    // el día se muestra sin el año (slice(5))
    expect(out).toContain("06-01");
  });

  it("multi: agrupa por usuario y ordena por gasto total desc", () => {
    const rows = [
      row({ handle: "lula", day: "2026-06-01", cost_usd: 1 }),
      row({ handle: "owner", day: "2026-06-01", cost_usd: 9 }),
    ];
    const out = renderDaily(rows, false);
    expect(out).toContain("barras a escala común");
    // owner (9) va antes que lula (1)
    expect(out.indexOf("owner")).toBeLessThan(out.indexOf("lula"));
  });
});

describe("isYes", () => {
  it("acepta si/sí/s/y/yes en cualquier casing, con espacios", () => {
    for (const a of ["si", "Sí", "S", "y", "YES", "  yes  "]) expect(isYes(a)).toBe(true);
  });
  it("rechaza lo demás", () => {
    for (const a of ["no", "n", "nope", "", "yeah"]) expect(isYes(a)).toBe(false);
  });
});

const brow = (over: Partial<BroadcastRow> = {}): BroadcastRow =>
  ({
    id: 1,
    text: "hola",
    sent_count: 5,
    failed_count: 0,
    created_at: "2026-06-01",
    ...over,
  }) as BroadcastRow;

describe("broadcastLine", () => {
  it("incluye id, fecha, enviados; sin fallidos no muestra el sufijo", () => {
    expect(broadcastLine(brow())).toContain("#1");
    expect(broadcastLine(brow())).toContain("5 ok");
    expect(broadcastLine(brow())).not.toContain("fallaron");
  });
  it("con fallidos muestra el sufijo y colapsa saltos de línea en el preview", () => {
    const line = broadcastLine(brow({ failed_count: 2, text: "línea1\nlínea2" }));
    expect(line).toContain("2 fallaron");
    expect(line).toContain("línea1 línea2");
  });
});

const srow = (over: Partial<SpendRow> = {}): SpendRow =>
  ({
    user_id: 1,
    handle: "demo",
    name: null,
    turns: 3,
    input_tokens: 1000,
    output_tokens: 500,
    cache_5m_tokens: 0,
    cache_1h_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 1.5,
    ...over,
  }) as SpendRow;

describe("renderSpendReport", () => {
  it("vacío → '' (el caller muestra (sin usuarios))", () => {
    expect(renderSpendReport([], 1)).toBe("");
  });
  it("un usuario: header con markup, sin TOTAL", () => {
    const out = renderSpendReport([srow()], 1.2);
    expect(out).toContain("markup ×1.2");
    expect(out).toContain("demo");
    expect(out).toContain("in:1,000"); // fmtInt
    expect(out).not.toContain("TOTAL");
  });
  it("varios usuarios: TOTAL suma los costos", () => {
    const out = renderSpendReport([srow({ cost_usd: 1.5 }), srow({ handle: "lula", cost_usd: 2.5 })], 1);
    expect(out).toContain("TOTAL: $4.0000");
  });
});

const mrow = (over: Partial<ModelUsageRow> = {}): ModelUsageRow =>
  ({
    model: "gemma4-31b",
    users: 1,
    turns: 2,
    input_tokens: 1000,
    output_tokens: 250,
    cache_read_tokens: 500,
    cost_usd: 0,
    ...over,
  }) as ModelUsageRow;

describe("renderModelUsage", () => {
  it("vacío → aviso", () => {
    expect(renderModelUsage([])).toBe("(sin consumo registrado)");
  });

  it("muestra modelos, tokens y total", () => {
    const out = renderModelUsage([mrow(), mrow({ model: "claude-sonnet-4-6", cost_usd: 2.5, turns: 1 })]);
    expect(out).toContain("Uso por modelo");
    expect(out).toContain("gemma4-31b");
    expect(out).toContain("claude-sonnet-4-6");
    expect(out).toContain("in:1,000");
    expect(out).toContain("TOTAL: 3 turnos · $2.5000");
  });
});
