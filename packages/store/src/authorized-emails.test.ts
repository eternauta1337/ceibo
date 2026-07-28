import { describe, expect, it } from "vitest";
import {
  addAuthorizedEmail,
  addUser,
  getAuthorizedEmail,
  getUserBackendMode,
  getUserByHandle,
  listAuthorizedEmails,
  listChannels,
  openDb,
  registerGoogleUserIfAuthorized,
  removeAuthorizedEmail,
  resolveUser,
  setUserStatus,
} from "./index.ts";

const db = () => openDb(":memory:");

describe("allowlist CRUD", () => {
  it("add + get; el email se normaliza a lowercase", () => {
    const d = db();
    const e = addAuthorizedEmail(d, "  Foo@Example.COM  ", { name: "Foo", note: "vecino" });
    expect(e.email).toBe("foo@example.com");
    expect(e.name).toBe("Foo");
    expect(e.note).toBe("vecino");
    expect(e.used_at).toBeNull();
    expect(getAuthorizedEmail(d, "FOO@example.com")?.email).toBe("foo@example.com");
  });

  it("re-add pisa name/handle/note (última intención del admin)", () => {
    const d = db();
    addAuthorizedEmail(d, "a@x.com", { name: "Vieja", handle: "vieja" });
    const e = addAuthorizedEmail(d, "a@x.com", { name: "Nueva" });
    expect(e.name).toBe("Nueva");
    expect(e.handle).toBeNull();
    expect(listAuthorizedEmails(d)).toHaveLength(1); // no duplica
  });

  it("list ordena y remove devuelve si había fila", () => {
    const d = db();
    addAuthorizedEmail(d, "b@x.com");
    addAuthorizedEmail(d, "c@x.com");
    expect(listAuthorizedEmails(d).map((e) => e.email)).toEqual(["b@x.com", "c@x.com"]);
    expect(removeAuthorizedEmail(d, "B@x.com")).toBe(true); // case-insensitive
    expect(removeAuthorizedEmail(d, "nope@x.com")).toBe(false);
    expect(listAuthorizedEmails(d).map((e) => e.email)).toEqual(["c@x.com"]);
  });
});

describe("registerGoogleUserIfAuthorized — gate de signup", () => {
  it("NO autorizado → undefined, no crea ningún usuario", () => {
    const d = db();
    expect(registerGoogleUserIfAuthorized(d, "intruso@x.com")).toBeUndefined();
    expect(getUserByHandle(d, "intruso")).toBeUndefined();
  });

  it("autorizado sin cuenta → crea user local + identidad google + marca used_at", () => {
    const d = db();
    addAuthorizedEmail(d, "maria@gmail.com");
    const reg = registerGoogleUserIfAuthorized(d, "maria@gmail.com");
    expect(reg?.created).toBe(true);
    const user = reg?.user;
    if (!user) throw new Error("sin user");
    expect(user.status).toBe("active");
    expect(getUserBackendMode(d, user.id)).toBe("local"); // "vamos todos a archima"
    expect(user.handle).toBe("maria"); // derivado del local-part
    expect(user.name).toBe("Maria"); // derivado (capitalizado)
    const chs = listChannels(d, user.id);
    expect(chs.some((c) => c.channel === "google" && c.external_id === "maria@gmail.com")).toBe(true);
    expect(getAuthorizedEmail(d, "maria@gmail.com")?.used_at).not.toBeNull();
    // y queda resoluble por la identidad google
    expect(resolveUser(d, "google", "maria@gmail.com")?.id).toBe(user.id);
  });

  it("usa name/handle del entry cuando el admin los cargó", () => {
    const d = db();
    addAuthorizedEmail(d, "j@x.com", { name: "Juana", handle: "juani" });
    const reg = registerGoogleUserIfAuthorized(d, "j@x.com");
    expect(reg?.user.handle).toBe("juani");
    expect(reg?.user.name).toBe("Juana");
  });

  it("idempotente: segunda llamada del mismo email → created:false y NO duplica", () => {
    const d = db();
    addAuthorizedEmail(d, "k@x.com");
    const first = registerGoogleUserIfAuthorized(d, "k@x.com");
    const second = registerGoogleUserIfAuthorized(d, "K@X.com"); // distinto casing
    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(second?.user.id).toBe(first?.user.id);
    expect(listChannels(d, first?.user.id ?? -1).filter((c) => c.channel === "google")).toHaveLength(1);
  });

  it("colisión de handle → desambigua con sufijo", () => {
    const d = db();
    addUser(d, "pedro", { name: "Pedro existente" }); // ocupa el handle base
    addAuthorizedEmail(d, "pedro@x.com");
    const reg = registerGoogleUserIfAuthorized(d, "pedro@x.com");
    expect(reg?.user.handle).toBe("pedro-2");
  });

  it("local-part no-slug → handle válido derivado, nunca inválido", () => {
    const d = db();
    addAuthorizedEmail(d, "a.b+tag@x.com");
    const reg = registerGoogleUserIfAuthorized(d, "a.b+tag@x.com");
    // slugify("a.b+tag") → "a-b-tag"; nombre = primer segmento capitalizado
    expect(reg?.user.handle).toBe("a-b-tag");
    expect(reg?.user.name).toBe("A");
  });

  it("remover de la allowlist NO toca la cuenta ya creada", () => {
    const d = db();
    addAuthorizedEmail(d, "z@x.com");
    const reg = registerGoogleUserIfAuthorized(d, "z@x.com");
    expect(removeAuthorizedEmail(d, "z@x.com")).toBe(true);
    // el usuario sigue existiendo y resoluble (el login posterior entra por identidad, sin re-chequear allowlist)
    expect(resolveUser(d, "google", "z@x.com")?.id).toBe(reg?.user.id);
  });

  it("usuario deshabilitado + email autorizado → re-activa la cuenta, devuelve mismo user, sin crash", () => {
    const d = db();
    addAuthorizedEmail(d, "w@x.com");
    const reg = registerGoogleUserIfAuthorized(d, "w@x.com");
    if (!reg) throw new Error("sin reg");
    setUserStatus(d, reg.user.id, "disabled");
    // Re-login: detecta la identidad existente, re-activa y devuelve la misma cuenta.
    const relogin = registerGoogleUserIfAuthorized(d, "w@x.com");
    expect(relogin).toBeDefined();
    expect(relogin?.user.id).toBe(reg.user.id); // MISMO usuario, no duplicado
    expect(relogin?.user.status).toBe("active"); // re-activado
    expect(relogin?.created).toBe(false);
    // La identidad google sigue siendo una sola fila (sin duplicados).
    expect(listChannels(d, reg.user.id).filter((c) => c.channel === "google")).toHaveLength(1);
  });

  it("usuario deshabilitado + email NO autorizado → undefined, sigue disabled, sin crash UNIQUE", () => {
    const d = db();
    addAuthorizedEmail(d, "ex@x.com");
    const reg = registerGoogleUserIfAuthorized(d, "ex@x.com");
    if (!reg) throw new Error("sin reg");
    setUserStatus(d, reg.user.id, "disabled");
    // Remover de la allowlist: ya no está autorizado.
    removeAuthorizedEmail(d, "ex@x.com");
    // Re-login de un usuario disabled y no autorizado → undefined limpio, sin UNIQUE crash.
    const relogin = registerGoogleUserIfAuthorized(d, "ex@x.com");
    expect(relogin).toBeUndefined();
    // Sigue disabled; no se creó un duplicado.
    expect(getUserByHandle(d, reg.user.handle)?.status).toBe("disabled");
    expect(listChannels(d, reg.user.id).filter((c) => c.channel === "google")).toHaveLength(1);
  });
});
