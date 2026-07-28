import { describe, expect, it } from "vitest";
import {
  addInboxItem,
  addUser,
  countUnread,
  listInbox,
  markAllInboxRead,
  markInboxRead,
  openDb,
} from "./index.ts";

// Inbox del agente (feature crons-delivery): bandeja durable que alimenta el FAB 🔔 de la web.
const setup = () => {
  const d = openDb(":memory:");
  const a = addUser(d, "inbox-a").id;
  const b = addUser(d, "inbox-b").id;
  return { d, a, b };
};

describe("inbox — CRUD", () => {
  it("addInboxItem persiste y devuelve la fila con id/created_at/read_at NULL", () => {
    const { d, a } = setup();
    const row = addInboxItem(d, {
      userId: a,
      kind: "cron",
      sourceId: 42,
      title: "Dentista",
      body: "te toca",
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.user_id).toBe(a);
    expect(row.kind).toBe("cron");
    expect(row.source_id).toBe(42);
    expect(row.title).toBe("Dentista");
    expect(row.body).toBe("te toca");
    expect(row.read_at).toBeNull();
    expect(row.created_at).toBeTruthy();
  });

  it("sourceId opcional → NULL", () => {
    const { d, a } = setup();
    const row = addInboxItem(d, { userId: a, kind: "system", title: "Aviso", body: "x" });
    expect(row.source_id).toBeNull();
  });

  it("listInbox: más nuevos primero, acotado por usuario", () => {
    const { d, a, b } = setup();
    addInboxItem(d, { userId: a, kind: "cron", title: "1", body: "uno" });
    addInboxItem(d, { userId: a, kind: "cron", title: "2", body: "dos" });
    addInboxItem(d, { userId: b, kind: "cron", title: "otro", body: "de b" });
    const list = listInbox(d, a);
    expect(list.map((r) => r.title)).toEqual(["2", "1"]); // DESC por id
    expect(list.every((r) => r.user_id === a)).toBe(true);
  });

  it("listInbox respeta el limit", () => {
    const { d, a } = setup();
    for (let i = 0; i < 5; i++) addInboxItem(d, { userId: a, kind: "cron", title: `t${i}`, body: "x" });
    expect(listInbox(d, a, { limit: 2 })).toHaveLength(2);
  });
});

describe("inbox — unread / read", () => {
  it("countUnread cuenta sólo los no leídos del usuario", () => {
    const { d, a, b } = setup();
    addInboxItem(d, { userId: a, kind: "cron", title: "1", body: "x" });
    addInboxItem(d, { userId: a, kind: "cron", title: "2", body: "x" });
    addInboxItem(d, { userId: b, kind: "cron", title: "3", body: "x" });
    expect(countUnread(d, a)).toBe(2);
    expect(countUnread(d, b)).toBe(1);
  });

  it("markInboxRead baja el unread; idempotente (no re-cuenta)", () => {
    const { d, a } = setup();
    const r = addInboxItem(d, { userId: a, kind: "cron", title: "1", body: "x" });
    expect(markInboxRead(d, a, r.id)).toBe(true);
    expect(countUnread(d, a)).toBe(0);
    // Ya estaba leído → no-op (devuelve false).
    expect(markInboxRead(d, a, r.id)).toBe(false);
  });

  it("markInboxRead acotado al dueño: no marca el de otro usuario", () => {
    const { d, a, b } = setup();
    const r = addInboxItem(d, { userId: a, kind: "cron", title: "1", body: "x" });
    expect(markInboxRead(d, b, r.id)).toBe(false);
    expect(countUnread(d, a)).toBe(1);
  });

  it("markAllInboxRead marca todos los no leídos del usuario y devuelve cuántos", () => {
    const { d, a, b } = setup();
    addInboxItem(d, { userId: a, kind: "cron", title: "1", body: "x" });
    addInboxItem(d, { userId: a, kind: "cron", title: "2", body: "x" });
    addInboxItem(d, { userId: b, kind: "cron", title: "3", body: "x" });
    expect(markAllInboxRead(d, a)).toBe(2);
    expect(countUnread(d, a)).toBe(0);
    expect(countUnread(d, b)).toBe(1); // no tocó al otro
  });
});
