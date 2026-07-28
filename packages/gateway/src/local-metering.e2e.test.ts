// Regresión item G — metering del turno LOCAL (archima/opencode).
// Causa raíz: `recordTurn` (store) espera el usage ACUMULADO de la sesión y guarda el delta
// contra su snapshot (igual que MA, que reporta acumulado). El `RelayTranslator` (backend-local)
// reseteaba el usage entre turnos y emitía PER-TURNO → el 2º turno daba delta = max(0, perTurno -
// snapshot) = 0 → NO se grababa fila en usage_turns. El fix: el translator acumula a lo largo de la
// sesión. Este test cablea el translator REAL → un Sink cuyo turnComplete llama al recordTurn REAL
// sobre un store `:memory:`, y verifica que DOS turnos locales producen DOS filas con su delta.
import type { Sink } from "@ceibo/agent";
import { type OpencodeEvent, RelayTranslator } from "@ceibo/backend-local";
import { addUser, type Db, openDb, recordTurn } from "@ceibo/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let db: Db;
let userId: number;
const SESSION = "vm-local-1";

beforeEach(() => {
  db = openDb(":memory:");
  userId = addUser(db, "tester").id;
});
afterEach(() => db.close());

/** Sink mínimo: el turnComplete contabiliza igual que el gateway (recordTurn con el sessionId). */
function meteringSink(): Sink {
  return {
    message: () => {},
    turnComplete: (usage, model) => {
      recordTurn(db, userId, SESSION, model, usage);
    },
  };
}

const ev = (type: string, properties?: OpencodeEvent["properties"]): OpencodeEvent => ({ type, properties });
const stepFinish = (mid: string, input: number, output: number, cacheRead = 0) =>
  ev("message.part.updated", {
    part: { type: "step-finish", messageID: mid, tokens: { input, output, cache: { read: cacheRead } } },
  });
const role = (id: string) =>
  ev("message.updated", {
    info: { id, role: "assistant", model: { providerID: "local", modelID: "gemma4-31b" } },
  });

function rows(): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM usage_turns ORDER BY id").all() as Array<Record<string, unknown>>;
}

describe("metering local — RelayTranslator → recordTurn → usage_turns", () => {
  it("dos turnos locales consecutivos graban DOS filas con su delta (no se pierde el 2º)", () => {
    const tr = new RelayTranslator(meteringSink());

    // Turno 1: 100 in / 10 out / 20 cacheRead.
    for (const e of [role("m1"), stepFinish("m1", 100, 10, 20), ev("session.idle")]) tr.handle(e);
    // Turno 2: +5 in / +5 out / +3 cacheRead (acumulado 105 / 15 / 23).
    for (const e of [role("m2"), stepFinish("m2", 5, 5, 3), ev("session.idle")]) tr.handle(e);

    const r = rows();
    expect(r).toHaveLength(2); // <- antes del fix: 1 (el 2º turno daba delta 0)
    expect(r[0]).toMatchObject({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 20 });
    // El 2º turno es el DELTA del acumulado contra el snapshot del 1º, no el acumulado entero.
    expect(r[1]).toMatchObject({ input_tokens: 5, output_tokens: 5, cache_read_tokens: 3 });
    expect(r[1]?.model).toBe("gemma4-31b");
  });

  it("un único turno local con usage no-cero graba su fila", () => {
    const tr = new RelayTranslator(meteringSink());
    for (const e of [role("m1"), stepFinish("m1", 7492, 21, 100), ev("session.idle")]) tr.handle(e);
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ input_tokens: 7492, output_tokens: 21, cache_read_tokens: 100 });
  });
});
