import { describe, expect, it } from "vitest";
import { addUser, type Db, modelUsageReport, openDb, spendDaily } from "./index.ts";

// DB en memoria + inserción directa en usage_turns con `ts` controlado (recordTurn
// siempre usa datetime('now'), no sirve para ejercitar buckets por día).
const freshDb = () => openDb(":memory:");

function turn(
  db: Db,
  userId: number,
  ts: string,
  costUsd: number,
  tokens = 1000,
  model = "claude-haiku-4-5",
): void {
  db.prepare(
    `INSERT INTO usage_turns (user_id, session_id, ts, model, input_tokens, output_tokens, cost_usd)
     VALUES (?, 's', ?, ?, ?, 0, ?)`,
  ).run(userId, ts, model, tokens, costUsd);
}

describe("spendDaily", () => {
  it("agrupa por día (BA, UTC-3) y usuario, ascendente", () => {
    const db = freshDb();
    const a = addUser(db, "demo", { name: "demo" });
    const b = addUser(db, "lula", { name: "lula" });
    turn(db, a.id, "2026-05-28 15:00:00", 1);
    turn(db, a.id, "2026-05-28 18:00:00", 2);
    turn(db, b.id, "2026-05-29 10:00:00", 3);
    // 2026-05-29 02:00 UTC → 2026-05-28 23:00 BA (cruza el día hacia atrás).
    turn(db, a.id, "2026-05-29 02:00:00", 4);
    const rows = spendDaily(db);
    expect(rows.map((r) => `${r.day}/${r.handle}`)).toEqual([
      "2026-05-28/demo", // 1 + 2 + 4 (el de 02:00 UTC cae acá en BA)
      "2026-05-29/lula",
    ]);
    expect(rows[0]?.cost_usd).toBeCloseTo(7);
    expect(rows[0]?.turns).toBe(3);
    db.close();
  });

  it("filtra por usuario y recorta a los últimos N días", () => {
    const db = freshDb();
    const a = addUser(db, "demo", { name: "demo" });
    turn(db, a.id, "2026-05-25 15:00:00", 1);
    turn(db, a.id, "2026-05-27 15:00:00", 1);
    turn(db, a.id, "2026-05-29 15:00:00", 1);
    const last2 = spendDaily(db, { userId: a.id, days: 2 });
    expect(last2.map((r) => r.day)).toEqual(["2026-05-27", "2026-05-29"]);
    db.close();
  });

  it("vacío si no hay turnos", () => {
    const db = freshDb();
    addUser(db, "demo", { name: "demo" });
    expect(spendDaily(db)).toEqual([]);
    db.close();
  });
});

describe("modelUsageReport", () => {
  it("agrupa consumo por modelo y ordena por costo desc", () => {
    const db = freshDb();
    const a = addUser(db, "demo", { name: "demo" });
    const b = addUser(db, "lula", { name: "lula" });
    turn(db, a.id, "2026-05-28 15:00:00", 1, 100, "gemma4-31b");
    turn(db, b.id, "2026-05-28 15:00:00", 4, 200, "claude-sonnet-4-6");
    turn(db, a.id, "2026-05-28 16:00:00", 2, 300, "gemma4-31b");

    const rows = modelUsageReport(db);

    expect(rows.map((r) => r.model)).toEqual(["claude-sonnet-4-6", "gemma4-31b"]);
    expect(rows[1]).toMatchObject({ users: 1, turns: 2, input_tokens: 400, cost_usd: 3 });
    db.close();
  });

  it("filtra por usuario", () => {
    const db = freshDb();
    const a = addUser(db, "demo", { name: "demo" });
    const b = addUser(db, "lula", { name: "lula" });
    turn(db, a.id, "2026-05-28 15:00:00", 1, 100, "gemma4-31b");
    turn(db, b.id, "2026-05-28 15:00:00", 4, 200, "claude-sonnet-4-6");

    expect(modelUsageReport(db, { userId: a.id }).map((r) => r.model)).toEqual(["gemma4-31b"]);
    db.close();
  });
});
