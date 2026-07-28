import { describe, expect, it } from "vitest";
import { addUser, hasUserPassword, openDb, setUserPassword, verifyUserPassword } from "./index.ts";

const db = () => openDb(":memory:");

describe("web passwords (email + password login)", () => {
  it("set + verify round-trip", () => {
    const d = db();
    const u = addUser(d, "demo");
    expect(hasUserPassword(d, u.id)).toBe(false);
    setUserPassword(d, u.id, "correcto-caballo-batería");
    expect(hasUserPassword(d, u.id)).toBe(true);
    expect(verifyUserPassword(d, u.id, "correcto-caballo-batería")).toBe(true);
  });

  it("contraseña incorrecta → false", () => {
    const d = db();
    const u = addUser(d, "demo");
    setUserPassword(d, u.id, "la-buena");
    expect(verifyUserPassword(d, u.id, "la-mala")).toBe(false);
    expect(verifyUserPassword(d, u.id, "")).toBe(false);
  });

  it("usuario sin password seteada → false (no throw)", () => {
    const d = db();
    const u = addUser(d, "demo");
    expect(verifyUserPassword(d, u.id, "lo-que-sea")).toBe(false);
  });

  it("re-set reemplaza el hash (la vieja deja de validar)", () => {
    const d = db();
    const u = addUser(d, "demo");
    setUserPassword(d, u.id, "vieja");
    setUserPassword(d, u.id, "nueva");
    expect(verifyUserPassword(d, u.id, "vieja")).toBe(false);
    expect(verifyUserPassword(d, u.id, "nueva")).toBe(true);
  });

  it("hashes distintos para la misma password (salt aleatorio)", () => {
    const d = db();
    const a = addUser(d, "a");
    const b = addUser(d, "b");
    setUserPassword(d, a.id, "misma");
    setUserPassword(d, b.id, "misma");
    const ha = d.prepare("SELECT hash FROM web_passwords WHERE user_id = ?").get(a.id) as { hash: string };
    const hb = d.prepare("SELECT hash FROM web_passwords WHERE user_id = ?").get(b.id) as { hash: string };
    expect(ha.hash).not.toBe(hb.hash);
    expect(verifyUserPassword(d, a.id, "misma")).toBe(true);
    expect(verifyUserPassword(d, b.id, "misma")).toBe(true);
  });

  it("password vacía al setear → throw", () => {
    const d = db();
    const u = addUser(d, "demo");
    expect(() => setUserPassword(d, u.id, "")).toThrow();
  });
});
