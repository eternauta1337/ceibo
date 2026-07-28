import { describe, expect, it } from "vitest";
import { addChannel, addUser, listChannels, openDb, removeChannel, resolveUser } from "./index.ts";

const freshDb = () => openDb(":memory:");

describe("removeChannel", () => {
  it("borra el canal por (channel, external_id) y devuelve la fila borrada", () => {
    const db = freshDb();
    const u = addUser(db, "lula", { name: "lula" });
    addChannel(db, u.id, "cli", "lula");
    addChannel(db, u.id, "telegram", "8253551455");

    const removed = removeChannel(db, u.id, "cli", "lula");
    expect(removed.map((c) => `${c.channel}:${c.external_id}`)).toEqual(["cli:lula"]);

    const left = listChannels(db, u.id).map((c) => `${c.channel}:${c.external_id}`);
    expect(left).toEqual(["telegram:8253551455"]);
    expect(resolveUser(db, "cli", "lula")).toBeUndefined();
    expect(resolveUser(db, "telegram", "8253551455")?.handle).toBe("lula");
  });

  it("sin external_id borra todos los canales de ese tipo del usuario", () => {
    const db = freshDb();
    const u = addUser(db, "demo", { name: "demo" });
    addChannel(db, u.id, "telegram", "111");
    addChannel(db, u.id, "telegram", "222");
    addChannel(db, u.id, "cli", "demo");

    const removed = removeChannel(db, u.id, "telegram");
    expect(removed.map((c) => c.external_id).sort()).toEqual(["111", "222"]);
    expect(listChannels(db, u.id).map((c) => c.channel)).toEqual(["cli"]);
  });

  it("no toca canales de otros usuarios y devuelve vacío si no hay match", () => {
    const db = freshDb();
    const a = addUser(db, "demo", { name: "demo" });
    const b = addUser(db, "lula", { name: "lula" });
    addChannel(db, a.id, "cli", "demo");
    addChannel(db, b.id, "cli", "lula");

    expect(removeChannel(db, a.id, "telegram")).toEqual([]);
    // borra solo el de demo, el de lula queda
    removeChannel(db, a.id, "cli");
    expect(resolveUser(db, "cli", "demo")).toBeUndefined();
    expect(resolveUser(db, "cli", "lula")?.handle).toBe("lula");
  });
});
