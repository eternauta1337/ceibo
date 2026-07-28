import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addUser, listCronsForUser, openDb, signScheduleToken } from "@ceibo/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// schedule.ts abre su propia DB vía defaultDbPath() (lazy) y verifica el Bearer con
// SCHEDULE_MCP_HMAC_KEY (C1: clave HMAC desacoplada del path-secret). Para testear hermético:
// un archivo temp COMPARTIDO (no `:memory:`, que no se comparte entre conexiones — el módulo
// abre la suya y necesita ver los users que sembramos acá) + key de test, fijados antes del
// primer callTool.
const KEY = "test-schedule-secret";
const DB = join(tmpdir(), "ceibo-schedule-test.db");
// El token de schedule lleva el canal de origen (feature crons-delivery); default telegram.
const token = (userId: number, channel = "telegram") => signScheduleToken(userId, channel, KEY);

let uid: number; // usuario principal de los tests
let other: number; // segundo usuario (ownership)
let dbRef: ReturnType<typeof openDb>; // para inspeccionar el canal persistido

beforeAll(() => {
  rmSync(DB, { force: true });
  process.env.CEIBO_DB_PATH = DB;
  process.env.SCHEDULE_MCP_HMAC_KEY = KEY;
  dbRef = openDb(DB);
  uid = addUser(dbRef, "sched-a").id;
  other = addUser(dbRef, "sched-b").id;
});
afterAll(() => {
  delete process.env.CEIBO_DB_PATH;
  delete process.env.SCHEDULE_MCP_HMAC_KEY;
  rmSync(DB, { force: true });
});

const { schedule } = await import("./schedule.ts");

describe("schedule.callTool — auth", () => {
  it("token inválido → tira", async () => {
    await expect(schedule.callTool("garbage", "schedule_list", {})).rejects.toThrow(/inválido/);
  });
});

describe("schedule.callTool — create", () => {
  it("one-shot `when` futuro: crea un cron once", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const out = (await schedule.callTool(token(uid), "schedule_create", {
      what: "recordar dentista",
      when: future,
    })) as { id: number; kind: string };
    expect(out.kind).toBe("once");
    expect(out.id).toBeGreaterThan(0);
  });

  it("recurrente `recur` válido: crea un cron recur con tz", async () => {
    const out = (await schedule.callTool(token(uid), "schedule_create", {
      what: "resumen diario",
      recur: "0 9 * * *",
    })) as { kind: string; recur: string };
    expect(out.kind).toBe("recur");
    expect(out.recur).toBe("0 9 * * *");
  });

  it("sin `what` → tira", async () => {
    await expect(schedule.callTool(token(uid), "schedule_create", { when: "x" })).rejects.toThrow(/what/);
  });

  it("when y recur juntos (o ninguno) → tira", async () => {
    await expect(
      schedule.callTool(token(uid), "schedule_create", { what: "x", when: "a", recur: "b" }),
    ).rejects.toThrow(/EXACTAMENTE uno/);
    await expect(schedule.callTool(token(uid), "schedule_create", { what: "x" })).rejects.toThrow(
      /EXACTAMENTE uno/,
    );
  });

  it("`when` en el pasado → tira", async () => {
    await expect(
      schedule.callTool(token(uid), "schedule_create", { what: "x", when: "2020-01-01T00:00:00Z" }),
    ).rejects.toThrow(/ya pasó/);
  });

  it("`recur` inválido → tira", async () => {
    await expect(
      schedule.callTool(token(uid), "schedule_create", { what: "x", recur: "no-cron" }),
    ).rejects.toThrow(/cron-expr válido/);
  });

  it("usa el canal de ORIGEN del token (feature crons-delivery), no telegram hardcodeado", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const out = (await schedule.callTool(token(uid, "web"), "schedule_create", {
      what: "recordatorio web",
      when: future,
    })) as { id: number };
    const row = listCronsForUser(dbRef, uid).find((c) => c.id === out.id);
    expect(row?.channel).toBe("web");
  });

  it("token VIEJO de 3 partes (sin canal) → cae al fallback telegram", async () => {
    // Un token de 3 partes firmado a mano como el alias viejo (HMAC sobre `cap.<uid>.<exp>`).
    const exp = Date.now() + 60 * 60 * 1000;
    const body = `${uid}.${exp}`;
    const mac = createHmac("sha256", KEY).update(`cap.${body}`).digest("base64url");
    const legacy = `${body}.${mac}`;
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const out = (await schedule.callTool(legacy, "schedule_create", {
      what: "recordatorio legacy",
      when: future,
    })) as { id: number };
    const row = listCronsForUser(dbRef, uid).find((c) => c.id === out.id);
    expect(row?.channel).toBe("telegram");
  });
});

describe("schedule.callTool — list/cancel", () => {
  it("list devuelve los crons del usuario; cancel borra por id", async () => {
    const created = (await schedule.callTool(token(other), "schedule_create", {
      what: "tarea",
      recur: "0 8 * * *",
    })) as { id: number };
    const listed = (await schedule.callTool(token(other), "schedule_list", {})) as {
      crons: { id: number }[];
    };
    expect(listed.crons.some((c) => c.id === created.id)).toBe(true);

    const cancelled = (await schedule.callTool(token(other), "schedule_cancel", {
      id: created.id,
    })) as { cancelled?: number };
    expect(cancelled.cancelled).toBe(created.id);
  });

  it("cancel de un id inexistente → error (no cancelled)", async () => {
    const out = (await schedule.callTool(token(other), "schedule_cancel", { id: 999999 })) as {
      error?: string;
    };
    expect(out.error).toBeTruthy();
  });
});
